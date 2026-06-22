import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";

/**
 * Built-in `code-review` workflow — an effort-parameterized multi-angle review.
 *
 * Topology: Scope → pipeline(per-angle Find → Verify) → Sweep (xhigh/max) → Synthesize.
 *   high  = 3 correctness + 5 cleanup angles, ≤6 per angle, ≤10 findings, no sweep
 *   xhigh = 5 correctness + 5 cleanup angles, ≤8 per angle, ≤15 findings, sweep of ≤8
 *   max   = same structure as xhigh (API reasoning effort differs, not the fan-out)
 *
 * Angle taxonomy (the "5 cleanup" = cleanup + altitude + conventions, all `kind: "cleanup"`):
 *   correctness: Angle A (line-by-line) · B (removed-behavior) · C (cross-file) ·
 *                D (language-pitfall) · E (wrapper/proxy)  — labels angle-A..angle-E
 *   cleanup:     reuse · simplification · efficiency · altitude · conventions
 * Verifier verdict ladder: CONFIRMED / PLAUSIBLE / REFUTED (recall-biased: PLAUSIBLE by
 * default). Synthesis ranks correctness over cleanup, CONFIRMED over PLAUSIBLE, merges
 * semantic dupes by index, caps at maxFindings, and backfills unmerged findings.
 *
 * The generated script is static and reads host-prepared inputs from `args` at runtime.
 * Host code owns all git argv + patch collection; reviewer agents are read-only and
 * never receive a model-produced shell command to run.
 */

/** Level parameters (own-property check protects the level parse). */
const LEVEL_PARAMS: Record<
  string,
  { correctnessAngles: number; perAngle: number; maxFindings: number; sweep: boolean }
> = {
  high: { correctnessAngles: 3, perAngle: 6, maxFindings: 10, sweep: false },
  xhigh: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
  max: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
};

type CodeReviewLevel = keyof typeof LEVEL_PARAMS;

export interface CodeReviewDiffCommand {
  cmd: "git";
  args: string[];
  display: string;
}

export interface PreparedCodeReviewArgs {
  level: CodeReviewLevel;
  target?: string;
  instructions?: string;
  diff: {
    commands: CodeReviewDiffCommand[];
    files: string[];
    patch: string;
  };
}

export type CodeReviewExecRunner = (
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer: number; shell: false },
) => Promise<{ stdout: string; stderr: string }>;

const DIFF_MAX_BUFFER = 10 * 1024 * 1024;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]*$/;
const RANGE_RE = /^(.+?)(\.\.\.?)\s*(.+)$/;

async function defaultExecRunner(
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer: number; shell: false },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolvePromise({ stdout, stderr });
    });
  });
}

function shellQuoteForDisplay(arg: string): string {
  return /^[A-Za-z0-9_./:@{}^~+=,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function gitDisplay(args: string[]): string {
  return ["git", ...args].map(shellQuoteForDisplay).join(" ");
}

async function runGit(cwd: string, args: string[], runner: CodeReviewExecRunner): Promise<string> {
  const { stdout } = await runner("git", args, { cwd, maxBuffer: DIFF_MAX_BUFFER, shell: false });
  return stdout;
}

function parseCodeReviewRawArgs(rawArgs: string): { level: CodeReviewLevel; rest: string; tokens: string[] } {
  const raw = rawArgs.trim();
  const tokens = splitArgs(raw);
  const first = tokens[0] ?? "";
  const isLevel = Object.hasOwn(LEVEL_PARAMS, first);
  const level = (isLevel ? first : "high") as CodeReviewLevel;
  const rest = isLevel ? raw.slice(first.length).trim() : raw;
  const restTokens = isLevel ? tokens.slice(1) : tokens;
  return { level, rest, tokens: restTokens };
}

function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote)
    throw new WorkflowError("Unclosed quote in /code-review target", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
  if (current) out.push(current);
  return out;
}

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    if (ch.charCodeAt(0) < 32) return true;
  }
  return false;
}

function validatePathspec(cwd: string, pathspec: string): string {
  if (!pathspec || pathspec.startsWith("-")) {
    throw new WorkflowError(`Unsafe /code-review path target: ${pathspec}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
  }
  if (hasControlCharacter(pathspec) || isAbsolute(pathspec)) {
    throw new WorkflowError(`Unsafe /code-review path target: ${pathspec}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
  }
  const abs = resolve(cwd, pathspec);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorkflowError(
      `Path target escapes the repository: ${pathspec}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
  }
  return rel;
}

function looksLikePathToken(cwd: string, token: string): boolean {
  if (token.includes("/") || token.includes("\\") || token.includes(".")) return true;
  return existsSync(resolve(cwd, token));
}

function assertSafeRef(ref: string): string {
  if (!SAFE_REF.test(ref) || ref.startsWith("-") || ref.includes("..")) {
    throw new WorkflowError(`Unsafe /code-review git ref: ${ref}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
  }
  return ref;
}

async function validateRef(cwd: string, ref: string, runner: CodeReviewExecRunner): Promise<void> {
  assertSafeRef(ref);
  await runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], runner);
}

async function validateRange(cwd: string, range: string, runner: CodeReviewExecRunner): Promise<string> {
  const m = range.match(RANGE_RE);
  if (!m)
    throw new WorkflowError(`Unsupported /code-review range: ${range}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
  const left = assertSafeRef(m[1].trim());
  const sep = m[2];
  const right = assertSafeRef(m[3].trim());
  await validateRef(cwd, left, runner);
  await validateRef(cwd, right, runner);
  return `${left}${sep}${right}`;
}

async function collectDiff(
  cwd: string,
  runner: CodeReviewExecRunner,
  range: string | undefined,
  pathspecs: string[] = [],
): Promise<PreparedCodeReviewArgs["diff"]> {
  const diffArgs = ["-c", "core.pager=cat", "diff", "--no-ext-diff", "--no-color", "--no-textconv"];
  if (range) diffArgs.push(range);
  if (pathspecs.length) diffArgs.push("--", ...pathspecs);
  const nameArgs = ["-c", "core.pager=cat", "diff", "--name-only", "--no-ext-diff", "--no-color", "--no-textconv"];
  if (range) nameArgs.push(range);
  if (pathspecs.length) nameArgs.push("--", ...pathspecs);
  const [patch, names] = await Promise.all([runGit(cwd, diffArgs, runner), runGit(cwd, nameArgs, runner)]);
  const files = names
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { commands: [{ cmd: "git", args: diffArgs, display: gitDisplay(diffArgs) }], files, patch };
}

async function defaultDiff(cwd: string, runner: CodeReviewExecRunner, pathspecs: string[] = []) {
  const candidates = ["@{upstream}...HEAD", "main...HEAD", "HEAD~1"];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const diff = await collectDiff(cwd, runner, candidate, pathspecs);
      if (diff.patch.trim() || diff.files.length > 0) return diff;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return collectDiff(cwd, runner, "HEAD", pathspecs);
}

/**
 * Prepare /code-review input in host code. Review agents receive a patch/files
 * object and read-only tools; no model output is allowed to author shell strings.
 */
export async function prepareCodeReviewArgs(
  rawArgs: string,
  cwd: string,
  runner: CodeReviewExecRunner = defaultExecRunner,
): Promise<PreparedCodeReviewArgs> {
  const { level, rest, tokens } = parseCodeReviewRawArgs(rawArgs);
  let diff: PreparedCodeReviewArgs["diff"];
  let instructions: string | undefined;
  const target: string | undefined = rest || undefined;

  if (tokens.length === 1 && tokens[0].startsWith("-")) {
    throw new WorkflowError(`Unsafe /code-review target: ${tokens[0]}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
  }

  if (tokens.length === 1 && RANGE_RE.test(tokens[0])) {
    const range = await validateRange(cwd, tokens[0], runner);
    diff = await collectDiff(cwd, runner, range);
  } else if (tokens.length === 1 && looksLikePathToken(cwd, tokens[0])) {
    const pathspec = validatePathspec(cwd, tokens[0]);
    diff = await defaultDiff(cwd, runner, [pathspec]);
  } else if (tokens.length === 1 && SAFE_REF.test(tokens[0]) && !Object.hasOwn(LEVEL_PARAMS, tokens[0])) {
    const ref = assertSafeRef(tokens[0]);
    await validateRef(cwd, ref, runner);
    diff = await collectDiff(cwd, runner, `${ref}...HEAD`);
  } else {
    instructions = rest || undefined;
    diff = await defaultDiff(cwd, runner);
  }

  return { level, target, instructions, diff };
}

/** Max findings the sweep phase may add (xhigh/max only). */
const SWEEP_MAX = 8;

/**
 * Correctness review angles (angle-A..angle-E).
 * `high` runs the first 3; `xhigh`/`max` run all 5.
 */
const CORRECTNESS_ANGLES: { label: string; text: string }[] = [
  {
    label: "angle-A",
    text: `### Angle A \u2014 line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for each hunk \u2014 bugs in unchanged lines of a touched function are in scope (the PR re-exposes or fails to fix them). For every line ask: what input, state, timing, or platform makes this line wrong? Look for inverted/wrong conditions, off-by-one, null/undefined deref, missing \`await\`, falsy-zero checks, wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.`,
  },
  {
    label: "angle-B",
    text: `### Angle B \u2014 removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it enforced, then search the new code for where that invariant is re-established. If you can't find it, that's a candidate: a removed guard, a dropped error path, a narrowed validation, a deleted test that was covering a real case.`,
  },
  {
    label: "angle-C",
    text: `### Angle C \u2014 cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and check whether the change breaks any call site: a new precondition, a changed return shape, a new exception, a timing/ordering dependency. Also check callees: does a parallel change in the same PR make a call unsafe?`,
  },
  {
    label: "angle-D",
    text: `### Angle D \u2014 language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework \u2014 for example: JS falsy-zero, \`==\` coercion, closure-captured loop var; Python mutable default args, late-binding closures; Go nil-map write, range-var capture; SQL injection; timezone/DST drift; float equality. Flag any instance the diff introduces.`,
  },
  {
    label: "angle-E",
    text: `### Angle E \u2014 wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator, adapter): check that every method routes to the wrapped instance and not back through a registry/session/global \u2014 e.g. a caching provider holding a \`delegate\` field that resolves IDs via \`session.get(...)\` instead of \`delegate.get(...)\` will re-enter the cache or recurse. Also check that the wrapper forwards all the methods the callers actually use.`,
  },
];

/** Cleanup review angles (always all 5; `kind: "cleanup"` in the workflow). */
const CLEANUP_ANGLES: { label: string; text: string }[] = [
  {
    label: "reuse",
    text: `### Reuse

Flag new code that re-implements something the codebase already has \u2014 Grep shared/utility modules and files adjacent to the change, and name the existing helper to call instead.`,
  },
  {
    label: "simplification",
    text: `### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state, copy-paste with slight variation, deep nesting, dead code left behind. Name the simpler form that does the same job.`,
  },
  {
    label: "efficiency",
    text: `### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O, independent operations run sequentially, blocking work added to startup or hot paths. Also flag long-lived objects built from closures or captured environments \u2014 they keep the entire enclosing scope alive for the object's lifetime (a memory leak when that scope holds large values); prefer a class/struct that copies only the fields it needs. Name the cheaper alternative.`,
  },
  {
    label: "altitude",
    text: `### Altitude

Check that each change is implemented at the right depth, not as a fragile bandaid. Special cases layered on shared infrastructure are a sign the fix isn't deep enough \u2014 prefer generalizing the underlying mechanism over adding special cases.`,
  },
  {
    label: "conventions",
    text: `### Conventions (AGENTS.md / CLAUDE.md)

Find the project convention files that govern the changed code \u2014 AGENTS.md and CLAUDE.md (and CLAUDE.local.md): the repo-root AGENTS.md or CLAUDE.md, any AGENTS.md / CLAUDE.md / CLAUDE.local.md in a directory that is an ancestor of a changed file (a directory's convention file only applies to files at or below it), and any user-level convention file (e.g. ~/.pi/AGENTS.md or ~/.claude/CLAUDE.md). Read each one that exists, then check the diff for clear violations of the rules they state.

Only flag a violation when you can quote the exact rule and the exact line that breaks it \u2014 no style preferences, no vague "spirit of the doc" inferences. In the finding, name the convention-file path and quote the rule so the report can cite it. If no AGENTS.md / CLAUDE.md applies, return nothing for this angle.`,
  },
];

/** Verifier verdict ladder (three verdicts with definitions). */
const VERDICT_LADDER = `- **CONFIRMED** \u2014 can name the inputs/state that trigger it and the wrong output or crash. Quote the line.
- **PLAUSIBLE** \u2014 mechanism is real, trigger is uncertain (timing, env, config). State what would confirm it.
- **REFUTED** \u2014 factually wrong (code doesn't say that) or guarded elsewhere. Quote the line that proves it.`;

/** Recall-bias addendum shipped with the verdict ladder (PLAUSIBLE by default). */
const VERDICT_LADDER_RECALL = `**PLAUSIBLE by default** \u2014 do not refute a candidate for being "speculative" or "depends on runtime state" when the state is realistic: concurrency races, nil/undefined on a rare-but-reachable path (error handler, cold cache, missing optional field), falsy-zero treated as missing, off-by-one on a boundary the code does not exclude, retry storms / partial failures, regex/allowlist that lost an anchor. These are PLAUSIBLE.

**REFUTED** only when constructible from the code: factually wrong (quote the actual line); provably impossible (type/constant/invariant \u2014 show it); already handled in this diff (cite the guard); or pure style with no observable effect.`;

/** Precedence note appended to cleanup-angle finder prompts. */
const CLEANUP_PRECEDENCE = `Cleanup, altitude, and conventions candidates use the same \`file\`/\`line\`/\`summary\` shape; in \`failure_scenario\`, state the concrete cost (what is duplicated, wasted, harder to maintain, or which AGENTS.md / CLAUDE.md rule is broken) instead of a crash. Correctness bugs always outrank cleanup, altitude, and conventions findings when the output cap forces a cut.`;

/** Focus prompt for the sweep (gap-filling) phase. */
const SWEEP_GAP_FOCUS = `moved/extracted code that dropped a guard or anchor; second-tier footguns (dataclass default evaluated once, \`hash()\` non-determinism, lock-scope shrink, predicate methods with side effects); setup/teardown asymmetry in tests; config defaults flipped.`;

/** Meta fields (description / whenToUse / phases). */
const META_DESCRIPTION =
  "Workflow-backed code review \u2014 one finder agent per review angle, an independent verifier for every candidate, then a ranked, capped findings report.";
const META_WHEN_TO_USE =
  'Launched by the /code-review skill at high, xhigh, or max effort when workflows are enabled. Pass args as "<level> [target]" \u2014 level is high, xhigh, or max; target is an optional PR number, branch, ref range, path, or free-form review instructions (e.g. "only review src/foo.ts", "focus on error handling").';
const META_PHASES = [
  {
    title: "Scope",
    detail: "Summarize the host-supplied diff/files, applicable AGENTS.md / CLAUDE.md files, and conventions",
  },
  {
    title: "Find",
    detail: "One finder agent per review angle (correctness + cleanup + conventions), streaming into verify",
  },
  { title: "Verify", detail: "One independent verifier per candidate \u2014 CONFIRMED / PLAUSIBLE / REFUTED" },
  { title: "Sweep", detail: "Fresh finder hunting only for gaps (xhigh/max)" },
  { title: "Synthesize", detail: "Merge duplicates, rank, cap the report" },
];

/**
 * Generate a `code-review` workflow script — the multi-angle review topology + prompts.
 *
 * The script consumes a PreparedCodeReviewArgs object from host code. Git argv,
 * changed files, and patch text are computed before the workflow starts.
 */
export function generateCodeReviewWorkflow(): string {
  return `export const meta = {
  name: 'code-review',
  description: ${JSON.stringify(META_DESCRIPTION)},
  whenToUse: ${JSON.stringify(META_WHEN_TO_USE)},
  phases: ${JSON.stringify(META_PHASES)},
}

// code-review: Scope \u2192 pipeline(per-angle Find \u2192 Verify) \u2192 Sweep (xhigh/max) \u2192 Synthesize
// Effort parameterization mirrors the inline /code-review cells:
//   high  \u2192 3 correctness + 5 cleanup angles \xD7 6 \u2192 \u226410 findings
//   xhigh \u2192 5 correctness + 5 cleanup angles \xD7 8 \u2192 sweep \u2192 \u226415 findings
//   max   \u2192 same structure as xhigh (the API reasoning effort differs, not the fan-out)
const LEVEL_PARAMS = ${JSON.stringify(LEVEL_PARAMS)}
const SWEEP_MAX = ${SWEEP_MAX}

const PREPARED = args && typeof args === "object" ? args : null
if (!PREPARED || !PREPARED.diff || !Array.isArray(PREPARED.diff.files) || typeof PREPARED.diff.patch !== "string") {
  return { error: "code-review requires host-prepared args from prepareCodeReviewArgs(); refusing to let a model plan shell commands." }
}
const LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, PREPARED.level) ? PREPARED.level : "high"
const TARGET = typeof PREPARED.target === "string" ? PREPARED.target : ""
const USER_INSTRUCTIONS = typeof PREPARED.instructions === "string" ? PREPARED.instructions : ""
const HOST_DIFF = PREPARED.diff
const HOST_COMMANDS = Array.isArray(HOST_DIFF.commands) ? HOST_DIFF.commands : []
const HOST_FILES = HOST_DIFF.files
const HOST_PATCH = HOST_DIFF.patch
const P = LEVEL_PARAMS[LEVEL]

// Prompt fragments shared with the inline /code-review cells (one source of truth).
const CORRECTNESS_ANGLES = ${JSON.stringify(CORRECTNESS_ANGLES)}
const CLEANUP_ANGLES = ${JSON.stringify(CLEANUP_ANGLES)}
const VERDICT_LADDER = ${JSON.stringify(VERDICT_LADDER)}
const VERDICT_LADDER_RECALL = ${JSON.stringify(VERDICT_LADDER_RECALL)}
const CLEANUP_PRECEDENCE = ${JSON.stringify(CLEANUP_PRECEDENCE)}
const SWEEP_GAP_FOCUS = ${JSON.stringify(SWEEP_GAP_FOCUS)}

// \u2500\u2500\u2500 Schemas \u2500\u2500\u2500
const SCOPE_SCHEMA = {
  type: "object", required: ["summary"],
  properties: {
    claudeMdFiles: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
  },
}
const CANDIDATES_SCHEMA = {
  type: "object", required: ["candidates"],
  properties: {
    candidates: { type: "array", items: {
      type: "object", required: ["file", "summary", "failure_scenario"],
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        summary: { type: "string" },
        failure_scenario: { type: "string" },
      },
    }},
  },
}
const VERDICT_SCHEMA = {
  type: "object", required: ["verdict", "evidence"],
  properties: {
    verdict: { enum: ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    evidence: { type: "string" },
  },
}
const REPORT_SCHEMA = {
  type: "object", required: ["summary", "decisions"],
  properties: {
    summary: { type: "string" },
    decisions: { type: "array", items: {
      type: "object", required: ["index"],
      properties: {
        index: { type: "number", description: "the [i] label of a finding to keep in the report" },
        merge: { type: "array", items: { type: "number" }, description: "[i] labels of findings that describe the same root cause, folded into this one" },
      },
    }},
  },
}

// \u2500\u2500\u2500 Phase 0: Scope \u2500\u2500\u2500
phase("Scope")
if (!HOST_FILES || HOST_FILES.length === 0) {
  return { level: LEVEL, target: TARGET || undefined, summary: "No changes found to review.", findings: [], stats: { finders: 0, candidates: 0, verified: 0 } }
}
const commandDisplay = HOST_COMMANDS.map(c => c.display || (c.cmd + " " + (Array.isArray(c.args) ? c.args.join(" ") : ""))).join("\\n")
const scope = await agent(
  "Establish the scope of a code review from host-prepared read-only inputs.\\n\\n" +
  "The host already computed the git argv, changed files, and patch. Do NOT run shell commands and do NOT invent or modify command strings. Use read-only file tools only for extra context.\\n\\n" +
  (TARGET ? 'Review target / instructions (verbatim): "' + TARGET + '".\\n' : "") +
  (USER_INSTRUCTIONS ? "Additional user instructions: " + USER_INSTRUCTIONS + "\\n" : "") +
  "Host-computed changed files (" + HOST_FILES.length + "):\\n" + HOST_FILES.map(f => "  - " + f).join("\\n") + "\\n\\n" +
  "Host-computed git argv (diagnostic only, do not run):\\n" + (commandDisplay || "(none)") + "\\n\\n" +
  "Supplied patch:\\n\`\`\`diff\\n" + HOST_PATCH + "\\n\`\`\`\\n\\n" +
  "1. Summarize what changed in one paragraph.\\n" +
  "2. List the project convention files that apply to the changed files — AGENTS.md and CLAUDE.md (the repo-root AGENTS.md or CLAUDE.md, any AGENTS.md / CLAUDE.md / CLAUDE.local.md in a directory that is an ancestor of a changed file, plus any user-level convention file such as ~/.pi/AGENTS.md or ~/.claude/CLAUDE.md). Read each one that exists and note conventions a reviewer should know.\\n\\n" +
  "Structured output only.",
  { label: "scope", tier: "big", schema: SCOPE_SCHEMA }
)
if (!scope) {
  return { error: "Scope agent returned no result — cannot establish the review scope." }
}
log(LEVEL + " review: " + HOST_FILES.length + " changed files")

const claudeMdFiles = scope.claudeMdFiles || []
const SCOPE_BLOCK =
  "## Review scope\\n" +
  "Host-computed git argv (diagnostic only; reviewers must not run shell):\\n" + (commandDisplay || "(none)") + "\\n" +
  "Changed files (" + HOST_FILES.length + "):\\n" +
  HOST_FILES.map(f => "  - " + f).join("\\n") + "\\n" +
  "Applicable AGENTS.md / CLAUDE.md files (" + claudeMdFiles.length + "):\\n" +
  (claudeMdFiles.length > 0 ? claudeMdFiles.map(f => "  - " + f).join("\\n") : "  (none)") + "\\n\\n" +
  "## What changed\\n" + scope.summary + "\\n\\n" +
  "## Conventions\\n" + (scope.conventions || "(none noted)") + "\\n\\n" +
  "## Supplied patch\\n\`\`\`diff\\n" + HOST_PATCH + "\\n\`\`\`\\n" +
  (TARGET || USER_INSTRUCTIONS
    ? "\\n## User instructions (verbatim)\\n" + (USER_INSTRUCTIONS || TARGET) + "\\nHonor any scope restrictions or focus areas stated above — they take precedence over your angle's default breadth. Do not surface findings the instructions ask to skip.\\n"
    : "")

// \u2500\u2500\u2500 Prompts \u2500\u2500\u2500
const FINDER_PROMPT = f =>
  "## Code-review finder — " + f.label + "\\n\\n" + SCOPE_BLOCK + "\\n" +
  "Review the supplied patch and related files using ONLY read-only tools, through the lens of your assigned angle:\\n\\n" +
  f.text + "\\n" +
  (f.kind === "cleanup" ? CLEANUP_PRECEDENCE + "\\n" : "") +
  "Surface up to " + P.perAngle + " candidate findings, each with file, line, a one-line summary, and a concrete failure_scenario — the user-visible consequence (error, wrong output, data loss), not an intermediate state (value stale, set grows). " +
  "Pass every candidate with a nameable failure scenario through — do not silently drop half-believed candidates; an independent verifier judges them next. " +
  "If nothing qualifies, return an empty list.\\n\\nStructured output only."

const VERIFIER_PROMPT = c =>
  "## Code-review verifier\\n\\n" + SCOPE_BLOCK + "\\n" +
  "## Candidate finding\\n" +
  "File: " + c.file + (c.line != null ? ":" + c.line : "") + "\\n" +
  "Summary: " + c.summary + "\\n" +
  "Failure scenario: " + c.failure_scenario + "\\n\\n" +
  "Read the supplied patch and relevant file(s) with read-only tools, then return exactly one verdict:\\n\\n" +
  VERDICT_LADDER + "\\n\\n" + VERDICT_LADDER_RECALL + "\\n\\n" +
  "Structured output only. Evidence must quote or cite the relevant line(s)."

// \u2500\u2500\u2500 No pre-verify dedup \u2014 every candidate gets a verifier; dedup happens once at synthesis \u2500\u2500\u2500
let candidatesSeen = 0

function verifyCandidate(c) {
  const short = (c.file || "").split("/").pop()
  return agent(VERIFIER_PROMPT(c), { label: "verify:" + short, phase: "Verify", tier: "big", schema: VERDICT_SCHEMA })
    .then(v => (v ? { ...c, verdict: v.verdict, evidence: v.evidence } : null))
}

// \u2500\u2500\u2500 Find \u2192 Verify, no barrier between finders \u2500\u2500\u2500
const FINDERS = CORRECTNESS_ANGLES.slice(0, P.correctnessAngles)
  .map(a => ({ ...a, kind: "correctness" }))
  .concat(CLEANUP_ANGLES.map(a => ({ ...a, kind: "cleanup" })))

const finderResults = await pipeline(
  FINDERS,

  f => agent(FINDER_PROMPT(f), { label: f.label, phase: "Find", tier: "big", schema: CANDIDATES_SCHEMA }).then(r => {
    if (!r) return { finder: f, candidates: [] }
    log(f.label + ": " + r.candidates.length + " candidates")
    return { finder: f, candidates: r.candidates.slice(0, P.perAngle) }
  }),

  result => {
    candidatesSeen += result.candidates.length
    return parallel(result.candidates.map(c => () => verifyCandidate({ ...c, kind: result.finder.kind })))
  }
)

let verified = finderResults.flat().filter(Boolean)

// \u2500\u2500\u2500 Sweep (xhigh/max): one fresh finder hunting only for gaps \u2500\u2500\u2500
if (P.sweep) {
  phase("Sweep")
  const knownBlock = verified.length > 0
    ? verified.map(c => "- " + c.file + (c.line != null ? ":" + c.line : "") + " \u2014 " + c.summary).join("\\n")
    : "(none)"
  const sweep = await agent(
    "## Code-review sweep \u2014 gaps only\\n\\n" + SCOPE_BLOCK + "\\n" +
    "## Already-found candidates (do NOT re-derive or re-confirm these)\\n" + knownBlock + "\\n\\n" +
    "Re-read the diff and the enclosing functions looking ONLY for defects not already listed. " +
    "Focus on what the first pass tends to miss: " + SWEEP_GAP_FOCUS + "\\n\\n" +
    "Surface up to " + SWEEP_MAX + " additional candidates. If nothing new, return an empty list \u2014 do not pad.\\n\\nStructured output only.",
    { label: "sweep", phase: "Sweep", tier: "big", schema: CANDIDATES_SCHEMA }
  )
  if (sweep && sweep.candidates.length > 0) {
    const sliced = sweep.candidates.slice(0, SWEEP_MAX)
    candidatesSeen += sliced.length
    log("sweep: " + sliced.length + " candidates")
    const sweepVerified = await parallel(sliced.map(c => () => verifyCandidate({ ...c, kind: "correctness" })))
    verified = verified.concat(sweepVerified.filter(Boolean))
  }
}

const surviving = verified.filter(c => c.verdict !== "REFUTED")
const refuted = verified.filter(c => c.verdict === "REFUTED")
log("Verify done: " + verified.length + " verified \u2192 " + surviving.length + " kept, " + refuted.length + " refuted")

const stats = {
  level: LEVEL,
  finders: FINDERS.length,
  candidates: candidatesSeen,
  verified: verified.length,
  refuted: refuted.length,
}

if (surviving.length === 0) {
  return {
    level: LEVEL, target: TARGET || undefined,
    summary: "No findings survived verification.",
    findings: [],
    stats,
  }
}

// \u2500\u2500\u2500 Synthesize: rank, merge semantic dupes, cap \u2500\u2500\u2500
phase("Synthesize")
// Correctness bugs outrank cleanup findings when the cap forces a cut;
// CONFIRMED outranks PLAUSIBLE within each group.
const rank = c => (c.kind === "cleanup" ? 2 : 0) + (c.verdict === "PLAUSIBLE" ? 1 : 0)
const ranked = surviving.slice().sort((a, b) => rank(a) - rank(b))
const block = ranked.map((c, i) =>
  "### [" + i + "] " + c.file + (c.line != null ? ":" + c.line : "") + " (" + c.verdict + (c.kind === "cleanup" ? ", cleanup" : "") + ")\\n" +
  c.summary + "\\nFailure scenario: " + c.failure_scenario + "\\nVerifier evidence: " + c.evidence + "\\n"
).join("\\n")

const report = await agent(
  "## Synthesis: final code-review report\\n\\n" +
  ranked.length + " findings survived independent verification (" + LEVEL + "-effort review). They are numbered [0]-[" + (ranked.length - 1) + "] below.\\n\\n" + block + "\\n" +
  "## Instructions\\n" +
  "Return decisions about findings BY INDEX \u2014 never re-emit finding text.\\n" +
  "1. For each distinct defect, emit one decision with its index. When several findings describe the same defect (same root cause), keep one entry and list the others in its merge array.\\n" +
  "2. Order decisions most-severe first. Correctness bugs always outrank cleanup findings.\\n" +
  "3. Keep at most " + P.maxFindings + " decisions; omit the least severe beyond the cap.\\n" +
  "4. Write a 2-3 sentence summary of the review.\\n\\nStructured output only.",
  { label: "synthesize", tier: "big", schema: REPORT_SCHEMA }
)

// Assembler invariants:
//   1. No silent drops while there is room: every verified finding either appears
//      (as primary or merge note) or is omitted only because the cap is full.
//   2. The displayed primary is the synthesizer's choice (d.index) \u2014 it picks the
//      best-described representative; we only escalate the verdict label when a
//      merged member is CONFIRMED.
//   3. The summary describes the report actually returned.
const decisions = report && Array.isArray(report.decisions) ? report.decisions : []
const valid = i => Number.isInteger(i) && i >= 0 && i < ranked.length
const loc = c => c.file + (c.line != null ? ":" + c.line : "")
const seen = new Set()
const claim = i => (valid(i) && !seen.has(i) ? (seen.add(i), true) : false)
const findings = []
for (const d of decisions) {
  if (findings.length >= P.maxFindings) break
  if (!claim(d.index)) continue
  const c = ranked[d.index]
  const merged = (Array.isArray(d.merge) ? d.merge : []).filter(claim).map(i => ranked[i])
  const verdict = merged.some(m => m.verdict === "CONFIRMED") ? "CONFIRMED" : c.verdict
  const also = merged.length > 0 ? " [same root cause also at: " + merged.map(loc).join(", ") + "]" : ""
  findings.push({ file: c.file, line: c.line, summary: c.summary + also, failure_scenario: c.failure_scenario, verdict })
}
const usedDecisions = findings.length > 0
let backfilled = 0
for (let i = 0; i < ranked.length && findings.length < P.maxFindings; i++) {
  if (seen.has(i)) continue
  const c = ranked[i]
  findings.push({ file: c.file, line: c.line, summary: c.summary, failure_scenario: c.failure_scenario, verdict: c.verdict })
  backfilled++
}
const summary = usedDecisions && report
  ? report.summary + (backfilled > 0 ? " (" + backfilled + " additional verified finding" + (backfilled === 1 ? "" : "s") + " appended unmerged.)" : "")
  : "Synthesis step was skipped or its decisions were unusable \u2014 returning verified findings ranked, unmerged."

return {
  level: LEVEL,
  target: TARGET || undefined,
  summary,
  findings,
  refuted: refuted.map(c => ({ file: c.file, line: c.line, summary: c.summary })),
  stats: { ...stats, reported: findings.length },
}`;
}
