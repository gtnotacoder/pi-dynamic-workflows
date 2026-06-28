import { createHash } from "node:crypto";

export type FeedbackSeverity = "error" | "warning" | "info";
export type FeedbackStatus = "open" | "resolved" | "superseded";
export type FeedbackVerdict = "pass" | "fail" | "blocked";

export interface FeedbackLocation {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface FeedbackFinding {
  id?: string;
  rule?: string;
  location?: FeedbackLocation | string | null;
  message?: string;
  severity?: FeedbackSeverity;
  status?: FeedbackStatus;
  firstObservedIn?: number;
  lastObservedIn?: number;
  trace?: string | null;
  blocking?: boolean;
  keepForContext?: boolean;
}

export interface FeedbackRound {
  /** 1-based attempt number. Missing values are normalized from array order. */
  index?: number;
  /** pass/fail/blocked (or boolean, where false = fail and true = pass). */
  verdict?: FeedbackVerdict | boolean;
  /** Structured findings from a verifier or host check. */
  findings?: FeedbackFinding[];
  /** Short free-form failure/verifier text. Converted into a normalized finding. */
  feedback?: string;
  message?: string;
  /** Optional host-side stageCheck result; failed checks are normalized into findings. */
  localChecks?: unknown;
  /** Optional trace snippet for the round. */
  trace?: string;
}

export interface CompactFeedbackRequest {
  rounds: FeedbackRound[];
  maxTokens?: number;
  previousDelta?: CorrectionDelta | null;
  auditLogId?: string;
  canonicalStateRef?: string;
}

export interface OpenRootCause {
  rank: number;
  findingId: string;
  rule: string;
  location: FeedbackLocation | null;
  severity: FeedbackSeverity;
  firstSeen: number;
  lastSeen: number;
  message: string;
  trace: string | null;
  blocking: boolean;
}

export interface CorrectionDelta {
  attempt: number;
  lastVerdict: FeedbackVerdict;
  openRootCauses: OpenRootCause[];
  resolvedSummary: string | null;
  omitted: { count: number; auditLogId: string } | null;
  constraints: string[];
  /** Deterministic monotonic marker (round-N), never wall-clock time. */
  generatedAt: string;
}

interface NormalizedFinding {
  id: string;
  rule: string;
  location: FeedbackLocation | null;
  message: string;
  severity: FeedbackSeverity;
  status: FeedbackStatus;
  firstObservedIn: number;
  lastObservedIn: number;
  trace: string | null;
  blocking: boolean;
  keepForContext: boolean;
}

interface RootCause {
  findingId: string;
  rule: string;
  location: FeedbackLocation | null;
  severity: FeedbackSeverity;
  firstSeen: number;
  lastSeen: number;
  status: FeedbackStatus;
  message: string;
  trace: string | null;
  blocking: boolean;
  keepForContext: boolean;
  rounds: number[];
}

export const MAX_CORRECTION_DELTA_TOKENS = 512;
const MAX_MESSAGE_CHARS = 420;
const MAX_TRACE_CHARS = 260;
const SECRET_REPLACEMENT = "«redacted:secret»";

export const CORRECTION_DELTA_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kneutral.org/schemas/correction-delta.v1.json",
  title: "Correction Delta",
  type: "object",
  additionalProperties: false,
  required: ["attempt", "lastVerdict", "openRootCauses", "resolvedSummary", "omitted", "constraints", "generatedAt"],
  properties: {
    attempt: { type: "integer", minimum: 1 },
    lastVerdict: { type: "string", enum: ["pass", "fail", "blocked"] },
    openRootCauses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "rank",
          "findingId",
          "rule",
          "location",
          "severity",
          "firstSeen",
          "lastSeen",
          "message",
          "trace",
          "blocking",
        ],
        properties: {
          rank: { type: "integer", minimum: 1 },
          findingId: { type: "string" },
          rule: { type: "string" },
          location: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: {
                  path: { type: "string" },
                  startLine: { type: "integer", minimum: 1 },
                  endLine: { type: "integer", minimum: 1 },
                },
              },
              { type: "null" },
            ],
          },
          severity: { type: "string", enum: ["error", "warning", "info"] },
          firstSeen: { type: "integer", minimum: 1 },
          lastSeen: { type: "integer", minimum: 1 },
          message: { type: "string" },
          trace: { oneOf: [{ type: "string" }, { type: "null" }] },
          blocking: { type: "boolean" },
        },
      },
    },
    resolvedSummary: { oneOf: [{ type: "string" }, { type: "null" }] },
    omitted: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["count", "auditLogId"],
          properties: { count: { type: "integer", minimum: 1 }, auditLogId: { type: "string" } },
        },
        { type: "null" },
      ],
    },
    constraints: { type: "array", items: { type: "string" } },
    generatedAt: { type: "string" },
  },
} as const;

export class FeedbackCompactionError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "FeedbackCompactionError";
    this.issues = issues;
  }
}

/**
 * Deterministic five-stage Feedback Compactor:
 * normalize -> group -> resolve/deduplicate -> relevance-rank -> bounded Delta.
 */
export function compactFeedback(request: CompactFeedbackRequest): CorrectionDelta {
  if (!request || !Array.isArray(request.rounds) || request.rounds.length === 0) {
    throw new FeedbackCompactionError("compactFeedback requires at least one feedback round", [
      "rounds: non-empty array",
    ]);
  }

  const rounds = request.rounds.map((round, index) => ({ ...round, index: normalizeRoundIndex(round.index, index) }));
  const lastRound = Math.max(...rounds.map((round) => round.index));
  const lastVerdict = normalizeVerdict(rounds.at(-1)?.verdict);

  // Stage 1 — Normalize heterogeneous verifier/local-check records into findings.
  const findings = rounds.flatMap((round) => normalizeRound(round));

  // Stage 2 — Group exact root causes by stable id.
  const grouped = groupRootCauses(findings);

  // Stage 3 — Deduplicate to latest status and split open/resolved.
  const active = grouped.filter((cause) => cause.status === "open" || cause.keepForContext);
  const resolved = grouped.filter((cause) => cause.status !== "open" && !cause.keepForContext);

  // Stage 4 — Order by current relevance (fresh/recent blockers first, stable tie-breakers).
  active.sort(
    (a, b) => relevanceScore(b, lastRound) - relevanceScore(a, lastRound) || a.findingId.localeCompare(b.findingId),
  );

  // Stage 5 — Redact and condense into one bounded CorrectionDelta.
  const constraints = resolved.slice(0, 8).map((cause) => constraintForResolved(cause));
  const budgetTokens = Math.max(64, Math.floor(request.maxTokens ?? MAX_CORRECTION_DELTA_TOKENS));
  const budgetChars = budgetTokens * 4;
  const auditLogId = request.auditLogId ?? `audit-${lastRound}`;
  const openRootCauses: OpenRootCause[] = [];
  let omittedCount = 0;

  for (const cause of active) {
    const item = toOpenRootCause(cause, openRootCauses.length + 1);
    const candidate: CorrectionDelta = {
      attempt: lastRound + 1,
      lastVerdict,
      openRootCauses: [...openRootCauses, item],
      resolvedSummary: summarizeResolved(resolved),
      omitted: null,
      constraints,
      generatedAt: `round-${lastRound}`,
    };
    if (renderCorrectionDelta(candidate).length <= budgetChars) {
      openRootCauses.push(item);
    } else {
      omittedCount++;
    }
  }

  // If even the top item would exceed the budget, keep a heavily-trimmed first item
  // rather than emitting a blank failure section.
  if (openRootCauses.length === 0 && active.length > 0) {
    const first = toOpenRootCause(active[0], 1, { messageChars: 180, traceChars: 0 });
    openRootCauses.push(first);
    omittedCount = Math.max(0, active.length - 1);
  } else {
    omittedCount += Math.max(0, active.length - openRootCauses.length - omittedCount);
  }

  const delta: CorrectionDelta = {
    attempt: lastRound + 1,
    lastVerdict,
    openRootCauses,
    resolvedSummary: summarizeResolved(resolved),
    omitted: omittedCount > 0 ? { count: omittedCount, auditLogId } : null,
    constraints,
    generatedAt: `round-${lastRound}`,
  };

  // A final budget pass trims non-essential fields before validation. If it still
  // exceeds budget, drop low-rank causes and leave an explicit omitted marker.
  enforceBudget(delta, budgetChars, auditLogId);

  const validation = validateCorrectionDelta(delta);
  if (!validation.ok) {
    throw new FeedbackCompactionError("compacted feedback failed CorrectionDelta schema validation", validation.errors);
  }
  return delta;
}

/** Prompt-ready rendering. The Worker should receive only this rendered Delta, not raw logs. */
export function renderCorrectionDelta(delta: CorrectionDelta): string {
  return JSON.stringify(delta);
}

export function validateCorrectionDelta(delta: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const d = delta as Partial<CorrectionDelta> | null;
  if (!d || typeof d !== "object") return { ok: false, errors: ["delta must be an object"] };
  if (!Number.isInteger(d.attempt) || (d.attempt ?? 0) < 1) errors.push("attempt must be an integer >= 1");
  if (!isVerdict(d.lastVerdict)) errors.push("lastVerdict must be pass/fail/blocked");
  if (!Array.isArray(d.openRootCauses)) errors.push("openRootCauses must be an array");
  if (d.resolvedSummary !== null && d.resolvedSummary !== undefined && typeof d.resolvedSummary !== "string") {
    errors.push("resolvedSummary must be string|null");
  }
  if (d.omitted !== null && d.omitted !== undefined) {
    if (
      typeof d.omitted !== "object" ||
      !Number.isInteger(d.omitted.count) ||
      d.omitted.count < 1 ||
      typeof d.omitted.auditLogId !== "string"
    ) {
      errors.push("omitted must be null or { count >= 1, auditLogId }");
    }
  }
  if (!Array.isArray(d.constraints) || d.constraints.some((constraint) => typeof constraint !== "string")) {
    errors.push("constraints must be string[]");
  }
  if (typeof d.generatedAt !== "string" || d.generatedAt.length === 0) errors.push("generatedAt must be a string");

  for (const [index, cause] of (Array.isArray(d.openRootCauses) ? d.openRootCauses : []).entries()) {
    validateOpenRootCause(cause, index, errors);
  }

  const rendered = safeStringify(delta);
  if (containsSecret(rendered)) errors.push("rendered delta contains an unredacted secret-looking value");
  return { ok: errors.length === 0, errors };
}

function normalizeRoundIndex(index: unknown, offset: number): number {
  return typeof index === "number" && Number.isInteger(index) && index > 0 ? index : offset + 1;
}

function normalizeRound(round: FeedbackRound & { index: number }): NormalizedFinding[] {
  const out: NormalizedFinding[] = [];
  const status = normalizeVerdict(round.verdict) === "pass" ? "resolved" : "open";
  const findings = Array.isArray(round.findings) ? round.findings : [];
  for (const finding of findings) {
    const normalized = normalizeFinding(finding, round.index, status, round.trace);
    if (normalized) out.push(normalized);
  }

  for (const finding of findingsFromStageCheck(round.localChecks, round.index)) out.push(finding);

  const freeText = coerceString(round.feedback ?? round.message);
  if (freeText) {
    const finding = normalizeFinding(
      {
        rule: normalizeVerdict(round.verdict) === "blocked" ? "verifier:blocked" : "verifier:feedback",
        message: freeText,
        severity: normalizeVerdict(round.verdict) === "blocked" ? "error" : "warning",
        status,
        trace: round.trace,
        blocking: normalizeVerdict(round.verdict) === "blocked",
      },
      round.index,
      status,
      round.trace,
    );
    if (finding) out.push(finding);
  }
  return out;
}

function normalizeFinding(
  finding: FeedbackFinding,
  roundIndex: number,
  defaultStatus: FeedbackStatus,
  roundTrace?: string,
): NormalizedFinding | null {
  const message = redact(trimTo(coerceString(finding.message), MAX_MESSAGE_CHARS));
  if (!message) return null;
  const rule = trimTo(coerceString(finding.rule) || "verifier:feedback", 96);
  const location = normalizeLocation(finding.location);
  const status = isStatus(finding.status) ? finding.status : defaultStatus;
  const firstObservedIn = normalizeRoundIndex(finding.firstObservedIn, roundIndex - 1);
  const lastObservedIn = normalizeRoundIndex(finding.lastObservedIn, roundIndex - 1);
  const severity = isSeverity(finding.severity) ? finding.severity : status === "open" ? "error" : "info";
  const trace = redact(trimTo(coerceString(finding.trace ?? roundTrace), MAX_TRACE_CHARS)) || null;
  const id = coerceString(finding.id) || stableFindingId(rule, location, message);
  return {
    id,
    rule,
    location,
    message,
    severity,
    status,
    firstObservedIn: Math.min(firstObservedIn, lastObservedIn),
    lastObservedIn: Math.max(firstObservedIn, lastObservedIn),
    trace,
    blocking: Boolean(finding.blocking) || severity === "error",
    keepForContext: Boolean(finding.keepForContext),
  };
}

function findingsFromStageCheck(value: unknown, roundIndex: number): NormalizedFinding[] {
  const result = value as { checks?: unknown[] } | null;
  if (!result || typeof result !== "object" || !Array.isArray(result.checks)) return [];
  const out: NormalizedFinding[] = [];
  for (const check of result.checks) {
    const c = check as {
      name?: unknown;
      ok?: unknown;
      exitCode?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      summary?: unknown;
    };
    if (c.ok !== false) continue;
    const name = coerceString(c.name) || "check";
    const output = [coerceString(c.summary), coerceString(c.stderr), coerceString(c.stdout)].filter(Boolean).join("\n");
    const normalized = normalizeFinding(
      {
        rule: `stage-check:${name}`,
        severity: "error",
        message: output || `${name} failed with exit code ${coerceString(c.exitCode) || "unknown"}`,
        status: "open",
        blocking: true,
      },
      roundIndex,
      "open",
    );
    if (normalized) out.push(normalized);
  }
  return out;
}

function groupRootCauses(findings: NormalizedFinding[]): RootCause[] {
  const byId = new Map<string, RootCause>();
  for (const finding of findings) {
    const existing = byId.get(finding.id);
    if (!existing) {
      byId.set(finding.id, {
        findingId: finding.id,
        rule: finding.rule,
        location: finding.location,
        severity: finding.severity,
        firstSeen: finding.firstObservedIn,
        lastSeen: finding.lastObservedIn,
        status: finding.status,
        message: finding.message,
        trace: finding.trace,
        blocking: finding.blocking,
        keepForContext: finding.keepForContext,
        rounds: [finding.lastObservedIn],
      });
      continue;
    }
    existing.firstSeen = Math.min(existing.firstSeen, finding.firstObservedIn);
    existing.lastSeen = Math.max(existing.lastSeen, finding.lastObservedIn);
    existing.rounds = [...new Set([...existing.rounds, finding.lastObservedIn])].sort((a, b) => a - b);
    if (severityWeight(finding.severity) > severityWeight(existing.severity)) existing.severity = finding.severity;
    existing.blocking = existing.blocking || finding.blocking;
    existing.keepForContext = existing.keepForContext || finding.keepForContext;
    if (finding.lastObservedIn >= existing.lastSeen) {
      existing.status = finding.status;
      existing.message = finding.message;
      existing.trace = existing.trace ?? finding.trace;
    }
  }
  return [...byId.values()];
}

function relevanceScore(cause: RootCause, lastRound: number): number {
  const recency = Math.max(0, lastRound - cause.lastSeen);
  const recentScore = 1000 - recency * 100;
  const freshScore = cause.firstSeen === cause.lastSeen ? 60 : 0;
  const blockingScore = cause.blocking ? 30 : 0;
  return recentScore + severityWeight(cause.severity) * 10 + freshScore + blockingScore;
}

function toOpenRootCause(
  cause: RootCause,
  rank: number,
  opts: { messageChars?: number; traceChars?: number } = {},
): OpenRootCause {
  const traceChars = opts.traceChars ?? MAX_TRACE_CHARS;
  return {
    rank,
    findingId: cause.findingId,
    rule: cause.rule,
    location: cause.location,
    severity: cause.severity,
    firstSeen: cause.firstSeen,
    lastSeen: cause.lastSeen,
    message: redact(trimTo(cause.message, opts.messageChars ?? MAX_MESSAGE_CHARS)),
    trace: traceChars > 0 && cause.trace ? redact(trimTo(cause.trace, traceChars)) : null,
    blocking: cause.blocking,
  };
}

function enforceBudget(delta: CorrectionDelta, budgetChars: number, auditLogId: string): void {
  while (renderCorrectionDelta(delta).length > budgetChars && delta.openRootCauses.length > 1) {
    delta.openRootCauses.pop();
    delta.omitted = { count: (delta.omitted?.count ?? 0) + 1, auditLogId };
  }
  if (renderCorrectionDelta(delta).length <= budgetChars) return;
  for (const cause of delta.openRootCauses) {
    cause.message = trimTo(cause.message, 180);
    cause.trace = null;
  }
  while (renderCorrectionDelta(delta).length > budgetChars && delta.constraints.length > 0) delta.constraints.pop();
}

function summarizeResolved(resolved: RootCause[]): string | null {
  if (!resolved.length) return null;
  const rounds = [...new Set(resolved.map((cause) => cause.lastSeen))].sort((a, b) => a - b).join(", ");
  return `${resolved.length} prior finding${resolved.length === 1 ? "" : "s"} resolved/superseded by rounds ${rounds}`;
}

function constraintForResolved(cause: RootCause): string {
  const loc = cause.location ? ` at ${formatLocation(cause.location)}` : "";
  return `Do not re-chase resolved finding ${cause.findingId}${loc}; verify only if it reappears in current checks.`;
}

function normalizeLocation(location: FeedbackFinding["location"]): FeedbackLocation | null {
  if (!location) return null;
  if (typeof location === "string") return { path: redactPath(location) };
  if (typeof location !== "object") return null;
  const path = coerceString(location.path);
  if (!path) return null;
  const out: FeedbackLocation = { path: redactPath(path) };
  if (Number.isInteger(location.startLine) && (location.startLine ?? 0) > 0) out.startLine = location.startLine;
  if (Number.isInteger(location.endLine) && (location.endLine ?? 0) > 0) out.endLine = location.endLine;
  return out;
}

function stableFindingId(rule: string, location: FeedbackLocation | null, message: string): string {
  const identity = JSON.stringify({ rule, location, message: message.replace(/\s+/g, " ").trim() });
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function normalizeVerdict(verdict: FeedbackRound["verdict"]): FeedbackVerdict {
  if (verdict === true) return "pass";
  if (verdict === false) return "fail";
  return isVerdict(verdict) ? verdict : "fail";
}

function isVerdict(value: unknown): value is FeedbackVerdict {
  return value === "pass" || value === "fail" || value === "blocked";
}

function isStatus(value: unknown): value is FeedbackStatus {
  return value === "open" || value === "resolved" || value === "superseded";
}

function isSeverity(value: unknown): value is FeedbackSeverity {
  return value === "error" || value === "warning" || value === "info";
}

function severityWeight(severity: FeedbackSeverity): number {
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function validateOpenRootCause(cause: unknown, index: number, errors: string[]): void {
  const c = cause as Partial<OpenRootCause> | null;
  if (!c || typeof c !== "object") {
    errors.push(`openRootCauses[${index}] must be an object`);
    return;
  }
  if (!Number.isInteger(c.rank) || c.rank !== index + 1)
    errors.push(`openRootCauses[${index}].rank must be ${index + 1}`);
  if (typeof c.findingId !== "string" || !c.findingId) errors.push(`openRootCauses[${index}].findingId required`);
  if (typeof c.rule !== "string" || !c.rule) errors.push(`openRootCauses[${index}].rule required`);
  if (c.location !== null && c.location !== undefined) {
    if (typeof c.location !== "object" || typeof c.location.path !== "string" || !c.location.path) {
      errors.push(`openRootCauses[${index}].location must be null or { path }`);
    }
  }
  if (!isSeverity(c.severity)) errors.push(`openRootCauses[${index}].severity invalid`);
  if (!Number.isInteger(c.firstSeen) || (c.firstSeen ?? 0) < 1)
    errors.push(`openRootCauses[${index}].firstSeen invalid`);
  if (!Number.isInteger(c.lastSeen) || (c.lastSeen ?? 0) < 1) errors.push(`openRootCauses[${index}].lastSeen invalid`);
  if (typeof c.message !== "string") errors.push(`openRootCauses[${index}].message required`);
  if (c.trace !== null && c.trace !== undefined && typeof c.trace !== "string") {
    errors.push(`openRootCauses[${index}].trace must be string|null`);
  }
  if (typeof c.blocking !== "boolean") errors.push(`openRootCauses[${index}].blocking required`);
}

function redact(value: string): string {
  if (!value) return value;
  return value
    .replace(/(sk|pk|rk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{16,}/g, SECRET_REPLACEMENT)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "«redacted:email»")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,'"]+/gi, (match) => {
      const key = match.split(/[:=]/)[0] ?? "secret";
      return `${key}= ${SECRET_REPLACEMENT}`;
    });
}

function containsSecret(value: string): boolean {
  return /(sk|pk|rk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{16,}/.test(value);
}

function redactPath(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/Users\/[^/]+\//, "~/");
}

function trimTo(value: string, maxChars: number): string {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function coerceString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLocation(location: FeedbackLocation): string {
  if (location.startLine && location.endLine && location.endLine !== location.startLine) {
    return `${location.path}:${location.startLine}-${location.endLine}`;
  }
  if (location.startLine) return `${location.path}:${location.startLine}`;
  return location.path;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
