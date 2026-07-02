/**
 * Conductor finalization gate — repair/delivery readiness evaluation.
 *
 * This module decides whether a conductor run's worktree is ready to be
 * finalized (PR shipped / branch delivered). It is split into a pure
 * evaluator (`evaluateFinalization`) and an injectable shell-backed collector
 * (`collectFinalizationState`) so the decision logic is testable without
 * touching git or GitHub.
 *
 * The evaluator is intentionally strict but forgiving on transient artifacts:
 * untracked/modified paths under `.issue-delivery/` are treated as transient
 * porcelain and ignored when deciding
 * whether the worktree is "clean enough" to ship. A rename/copy is only ignored
 * when *both* sides of the rename live under a transient prefix — if a real
 * source file is moved into (or out of) one of those prefixes, that blocks
 * finalization.
 *
 * Evaluation rules (in order):
 *  1. Worktree clean modulo transient prefixes (and extra `ignorePathPrefixes`).
 *  2. `currentBranch` must match `expectedBranch` when the latter is provided.
 *  3. At least one commit beyond `baseRef` when `baseRef` is provided.
 *  4. Branch must be pushed to its upstream/remote. This is *required*, not
 *     optional: an absent `pushedUpstream` is treated as unverified and
 *     blocks `completed`. When SHAs are available, local and remote HEAD must
 *     match.
 *  5. `prHeadSha` must equal `headSha` when provided.
 *  6. GitHub checks must be `success` (green) or `pending`/`neutral` (clearly
 *     pending). `unknown` is NOT clearly pending — it surfaces as
 *     `needs-human` with an actionable `gh`/auth/checks command so the gate
 *     cannot silently pass without verifying checks.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConductorRunStatus } from "./conductor-types.js";

const execFileAsync = promisify(execFile);

/** Statuses a finalization check can yield. */
export type FinalizationStatus = "completed" | "needs-finalize" | "finalizing" | "needs-human" | "failed";

/**
 * Shaped result returned by the finalization gate. Mirrors
 * {@link ConductorRunStatus} but uses the finalization-specific status union
 * and always carries an actionable `nextAction`.
 */
export interface FinalizationCheckResult {
  status: FinalizationStatus;
  reason: string;
  nextAction: string;
  /** Optional human-readable extra context (e.g. failing check names). */
  details?: string;
  /** Resolved to a {@link ConductorRunStatus}-compatible record. */
  toRunStatus?: ConductorRunStatus;
}

/**
 * Inputs the pure evaluator consumes.
 *
 * `expectedBranch` / `baseRef` / `prHeadSha` are only enforced when provided.
 * `pushedUpstream` is *required* for `completed`: `undefined` is treated as
 * "unverified" and blocks completion (it does not silently pass).
 */
export interface FinalizationInput {
  /** Current working tree status (from `git status --porcelain`). */
  porcelain: string;
  /** Current branch name (from `git rev-parse --abbrev-ref HEAD`). */
  currentBranch?: string;
  /** Branch the run is expected to be on; enforced when provided. */
  expectedBranch?: string;
  /** Base ref to compare commits against (e.g. `main` or `origin/main`). */
  baseRef?: string;
  /** Number of commits on the branch beyond `baseRef`. */
  commitsBeyondBase?: number;
  /**
   * Whether an upstream/remote tracking HEAD exists and matches local HEAD.
   * Required for `completed`: `undefined` blocks completion as unverified.
   */
  pushedUpstream?: boolean;
  /** Remote head SHA, when known. Compared to local HEAD when provided. */
  remoteHeadSha?: string;
  /** Local HEAD commit SHA. */
  headSha?: string;
  /** Expected PR head SHA; enforced as an exact match when provided. */
  prHeadSha?: string;
  /** Aggregate GitHub checks state. */
  checksState?: "success" | "pending" | "failure" | "neutral" | "unknown";
  /** Names of failing GitHub checks, when available. */
  failingChecks?: string[];
  /** Optional set of paths to additionally ignore when checking cleanliness. */
  ignorePathPrefixes?: string[];
}

/** Transient porcelain path prefixes that never block finalization. */
const TRANSIENT_IGNORE_PREFIXES = [".issue-delivery/"];

/**
 * A parsed line of `git status --porcelain`. Renames/copies carry both the
 * source (`orig`) and destination (`dest`) path so the cleanliness check can
 * block when a real file is moved into or out of a transient prefix.
 */
interface PorcelainEntry {
  /** Destination path (always set). */
  dest: string;
  /** Source path for renames/copies; undefined for plain add/modify/delete. */
  orig?: string;
}

/**
 * Parse `git status --porcelain` output into entries, stripping the leading
 * "XY " status flags. Handles renames (`R`/`C`) which use the form
 * `orig -> new` — both sides are retained so a rename that touches a real
 * source file is not silently treated as transient.
 */
function parsePorcelain(porcelain: string): PorcelainEntry[] {
  const lines = porcelain.split("\n");
  const entries: PorcelainEntry[] = [];
  for (const line of lines) {
    if (!line) continue;
    // Porcelain v1: first two chars are status, third is a space, then path.
    if (line.length < 4) continue;
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    const unquote = (p: string): string => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
    if (arrow >= 0) {
      const orig = unquote(path.slice(0, arrow));
      const dest = unquote(path.slice(arrow + 4));
      entries.push({ dest, orig });
    } else {
      entries.push({ dest: unquote(path) });
    }
  }
  return entries;
}

/** All paths a porcelain entry participates in. */
function entryPaths(entry: PorcelainEntry): string[] {
  return entry.orig !== undefined ? [entry.orig, entry.dest] : [entry.dest];
}

function isIgnoredPath(path: string, extraPrefixes: readonly string[] = []): boolean {
  for (const prefix of TRANSIENT_IGNORE_PREFIXES) {
    if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return true;
  }
  for (const prefix of extraPrefixes) {
    if (prefix === "") continue;
    if (path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) return true;
  }
  return false;
}

/**
 * A porcelain entry blocks finalization when *any* path it participates in
 * is non-transient. A rename `src/important.ts -> .issue-delivery/important.ts` therefore
 * blocks, because the source path is a real file being removed/renamed.
 */
function entryIsDirty(entry: PorcelainEntry, extraPrefixes: readonly string[]): boolean {
  return entryPaths(entry).some((p) => !isIgnoredPath(p, extraPrefixes));
}

/** Build a {@link FinalizationCheckResult} with a matching `toRunStatus`. */
function result(
  status: FinalizationStatus,
  reason: string,
  nextAction: string,
  details?: string,
): FinalizationCheckResult {
  return {
    status,
    reason,
    nextAction,
    details,
    toRunStatus: { status, reason, nextAction, details },
  };
}

/**
 * Pure evaluation of finalization readiness. See the module docstring for the
 * full rule list. Returns a {@link FinalizationCheckResult} with an actionable
 * `nextAction`.
 */
export function evaluateFinalization(input: FinalizationInput): FinalizationCheckResult {
  const extra = input.ignorePathPrefixes ?? [];
  const entries = parsePorcelain(input.porcelain ?? "");
  const dirty = entries.filter((e) => entryIsDirty(e, extra));

  if (dirty.length > 0) {
    const sample = dirty
      .slice(0, 5)
      .flatMap((e) => entryPaths(e))
      .join(", ");
    const reason = `Worktree has ${dirty.length} uncommitted change(s): ${sample}`;
    return result(
      "needs-finalize",
      reason,
      "Commit or stash the changes, then re-run finalization.",
      dirty.flatMap((e) => entryPaths(e)).join("\n"),
    );
  }

  if (input.expectedBranch !== undefined) {
    if (input.currentBranch === undefined) {
      return result(
        "needs-human",
        `Expected branch '${input.expectedBranch}' but current branch could not be determined.`,
        `Verify the worktree is on branch '${input.expectedBranch}'.`,
      );
    }
    if (input.currentBranch !== input.expectedBranch) {
      return result(
        "needs-human",
        `Expected branch '${input.expectedBranch}' but currently on '${input.currentBranch}'.`,
        `Switch to branch '${input.expectedBranch}' before finalizing.`,
      );
    }
  }

  if (input.baseRef !== undefined) {
    const beyond = input.commitsBeyondBase ?? 0;
    if (beyond < 1) {
      return result(
        "needs-finalize",
        `No commits beyond base '${input.baseRef}'; nothing to deliver.`,
        `Commit your work on top of '${input.baseRef}' before finalizing.`,
      );
    }
  }

  // Push verification is REQUIRED for completion. `undefined` means the
  // collector could not verify upstream tracking — treat as unverified rather
  // than silently passing.
  if (input.pushedUpstream !== true) {
    const branch = input.currentBranch ?? "HEAD";
    if (input.pushedUpstream === false) {
      return result(
        "needs-finalize",
        `Branch '${branch}' is not pushed to its upstream/remote.`,
        `Run: git push -u origin ${branch}`,
      );
    }
    return result(
      "needs-human",
      `Could not verify upstream/remote push status for branch '${branch}'.`,
      `Set up upstream tracking and push: git push -u origin ${branch}`,
    );
  }

  if (input.headSha && input.remoteHeadSha && input.headSha !== input.remoteHeadSha) {
    return result(
      "needs-finalize",
      `Local HEAD (${input.headSha.slice(0, 7)}) differs from remote HEAD (${input.remoteHeadSha.slice(0, 7)}).`,
      `Run: git push origin ${input.currentBranch ?? "HEAD"}`,
    );
  }

  if (input.prHeadSha !== undefined) {
    if (input.headSha === undefined) {
      return result(
        "needs-human",
        `PR head SHA '${input.prHeadSha.slice(0, 7)}' was provided but local HEAD is unknown.`,
        "Re-resolve local HEAD and re-run finalization.",
      );
    }
    if (input.headSha !== input.prHeadSha) {
      return result(
        "needs-human",
        `PR head SHA '${input.prHeadSha.slice(0, 7)}' does not match local HEAD '${input.headSha.slice(0, 7)}'.`,
        "Re-push the branch or update the PR to match local HEAD.",
      );
    }
  }

  // GitHub checks. Only `success`, `pending`, and `neutral` are acceptable
  // states for proceeding. `unknown` is NOT clearly pending — it usually
  // means `gh` is missing/unauthenticated or the output was unparsable, so
  // we must not let the gate pass without verification.
  const checks = input.checksState ?? "unknown";
  if (checks === "failure") {
    const failing =
      input.failingChecks && input.failingChecks.length > 0 ? input.failingChecks.join(", ") : "one or more checks";
    return result(
      "needs-finalize",
      `GitHub checks failed: ${failing}.`,
      "Inspect the failing checks, fix the cause, and push a new commit.",
      input.failingChecks?.join("\n"),
    );
  }

  if (checks === "unknown") {
    // Could not verify checks — require human action to install/authenticate
    // `gh` or inspect checks manually. Never silently complete.
    return result(
      "needs-human",
      "GitHub checks state could not be verified (gh unavailable, unauthenticated, or unparsable).",
      "Verify checks: ensure `gh auth status` is authenticated, then run `gh pr checks --json name,state`.",
    );
  }

  if (checks === "pending" || checks === "neutral") {
    return result(
      "finalizing",
      `GitHub checks are ${checks}; proceeding to finalize while clearly pending.`,
      "Monitor checks; finalize once they report success.",
    );
  }

  // checks === "success"
  return result("completed", "Worktree clean, branch pushed, and checks green.", "Ship the PR / merge the branch.");
}

/** Injectable shell runner — same shape as {@link CodeReviewExecRunner}. */
export type FinalizationShellRunner = (
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer: number; shell: false },
) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

const DEFAULT_RUNNER: FinalizationShellRunner = async (file, args, options) => {
  return execFileAsync(file, args, options);
};

/**
 * Options controlling what the collector gathers and what constraints it
 * enforces. Every field is optional; absent fields are not enforced (except
 * upstream push, which the evaluator always requires).
 */
export interface CollectFinalizationOptions {
  expectedBranch?: string;
  baseRef?: string;
  prHeadSha?: string;
  ignorePathPrefixes?: string[];
  /**
   * When true, query GitHub checks via `gh pr checks --json`. Requires `gh`
   * to be authenticated. Defaults to true.
   */
  queryChecks?: boolean;
}

async function runGit(cwd: string, args: string[], runner: FinalizationShellRunner): Promise<string> {
  const { stdout } = await runner("git", args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER, shell: false });
  return stdout.trim();
}

/**
 * Run `git` and return stdout with ONLY trailing newlines removed. Leading
 * whitespace is preserved — this is essential for `git status --porcelain`,
 * whose first column may be a space (e.g. ` M path`); a `.trim()` would
 * collapse ` M path` into `M path`, shifting the path by one character and
 * breaking the transient-prefix (` .issue-delivery/`) check.
 */
function trimEnd(value: string): string {
  return value.replace(/\r?\n+$/, "");
}

async function runGitRaw(cwd: string, args: string[], runner: FinalizationShellRunner): Promise<string> {
  const { stdout } = await runner("git", args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER, shell: false });
  return trimEnd(stdout);
}

/**
 * Run `gh` and return its stdout, capturing output even on non-zero exit.
 *
 * `gh pr checks` uses exit codes to signal aggregate state: it exits 0 when
 * all checks pass, and non-zero (e.g. exit 8 for pending, exit 7/9 for
 * failures) otherwise. The structured JSON we requested is still printed on
 * stdout, so we must parse it regardless of the exit code.
 *
 * Throws only when we cannot obtain usable stdout at all — i.e. when `gh` is
 * missing (`ENOENT`), not authenticated, or the error carries no stdout.
 * Callers translate those throws into `checksState: "unknown"`.
 */
async function runGh(cwd: string, args: string[], runner: FinalizationShellRunner): Promise<string> {
  try {
    const { stdout } = await runner("gh", args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER, shell: false });
    return stdout.trim();
  } catch (err) {
    // `gh pr checks` legitimately exits non-zero for pending/failing checks
    // but still emits JSON on stdout. execFile rejects with an error that has
    // `stdout`/`stderr` properties; surface stdout so the caller can parse it.
    const maybe = err as { stdout?: string; stderr?: string; code?: string | number };
    const out = typeof maybe.stdout === "string" ? maybe.stdout.trim() : "";
    if (out) return out;
    // No stdout to salvage — distinguish missing tool from auth/runtime error.
    throw err;
  }
}

/**
 * Parse `gh pr checks --json name,state` output into a checks aggregate.
 * Returns `"unknown"` if the output cannot be parsed.
 */
function aggregateChecks(json: string): {
  state: "success" | "pending" | "failure" | "neutral" | "unknown";
  failing: string[];
} {
  if (!json) return { state: "unknown", failing: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { state: "unknown", failing: [] };
  }
  if (!Array.isArray(parsed)) return { state: "unknown", failing: [] };
  const failing: string[] = [];
  let anyPending = false;
  let anySuccess = false;
  let anyNeutral = false;
  for (const entry of parsed as Array<Record<string, unknown>>) {
    const name = typeof entry.name === "string" ? entry.name : "(unnamed)";
    const state = typeof entry.state === "string" ? entry.state.toLowerCase() : "";
    if (state === "failure" || state === "error" || state === "cancelled") {
      failing.push(name);
    } else if (state === "pending" || state === "queued" || state === "in_progress" || state === "waiting") {
      anyPending = true;
    } else if (state === "success" || state === "pass" || state === "passed") {
      anySuccess = true;
    } else if (state === "neutral" || state === "skipped") {
      anyNeutral = true;
    }
  }
  if (failing.length > 0) return { state: "failure", failing };
  if (anyPending) return { state: "pending", failing };
  if (anySuccess && !anyPending) return { state: "success", failing };
  if (anyNeutral) return { state: "neutral", failing };
  return { state: "unknown", failing };
}

/**
 * Shell-backed collector: gathers all git/gh state needed by the pure
 * evaluator and returns a {@link FinalizationInput}.
 *
 * The runner is injectable for testing. When omitted, the real
 * `child_process.execFile` is used. Git failures during collection surface
 * as `pushedUpstream: undefined` / `commitsBeyondBase: undefined` /
 * `checksState: "unknown"` rather than throwing, so the evaluator can decide
 * the right status; {@link checkFinalization} wraps this so a hard collector
 * failure becomes a `failed` result with an actionable command.
 */
export async function collectFinalizationState(
  cwd: string,
  opts: CollectFinalizationOptions = {},
  runner: FinalizationShellRunner = DEFAULT_RUNNER,
): Promise<FinalizationInput> {
  // Core git state — if these fail the worktree is unusable; let the caller
  // (checkFinalization) translate that into a `failed` result. NOTE: porcelain
  // must preserve leading whitespace (a leading space means "unstaged
  // modification"), so it uses runGitRaw (trimEnd only), NOT runGit (which
  // would left-trim and corrupt ` M path` into `M path`).
  const porcelain = await runGitRaw(cwd, ["status", "--porcelain"], runner);
  const currentBranch = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], runner);
  const headSha = await runGit(cwd, ["rev-parse", "HEAD"], runner);

  let commitsBeyondBase: number | undefined;
  if (opts.baseRef) {
    try {
      const count = await runGit(cwd, ["rev-list", "--count", `${opts.baseRef}..HEAD`], runner);
      commitsBeyondBase = Number.parseInt(count, 10) || 0;
    } catch {
      commitsBeyondBase = undefined;
    }
  }

  let pushedUpstream: boolean | undefined;
  let remoteHeadSha: string | undefined;
  try {
    const upstream = await runGit(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"], runner);
    if (upstream && !upstream.includes("HEAD")) {
      try {
        remoteHeadSha = await runGit(cwd, ["rev-parse", "@{upstream}"], runner);
        pushedUpstream = remoteHeadSha !== undefined && remoteHeadSha === headSha;
      } catch {
        pushedUpstream = undefined;
        remoteHeadSha = undefined;
      }
    } else {
      pushedUpstream = false;
    }
  } catch {
    // No upstream configured — not pushed.
    pushedUpstream = false;
  }

  let checksState: FinalizationInput["checksState"] = "unknown";
  let failingChecks: string[] | undefined;
  const queryChecks = opts.queryChecks !== false;
  if (queryChecks) {
    try {
      // runGh returns stdout even when `gh pr checks` exits non-zero (pending
      // = exit 8, failures = exit 7/9). It only throws when `gh` is missing,
      // unauthenticated, or no stdout is salvageable — those become `unknown`.
      const json = await runGh(cwd, ["pr", "checks", "--json", "name,state"], runner);
      const agg = aggregateChecks(json);
      checksState = agg.state;
      failingChecks = agg.failing.length > 0 ? agg.failing : undefined;
    } catch {
      checksState = "unknown";
      failingChecks = undefined;
    }
  }

  return {
    porcelain,
    currentBranch: currentBranch || undefined,
    expectedBranch: opts.expectedBranch,
    baseRef: opts.baseRef,
    commitsBeyondBase,
    pushedUpstream,
    remoteHeadSha,
    headSha,
    prHeadSha: opts.prHeadSha,
    checksState,
    failingChecks,
    ignorePathPrefixes: opts.ignorePathPrefixes,
  };
}

/**
 * Convenience: collect state and evaluate it in one call. Collector failures
 * (e.g. `git` missing, not a git repo) are translated into a `failed`
 * {@link FinalizationCheckResult} with an actionable `nextAction` rather than
 * rejecting — per the contract, results always use
 * completed/needs-finalize/finalizing/needs-human/failed.
 */
export async function checkFinalization(
  cwd: string,
  opts: CollectFinalizationOptions = {},
  runner: FinalizationShellRunner = DEFAULT_RUNNER,
): Promise<FinalizationCheckResult> {
  let input: FinalizationInput;
  try {
    input = await collectFinalizationState(cwd, opts, runner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return result(
      "failed",
      `Finalization collector failed to gather git/gh state: ${msg}`,
      "Ensure the worktree is a git repository and git/gh are installed and on PATH; then re-run finalization.",
    );
  }
  return evaluateFinalization(input);
}

/**
 * Inputs for the bounded finalization/nudge loop.
 */
export interface FinalizationLoopOptions {
  /**
   * Function that performs a finalization check. Defaults to calling
   * {@link checkFinalization} when `cwd`/`opts` are supplied via closure.
   */
  check: () => Promise<FinalizationCheckResult>;
  /**
   * Optional nudge action invoked when a check returns `needs-finalize` or
   * `finalizing` — e.g. re-push, wait, or trigger CI. Should return a short
   * human-readable summary of what it did.
   */
  nudge?: (result: FinalizationCheckResult) => Promise<string | undefined>;
  /** Maximum number of nudge attempts. Defaults to 3. Must be >= 0. */
  maxNudges?: number;
}

/**
 * Run the finalization/nudge loop, bounded by `maxNudges`.
 *
 * Each iteration:
 *  1. Runs `check()`.
 *  2. If the result is terminal (`completed`, `failed`, `needs-human`) it is
 *     returned immediately.
 *  3. If the result is `needs-finalize` or `finalizing` and nudges remain,
 *     `nudge()` is invoked (if provided) and the loop continues.
 *  4. Once nudges are exhausted, an unresolved `needs-finalize` or
 *     `finalizing` is downgraded to `needs-human` with the accumulated
 *     context.
 */
export async function runFinalizationLoop(opts: FinalizationLoopOptions): Promise<FinalizationCheckResult> {
  const maxNudges = Math.max(0, opts.maxNudges ?? 3);
  let last: FinalizationCheckResult | null = null;
  const nudgeLog: string[] = [];

  for (let attempt = 0; attempt <= maxNudges; attempt++) {
    const result = await opts.check();
    last = result;

    if (result.status === "completed" || result.status === "failed" || result.status === "needs-human") {
      return result;
    }

    // `needs-finalize` or `finalizing` — try a nudge if we have budget.
    if (attempt < maxNudges && opts.nudge) {
      try {
        const summary = await opts.nudge(result);
        if (summary) nudgeLog.push(`nudge #${attempt + 1}: ${summary}`);
      } catch (err) {
        nudgeLog.push(`nudge #${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Exhausted nudges — downgrade to needs-human with context.
  const lastStatus = last?.status ?? "needs-finalize";
  const baseReason = last?.reason ?? "Finalization did not converge.";
  const baseAction = last?.nextAction ?? "Investigate the worktree state manually.";
  const context = nudgeLog.length > 0 ? `\nNudge history:\n- ${nudgeLog.join("\n- ")}` : "";
  const reason = `Unresolved '${lastStatus}' after ${maxNudges} nudge(s): ${baseReason}${context}`;
  const nextAction = `Manual intervention required: ${baseAction}`;
  return result("needs-human", reason, nextAction, context.trim() || undefined);
}
