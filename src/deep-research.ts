/**
 * Deep research workflow.
 * Built-in workflow for comprehensive research across multiple sources.
 *
 * Read-only + web-only design: every agent runs against the repo read-only
 * tools plus the web_search/web_fetch tools — no agent receives the `write`
 * tool. Each agent returns a compact, schema-bounded structured result; the
 * workflow's final return carries only the bounded supported claims and a
 * bounded candidate summary (the validated question stays with the host). The
 * host re-fetches each retained citation, then renders the full cited Markdown
 * report from verified bounded claims into a fresh private tmpdir directory (never a workspace
 * path, never a model-controlled path).
 */

import { closeSync, constants as fsConstants, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWebCitation } from "./web-tools.js";

export interface DeepResearchConfig {
  /** Number of distinct search angles/queries to explore. */
  angles: number;
  /** Minimum distinct sources required for a claim to survive cross-checking. */
  minSupport: number;
}

/**
 * A single supported claim returned by the Verify agent. Both fields are
 * schema-bounded so the worst-case serialized payload stays well under 10KB.
 */
export interface SupportedClaim {
  /** The factual claim, ≤140 chars (MAX_RESEARCH_CLAIM_CHARS). */
  claim: string;
  /** Cited source URLs for this claim, at most 2, each ≤200 chars (MAX_RESEARCH_URL_CHARS). */
  sources: string[];
}

// ─── Conservative UTF-8 byte bounds ───────────────────────────────────────────
//
// Every limit below is chosen so that the worst-case UTF-8 byte size of every
// raw structured result, the aggregate Verify prompt, the Report prompt, and
// the final workflow result stays strictly under 10,000 bytes EVEN IF every
// bounded character is a four-byte Unicode code point (e.g. U+1F600 😀). The
// host delivery API (deliverDeepResearchResult) re-clamps with the same
// constants, so a model-controlled string can never exceed the byte budget
// through the result channel either.
//
// Worst-case measured UTF-8 byte sizes (all-bounded-chars-are-4-byte emoji):
//   raw Queries result ............ 1945 bytes
//   raw Gather result ............. 3909 bytes
//   aggregate Verify prompt ....... 8475 bytes
//   raw Verify result ............. 6588 bytes
//   Report prompt ................. 7996 bytes
//   final workflow result ......... 7091 bytes

/**
 * Maximum number of characters a research question may be. The slash handler
 * rejects questions longer than this before invoking the workflow; the workflow
 * script re-clamps defensively in case it is launched directly. 300 keeps the
 * worst-case Queries/Report prompts well under 10KB even with 4-byte chars.
 */
export const MAX_RESEARCH_QUESTION_CHARS = 300;

/** Clamp angles to the deterministic cap of 4 (host + workflow both enforce). */
export const MAX_RESEARCH_ANGLES = 4;

/**
 * At most this many distinct source URLs feed Verify (aggregate Gather bound).
 * 4 angles × 2 sources each = 8 candidates; this cap keeps only 4 before Verify.
 */
export const MAX_GATHER_SOURCES = 4;
/** At most this many claims per source feed Verify (aggregate Gather bound). */
export const MAX_CLAIMS_PER_SOURCE = 2;

/** Maximum length (chars) of a single search query produced by the Queries phase. */
export const MAX_RESEARCH_QUERY_CHARS = 120;

/** Maximum length (chars) of a cited source URL everywhere it is bounded. */
export const MAX_RESEARCH_URL_CHARS = 200;

/** Maximum length (chars) of a single factual claim everywhere it is bounded. */
export const MAX_RESEARCH_CLAIM_CHARS = 140;

/** Maximum number of supported claims the Verify phase may return / carry to Report. */
export const MAX_SUPPORTED_CLAIMS = 3;

/** Maximum length (chars) of the candidate and host-derived acknowledgement summaries. */
export const MAX_RESEARCH_SUMMARY_CHARS = 120;

/**
 * Compact, schema-bounded final result returned by the workflow. The host
 * renders the cited Markdown report from `supported`; the workflow never
 * returns a model-written report body. The validated question is NOT carried
 * here — the host already has it (the slash handler validated it before
 * launching the workflow), so it is threaded into delivery separately to keep
 * model-controlled strings out of the result channel.
 */
export interface DeepResearchResult {
  ok: boolean;
  /** Bounded supported claims, at most MAX_SUPPORTED_CLAIMS (host re-clamps defensively). */
  supported: SupportedClaim[];
  /** Bounded candidate answer; host delivery derives its acknowledgement from retained claims. */
  summary: string;
}

/**
 * Generate a deep-research workflow that uses read-only repo tools plus the
 * web_search/web_fetch tools.
 *
 * The script is static and reads its inputs from `args`
 * (question/angles/minSupport), so the question is never string-interpolated
 * into source — no escaping hazards. The host injects the tool pool at run
 * time via the run-level `tools` option (read-only repo tools + web tools —
 * no `write`); each agent narrows that pool with a per-call `tools` allowlist:
 *   - Queries:  []                         (no tools — pure planning)
 *   - Gather:   ['web_search','web_fetch'] (search + fetch only)
 *   - Verify:   []                         (no tools — pure cross-check)
 *   - Report:   []                         (no tools — pure one-line synthesis)
 */
export function generateDeepResearchWorkflow(): string {
  return `export const meta = {
  name: 'deep_research',
  description: 'Deep research with real web search and cross-checked claims',
  phases: [
    { title: 'Queries' },
    { title: 'Gather' },
    { title: 'Verify' },
    { title: 'Report' },
  ],
}

// Defensive clamps: the slash handler already validated the question against
// MAX_RESEARCH_QUESTION_CHARS (300) and angles against 4, but a direct
// workflow invocation must not trust its inputs blindly. Every bound below is
// a named conservative UTF-8 byte budget: even if every bounded character is
// a 4-byte Unicode code point, every prompt and result stays <10,000 bytes.
const rawQuestion = (args && args.question) || ''
const question = typeof rawQuestion === 'string' ? rawQuestion.slice(0, ${MAX_RESEARCH_QUESTION_CHARS}) : ''
const rawAngles = Number((args && args.angles) || ${MAX_RESEARCH_ANGLES})
const angles = Math.max(1, Math.min(Number.isFinite(rawAngles) ? Math.floor(rawAngles) : ${MAX_RESEARCH_ANGLES}, ${MAX_RESEARCH_ANGLES}))
const rawMinSupport = Number((args && args.minSupport) || 2)
const minSupport = Math.max(1, Math.min(Number.isFinite(rawMinSupport) ? Math.floor(rawMinSupport) : 2, ${MAX_GATHER_SOURCES}))

phase('Queries')
const plan = await agent(
  'You are planning web research for this question:\\n' + question +
  '\\n\\nProduce ' + angles + ' diverse, specific search queries that together cover the question from different angles.',
  {
    label: 'plan queries',
    tools: [],
    harness_config: 'none',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { queries: { type: 'array', maxItems: ${MAX_RESEARCH_ANGLES}, items: { type: 'string', maxLength: ${MAX_RESEARCH_QUERY_CHARS} } } },
      required: ['queries'],
    },
  }
)
const queries = (plan.queries || []).slice(0, angles)

phase('Gather')
const gathered = await parallel(queries.map((q, i) => () =>
  agent(
    'Research this query using ONLY the web_search and web_fetch tools.\\nQuery: ' + q +
    '\\n\\nSteps: (1) call web_search with the query; (2) web_fetch at most the 2 most relevant result URLs ' +
    '(do NOT fetch more than 2 URLs); (3) extract concrete, verifiable factual claims, each tagged with the ' +
    'exact source URL it came from. Prefer primary sources (official docs, source code, specs, first-party APIs) ' +
    'over secondary write-ups; when a primary source exists, discard a claim supported only by a secondary ' +
    'blog/forum post; every surviving claim must trace to an owning primary source URL. ' +
    'Do NOT invent sources or claims — report only what the fetched pages actually say. ' +
    'Return at most 2 sources, each with at most 2 claims.',
    {
      label: 'research ' + (i + 1),
      tools: ['web_search', 'web_fetch'],
      harness_config: 'none',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sources: {
            type: 'array',
            maxItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', maxLength: ${MAX_RESEARCH_URL_CHARS} },
                claims: { type: 'array', maxItems: ${MAX_CLAIMS_PER_SOURCE}, items: { type: 'string', maxLength: ${MAX_RESEARCH_CLAIM_CHARS} } },
              },
              required: ['url', 'claims'],
            },
          },
        },
        required: ['sources'],
      },
    }
  )
))
// Aggregate Gather evidence before Verify is bounded to at most ${MAX_GATHER_SOURCES} sources
// and at most ${MAX_CLAIMS_PER_SOURCE} claims per source (URL/claim string bounds preserved),
// so the entire Verify prompt stays under 10KB including instructions even when every bounded
// character is a 4-byte Unicode code point. First source wins on URL collisions (dedupe by URL);
// extra sources/claims are discarded and never reach Verify.
const seenSourceUrls = new Set()
const allSources = []
for (const g of gathered) {
  if (!g || !Array.isArray(g.sources)) continue
  for (const src of g.sources) {
    if (!src || typeof src.url !== 'string' || !src.url || src.url.length > ${MAX_RESEARCH_URL_CHARS}) continue
    const url = src.url
    const claims = Array.isArray(src.claims) ? src.claims.filter((c) => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim().slice(0, ${MAX_RESEARCH_CLAIM_CHARS})).slice(0, ${MAX_CLAIMS_PER_SOURCE}) : []
    // Empty pages are not evidence and must not consume a bounded source slot.
    if (!claims.length || seenSourceUrls.has(url)) continue
    if (allSources.length >= ${MAX_GATHER_SOURCES}) break
    seenSourceUrls.add(url)
    allSources.push({ id: 'source-' + (allSources.length + 1), url, claims })
  }
  if (allSources.length >= ${MAX_GATHER_SOURCES}) break
}

phase('Verify')
const verdict = await agent(
  'Cross-check these research sources. Group claims that assert the same fact across different source URLs. ' +
  'Keep a claim only if it is supported by at least ' + minSupport + ' distinct source URLs OR by one clearly authoritative primary source. ' +
  'Discard claims found in a single weak source or that conflict with others. Prefer primary sources (official docs, source code, ' +
  'specs, first-party APIs) over secondary write-ups; when a primary source exists, discard a claim supported only by a secondary ' +
  'blog or forum post; every surviving claim must trace to an owning primary source URL. ' +
  'Return each supported claim with sourceIds copied from the provided SOURCES JSON; never return or invent citation URLs directly. Omit discarded strings.\\n\\nSOURCES JSON:\\n' + JSON.stringify(allSources),
  {
    label: 'cross-check',
    tools: [],
    harness_config: 'none',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supported: {
          type: 'array',
          maxItems: ${MAX_SUPPORTED_CLAIMS},
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              claim: { type: 'string', maxLength: ${MAX_RESEARCH_CLAIM_CHARS} },
              sourceIds: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 16 } },
            },
            required: ['claim', 'sourceIds'],
          },
        },
      },
      required: ['supported'],
    },
  }
)
// Resolve verifier-selected opaque source ids back to the exact Gather URLs.
// The verifier never controls or rewrites citation URLs, so harmless URL
// canonicalization differences cannot drop evidence and invented ids fail closed.
const sourceById = new Map(allSources.map((source) => [source.id, source.url]))
const supported = []
for (const entry of Array.isArray(verdict && verdict.supported) ? verdict.supported : []) {
  if (supported.length >= ${MAX_SUPPORTED_CLAIMS}) break
  if (!entry || typeof entry !== 'object') continue
  const claim = typeof entry.claim === 'string' ? entry.claim.slice(0, ${MAX_RESEARCH_CLAIM_CHARS}) : ''
  const sourceIds = Array.isArray(entry.sourceIds)
    ? [...new Set(entry.sourceIds.filter((sourceId) => typeof sourceId === 'string' && sourceById.has(sourceId)))].slice(0, 2)
    : []
  const sources = sourceIds.map((sourceId) => sourceById.get(sourceId)).filter(Boolean)
  if (!claim || !sources.length) continue
  supported.push({ claim, sources })
}
if (!supported.length) {
  return { ok: false, supported: [], summary: 'Verification produced no supported evidence.' }
}

phase('Report')
const report = await agent(
  'Write a ONE-LINE plain-text answer (at most ${MAX_RESEARCH_SUMMARY_CHARS} characters) to this question using ONLY the supported claims below. ' +
  'Do NOT write a full report body — return only the one-line summary.\\n\\n' +
  'QUESTION: ' + question + '\\n\\nSUPPORTED CLAIMS JSON:\\n' + JSON.stringify(supported),
  {
    label: 'write report',
    tools: [],
    harness_config: 'none',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { summary: { type: 'string', maxLength: ${MAX_RESEARCH_SUMMARY_CHARS} } },
      required: ['summary'],
    },
  }
)

return {
  ok: true,
  supported,
  summary: (report && typeof report.summary === 'string' ? report.summary : '').slice(0, ${MAX_RESEARCH_SUMMARY_CHARS}),
}`;
}

/**
 * Render cited Markdown from the bounded supported claims. Rejects any claim
 * that is missing content or has no cited source URL. Deterministic: the host
 * — not a model — owns the report body, so there is no path for the model to
 * smuggle uncited content into the report file.
 */
export function renderResearchReport(question: string, supported: readonly SupportedClaim[]): string {
  const lines: string[] = ["# Deep Research Report", ""];
  const safeQuestion = escapeMarkdownInline(normalizeSingleLine(question, MAX_RESEARCH_QUESTION_CHARS));
  lines.push(`**Question:** ${safeQuestion}`, "");
  lines.push("## Supported claims");
  for (const entry of supported) {
    const claim = normalizeSingleLine(entry?.claim, MAX_RESEARCH_CLAIM_CHARS);
    const sources = Array.isArray(entry?.sources) ? entry.sources.filter((s) => typeof s === "string" && s.trim()) : [];
    if (!claim || sources.length === 0) continue; // reject missing/uncited content
    lines.push(`- ${escapeMarkdownInline(claim)}`);
    for (const url of sources) lines.push(`  - ${url.trim()}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Write the cited Markdown report to a fresh private directory under the OS
 * tmpdir and return the absolute path. The directory is created with
 * mkdtempSync("pi-deep-research-") and the report file is opened with
 * exclusive creation (O_WRONLY|O_CREAT|O_EXCL) so it cannot land on an
 * existing entry. No cwd/.pi/.research writes and no model-controlled path.
 *
 * The writer is injectable so unit tests can substitute a failing writer
 * without touching the real filesystem.
 */
export type ResearchReportWriter = (report: string) => string;
export type ResearchCitationVerifier = (url: string) => Promise<boolean>;

/** Default writer used by the live handler. */
export function defaultResearchReportWriter(report: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-deep-research-"));
  const reportPath = join(dir, "report.md");
  const fd = openSync(reportPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, report, "utf8");
  } finally {
    closeSync(fd);
  }
  return reportPath;
}

/**
 * Pure, host-side delivery for /deep-research. Re-fetches retained citations,
 * drops failed/empty responses, renders cited Markdown via the injectable writer,
 * derives an acknowledgement from verified evidence, and re-clamps to at most
 * MAX_SUPPORTED_CLAIMS claims (each claim/url re-sliced to its byte budget),
 * and returns the compact result (path + claim/source counts + short summary)
 * without ever putting the report body in any result channel.
 *
 * The validated question is passed in by the slash handler (which already
 * rejected overlong questions before launching the workflow) and is used only
 * to title the rendered report — it is never read back from the model-controlled
 * workflow result, so a model cannot influence the report heading.
 *
 * Extracted from the handler so the safety contract (no false success,
 * uncited rejection, writer failure, cited-summary derivation) is unit-testable
 * without running the engine.
 *
 * @param question the already-validated handler question (titles the report)
 * @param result the workflow run result (its `result` is the bounded
 *   DeepResearchResult carrying supported + summary; no question)
 * @param writer injectable writer that returns the absolute report path
 */
export async function deliverDeepResearchResult(
  question: string,
  result: { runId?: string; result?: unknown },
  writer: ResearchReportWriter = defaultResearchReportWriter,
  verifyCitation: ResearchCitationVerifier = verifyWebCitation,
): Promise<
  | { ok: true; path: string; count: number; sources: number; summary: string; message: string }
  | { ok: false; warning: string }
> {
  const res = (result?.result ?? {}) as Partial<DeepResearchResult> & { supported?: unknown; question?: unknown };
  if (res?.ok !== true) {
    return {
      ok: false,
      warning: "deep-research did not return a valid result — not delivering a report.",
    };
  }
  const supportedRaw = Array.isArray(res.supported) ? res.supported : [];
  const supported: SupportedClaim[] = [];
  const verificationCache = new Map<string, Promise<boolean>>();
  for (const entry of supportedRaw) {
    if (supported.length >= MAX_SUPPORTED_CLAIMS) break;
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as Partial<SupportedClaim>;
    const claim = normalizeSingleLine(raw.claim, MAX_RESEARCH_CLAIM_CHARS);
    if (!claim) continue;
    const normalizedSources = Array.isArray(raw.sources)
      ? [
          ...new Set(
            raw.sources.flatMap((source) => {
              const normalized = normalizeHttpSource(source);
              return normalized ? [normalized] : [];
            }),
          ),
        ]
      : [];
    const sources: string[] = [];
    for (const source of normalizedSources) {
      if (sources.length >= 2) break;
      let verification = verificationCache.get(source);
      if (!verification) {
        verification = Promise.resolve()
          .then(() => verifyCitation(source))
          .catch(() => false);
        verificationCache.set(source, verification);
      }
      if (await verification) sources.push(source);
    }
    if (sources.length === 0) continue;
    supported.push({ claim, sources });
  }
  if (supported.length === 0) {
    return {
      ok: false,
      warning: "deep-research produced no cited claims — not delivering a report.",
    };
  }
  // The host owns the question (validated before the workflow ran); ignore any
  // stray question the model might return in the result channel.
  const report = renderResearchReport(typeof question === "string" ? question : "", supported);
  let path: string;
  try {
    path = writer(report);
  } catch (error) {
    return {
      ok: false,
      warning: `deep-research report writer failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!path?.trim()) {
    return {
      ok: false,
      warning: "deep-research report writer returned no path — not delivering a report.",
    };
  }
  // Derive the acknowledgement only from retained cited evidence. A model
  // summary may mention claims whose citations were filtered out, so it is
  // intentionally not delivered to chat.
  const summary = clampSummary(supported[0]?.claim);
  const count = supported.length;
  const citedUrls = supported.flatMap((entry) => (entry.sources || []).map((s) => s.trim()).filter(Boolean));
  const sources = new Set(citedUrls).size;
  const message = `Deep research report: ${path}. ${count} cited claims across ${sources} sources.${
    summary ? ` Summary: ${escapeMarkdownInline(summary)}` : ""
  }`;
  return { ok: true, path, count, sources, summary, message };
}

/** Flatten controls/newlines so one claim always renders as exactly one bullet. */
function normalizeSingleLine(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    return isControl || codePoint === 0x2028 || codePoint === 0x2029 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/** Escape inline Markdown metacharacters without adding new report lines. */
function escapeMarkdownInline(value: string): string {
  const specials = new Set(["\\", "`", "*", "_", "[", "]", "{", "}", "<", ">", "#", "+", "-", "!", "|"]);
  return Array.from(value, (character) => (specials.has(character) ? `\\${character}` : character)).join("");
}

/** Accept only bounded HTTP(S) citations; reject overlong URLs instead of truncating them. */
function normalizeHttpSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_RESEARCH_URL_CHARS) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const canonical = parsed.toString();
    return canonical.length <= MAX_RESEARCH_URL_CHARS ? canonical : null;
  } catch {
    return null;
  }
}

/** Clamp a summary string to at most MAX_RESEARCH_SUMMARY_CHARS chars (defensive host-side bound). */
function clampSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > MAX_RESEARCH_SUMMARY_CHARS ? trimmed.slice(0, MAX_RESEARCH_SUMMARY_CHARS) : trimmed;
}

/**
 * Generate a codebase audit workflow.
 */
export function generateCodebaseAuditWorkflow(scope: string, checks: string[]): string {
  const escapedScope = scope.replace(/'/g, "\\'").slice(0, 60);
  const checkAgents = checks
    .map((check) => {
      const label = check
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 20);
      return `  () => agent('Audit ${check} across: ' + scope, { label: '${label}' }),`;
    })
    .join("\n");

  return `export const meta = {
  name: 'codebase_audit',
  description: 'Codebase audit: ${escapedScope}',
  phases: [
    { title: 'Individual Checks' },
    { title: 'Cross-Validation' },
    { title: 'Report' },
  ],
};

phase('Individual Checks');
const scope = '${escapedScope}';
const findings = await parallel([
${checkAgents}
]);

phase('Cross-Validation');
const validated = await agent(
  'Cross-validate these audit findings. Remove false positives and confirm real issues:\\n' +
  JSON.stringify(findings),
  { label: 'validator' }
);

phase('Report');
const report = await agent(
  'Generate a prioritized audit report with actionable recommendations:\\n' + validated,
  { label: 'report-writer' }
);

return { findings, validated, report };`;
}
