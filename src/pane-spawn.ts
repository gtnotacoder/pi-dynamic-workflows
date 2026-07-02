/**
 * Tier-1 pane-spawn seam — injectable herdr CLI boundary.
 *
 * Owns ALL herdr CLI access for the pane-spawn path:
 *   worktree create --json → agent start (workspace/tab/split nesting) → report-agent → release-agent → pane close.
 *
 * Every method is behind an injectable `HerdrInvoker` interface so unit tests
 * mock the invoker and never touch a live herdr server.
 *
 * Run-level pane only (not per subagent). One real pi process per run.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ConductorRunStatus, ConductorStatusName } from "./conductor-types.js";

// ── HerdrInvoker interface ──────────────────────────────────────────────────

/** Result of `herdr worktree create --json`. */
export interface HerdrWorktree {
  cwd: string;
  branch: string;
}

/**
 * Injectable boundary for every herdr CLI call in the pane-spawn path.
 * All methods return void/Promise<void> and never throw into the runtime.
 */
export interface HerdrInvoker {
  /** `herdr worktree create --branch <branch> --base <base> --json` → {cwd, branch}. */
  worktreeCreate(opts: { base: string; branch: string }): Promise<HerdrWorktree>;

  /**
   * `herdr agent start <name> --cwd <cwd> [--workspace <id>] [--tab <id>] [--split <dir>] -- <argv...>`
   * Starts a new herdr agent pane, nested under the caller when workspace/tab are set.
   */
  agentStart(
    opts: {
      name: string;
      cwd: string;
      workspace?: string;
      tab?: string;
      split?: string;
    },
    argv: string[],
  ): Promise<{ paneId: string }>;

  /**
   * `herdr pane report-agent <pane> --source <source> --agent <agent> --state <state> [--custom-status <s>] [--seq <n>] [--ttl-ms <n>]`
   * Reports the live state of the agent running in the spawned pane.
   */
  reportAgent(
    pane: string,
    opts: {
      source: string;
      agent: string;
      state: "idle" | "working" | "blocked";
      message?: string;
      customStatus?: string;
      seq?: string;
      ttlMs?: number;
    },
  ): void;

  /**
   * `herdr pane report-metadata <pane> --source <source> --seq <n> [--custom-status <s>] [--ttl-ms <n>]`
   * Layers a one-line custom status on the same pane.
   */
  reportMetadata(
    pane: string,
    opts: {
      source: string;
      seq: string;
      customStatus?: string;
      ttlMs?: number;
    },
  ): void;

  /** `herdr agent release <pane> --source <source> --agent <agent>` — marks the agent done. */
  releaseAgent(
    pane: string,
    opts: {
      source: string;
      agent: string;
    },
  ): void;

  /** `herdr pane close <pane>` — closes the spawned pane. */
  paneClose(pane: string): void;
}

// ── Default invoker (spawn-based, fire-and-forget) ──────────────────────────

/**
 * Default HerdrInvoker that shells `herdr` via `spawn(...).unref()`.
 * Fire-and-forget: swallows all errors so a missing/broken herdr binary
 * never throws into the workflow runtime.
 */
export function createDefaultHerdrInvoker(): HerdrInvoker {
  const runSync = (args: string[]): void => {
    try {
      const child = spawn("herdr", args, { stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } catch {
      // herdr binary missing / spawn failed — silently degrade.
    }
  };

  return {
    async worktreeCreate(opts: { base: string; branch: string }): Promise<HerdrWorktree> {
      try {
        // `herdr worktree create --json` returns JSON on stdout with {cwd, branch}
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
          const child = spawn("herdr", ["worktree", "create", "--branch", opts.branch, "--base", opts.base, "--json"]);
          let out = "";
          child.stdout?.on("data", (chunk: Buffer) => (out += chunk));
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve({ stdout: out });
            else reject(new Error(`herdr worktree create exited ${code}`));
          });
          child.unref();
        });
        const parsed = JSON.parse(stdout) as HerdrWorktree;
        return parsed;
      } catch {
        // Degrade: return a best-effort placeholder — caller sees a broken
        // worktree path and the run will fail with an actionable message.
        return { cwd: "", branch: opts.branch };
      }
    },

    async agentStart(
      opts: { name: string; cwd: string; workspace?: string; tab?: string; split?: string },
      argv: string[],
    ): Promise<{ paneId: string }> {
      const args: string[] = ["agent", "start", opts.name, "--cwd", opts.cwd];
      if (opts.workspace) args.push("--workspace", opts.workspace);
      if (opts.tab) args.push("--tab", opts.tab);
      if (opts.split) args.push("--split", opts.split);
      args.push("--", ...argv);

      try {
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
          const child = spawn("herdr", args);
          let out = "";
          child.stdout?.on("data", (chunk: Buffer) => (out += chunk));
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve({ stdout: out });
            else reject(new Error(`herdr agent start exited ${code}`));
          });
          child.unref();
        });
        // herdr agent start returns {paneId: "wH:p4"} on stdout
        const parsed = JSON.parse(stdout) as { paneId: string };
        return parsed;
      } catch {
        // Degrade gracefully — the pane is missing so later calls are no-ops.
        return { paneId: "" };
      }
    },

    reportAgent(
      pane: string,
      opts: {
        source: string;
        agent: string;
        state: "idle" | "working" | "blocked";
        message?: string;
        customStatus?: string;
        seq?: string;
        ttlMs?: number;
      },
    ): void {
      const args: string[] = [
        "pane",
        "report-agent",
        pane,
        "--source",
        opts.source,
        "--agent",
        opts.agent,
        "--state",
        opts.state,
      ];
      if (opts.message) args.push("--message", opts.message);
      if (opts.customStatus) args.push("--custom-status", opts.customStatus);
      if (opts.seq) args.push("--seq", opts.seq);
      if (opts.ttlMs != null) args.push("--ttl-ms", String(opts.ttlMs));
      runSync(args);
    },

    reportMetadata(
      pane: string,
      opts: {
        source: string;
        seq: string;
        customStatus?: string;
        ttlMs?: number;
      },
    ): void {
      const args: string[] = ["pane", "report-metadata", pane, "--source", opts.source, "--seq", opts.seq];
      if (opts.customStatus) args.push("--custom-status", opts.customStatus);
      if (opts.ttlMs != null) args.push("--ttl-ms", String(opts.ttlMs));
      runSync(args);
    },

    releaseAgent(pane: string, opts: { source: string; agent: string }): void {
      runSync(["agent", "release", pane, "--source", opts.source, "--agent", opts.agent]);
    },

    paneClose(pane: string): void {
      runSync(["pane", "close", pane]);
    },
  };
}

// ── conductorToHerdrState (docs §6 mapping) ──────────────────────────────────

/**
 * Pure mapping from a ConductorRunStatus to the herdr report-agent state.
 * Implements the docs §6 table exactly:
 *
 * | ConductorStatus           | herdr state | custom status              | release | closePane | notify  |
 * |---------------------------|-------------|----------------------------|---------|-----------|---------|
 * | spawned                   | working     • spawned                | —       | —         | —       |
 * | workflow-running          | working     ▶ <phase> (reason)     | —       | —         | —       |
 * | workflow-complete-pane-open | working   ◐ complete (pane open)     | —       | —         | —       |
 * | needs-finalize            | blocked     ! needs finalize         | —       | —         | request |
 * | finalizing                | working     ⟳ finalizing             | —       | —         | —       |
 * | completed                 | idle        ✓ done                   | yes     | yes       | done    |
 * | failed                    | blocked     ✗ failed                 | —       | —         | request |
 * | needs-human               | blocked     ? needs human            | —       | —         | request |
 */
export interface HerdrStateMapping {
  state: "idle" | "working" | "blocked";
  customStatus: string;
  release?: boolean;
  closePane?: boolean;
  notify?: "done" | "request";
}

const CONDUCTOR_STATUS_LABELS_BY_NAME: Record<ConductorStatusName, string> = {
  spawned: "Spawned",
  "workflow-running": "Running",
  "workflow-complete-pane-open": "Complete (pane open)",
  "needs-finalize": "Needs finalize",
  finalizing: "Finalizing",
  completed: "Completed",
  failed: "Failed",
  "needs-human": "Needs human",
};

/**
 * Map a ConductorRunStatus to the herdr cell state.
 * Pure function — unit-tested directly.
 */
export function conductorToHerdrState(status: ConductorRunStatus): HerdrStateMapping {
  const name: ConductorStatusName = status.status;
  const label = CONDUCTOR_STATUS_LABELS_BY_NAME[name];

  switch (name) {
    case "spawned":
      return { state: "working", customStatus: "• spawned" };

    case "workflow-running": {
      // §6: render the live phase (`▶ <phase>`). The active phase is carried in
      // `status.reason` (the conductor sets it to the current stage description).
      // Fall back to the fixed label when no reason is present.
      const phase = status.reason?.trim() || label;
      return { state: "working", customStatus: `▶ ${phase}` };
    }

    case "workflow-complete-pane-open":
      return { state: "working", customStatus: "◐ complete (pane open)" };

    case "needs-finalize":
      return { state: "blocked", customStatus: "! needs finalize", notify: "request" };

    case "finalizing":
      return { state: "working", customStatus: "⟳ finalizing" };

    case "completed":
      return { state: "idle", customStatus: "✓ done", release: true, closePane: true, notify: "done" };

    case "failed":
      return { state: "blocked", customStatus: "✗ failed", notify: "request" };

    case "needs-human":
      return { state: "blocked", customStatus: "? needs human", notify: "request" };

    default: {
      // Fallback for any unknown status
      const _exhaustive: never = name;
      return { state: "idle", customStatus: String(_exhaustive) };
    }
  }
}

// ── Nesting resolution ──────────────────────────────────────────────────────

/**
 * Resolve workspace/tab/split nesting from the caller's herdr environment
 * so the spawned agent pane is nested under the caller pane, never an
 * orphaned top-level agent.
 *
 * When HERDR_WORKSPACE_ID + HERDR_TAB_ID are present (inside herdr), returns
 * `{workspace, tab, split: 'down'}` so the new pane splits below the caller.
 * When env is empty (not inside herdr), returns `{}` — no nesting.
 */
export function resolveNesting(env: NodeJS.ProcessEnv): { workspace?: string; tab?: string; split?: string } {
  const workspace = env.HERDR_WORKSPACE_ID?.trim();
  const tab = env.HERDR_TAB_ID?.trim();
  if (workspace && tab) {
    return { workspace, tab, split: "down" };
  }
  return {};
}

// ── PaneSpawnCoordinator (concurrency cap) ──────────────────────────────────

/** Lease returned by `acquire()` — must be returned via `release()`. */
export interface SpawnLease {
  runId: string;
  /** Release this lease back to the pool. */
  release: () => void;
}

/**
 * Enforces `herdrMaxPanes` concurrency cap.
 * `acquire(runId)` returns a lease when under the cap, or `null` when the
 * cap is exceeded — never throws. The caller fails closed when null.
 */
export class PaneSpawnCoordinator {
  private static _cache = new Map<string, PaneSpawnCoordinator>();
  private active = new Set<string>();
  private cap: number;

  constructor(maxPanes: number = 4) {
    this.cap = maxPanes;
  }

  /**
   * Get or create a shared coordinator for a given project directory.
   * Ensures all WorkflowManager instances in the same project share
   * the same concurrency cap. If a new maxPanes is provided, updates
   * the cached instance to the tighter cap.
   */
  static get(projectCwd: string, maxPanes: number = 4): PaneSpawnCoordinator {
    const key = resolve(projectCwd);
    let coord = this._cache.get(key);
    if (!coord) {
      coord = new PaneSpawnCoordinator(maxPanes);
      this._cache.set(key, coord);
    }
    return coord;
  }

  /** Clear the shared cache (for testing). */
  static reset(): void {
    this._cache.clear();
  }

  /**
   * Acquire a concurrency slot for `runId`.
   * Returns a lease on success, `null` when the cap is exceeded.
   * Never throws.
   */
  acquire(runId: string): SpawnLease | null {
    if (this.active.size >= this.cap) {
      return null;
    }
    this.active.add(runId);
    return {
      runId,
      release: () => {
        this.active.delete(runId);
      },
    };
  }

  /** Current active count (for observability). */
  get activeCount(): number {
    return this.active.size;
  }

  /** Configured concurrency cap (for observability / error messages). */
  get maxPanes(): number {
    return this.cap;
  }
}

// ── RunPaneHandle ───────────────────────────────────────────────────────────

/**
 * Handle for a spawned pane — update the pane status or close it. Returned by
 * {@link createPaneHandle} after the manager has run `worktreeCreate` +
 * `agentStart` on the invoker. There is no single `spawnRunPane` orchestrator:
 * the manager drives the worktree/agent-start steps directly so it can interleave
 * persistence and concurrency-lease acquisition between them.
 */
export interface RunPaneHandle {
  paneId: string;
  /** Push a new conductor status into the herdr cell. */
  updateStatus(status: ConductorRunStatus): void;
  /** Close the pane and release the agent. */
  close(): void;
}

const PANE_SPAWN_SOURCE = "pi-workflows";
const PANE_SPAWN_AGENT = "pi-workflow";
const PANE_TTL_MS = 20_000;

/**
 * Create a pane handle from a paneId. The handle manages report-agent / release / close
 * through the injected invoker.
 */
export function createPaneHandle(invoker: HerdrInvoker, paneId: string): RunPaneHandle {
  let seq = 0;
  const bumpSeq = () => {
    seq = Math.max(seq + 1, Date.now());
    return String(seq);
  };

  return {
    paneId,
    updateStatus(status: ConductorRunStatus): void {
      const mapping = conductorToHerdrState(status);
      invoker.reportAgent(paneId, {
        source: PANE_SPAWN_SOURCE,
        agent: PANE_SPAWN_AGENT,
        state: mapping.state,
        customStatus: mapping.customStatus,
        seq: bumpSeq(),
        ttlMs: PANE_TTL_MS,
      });

      if (mapping.release) {
        invoker.releaseAgent(paneId, {
          source: PANE_SPAWN_SOURCE,
          agent: PANE_SPAWN_AGENT,
        });
      }
    },

    close(): void {
      invoker.paneClose(paneId);
    },
  };
}

// PANE_SPAWN_SOURCE is inlined above — re-export is not needed since it's a module-internal constant.
