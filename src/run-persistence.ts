/**
 * Workflow run state persistence for pause/resume support.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentContextWindowStats } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { ConductorRunStatus } from "./conductor-types.js";
import type { WorkflowErrorCode } from "./errors.js";
import type { JournalEntry, WorkflowRunOptions } from "./workflow.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  startedAt?: string;
  endedAt?: string;
  /** Tokens used by this agent, when known. */
  tokens?: number;
  /** Context-window occupancy stats for this agent, when known. */
  contextWindow?: AgentContextWindowStats;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** The pi session this run belongs to. Runs persist on disk across sessions but
   * the navigator shows only the current session's runs (undefined = legacy/global). */
  sessionId?: string;
  status: RunStatus;
  /** Optional conductor-level semantic status, layered on top of the engine
   *  `status` above. Older persisted runs may omit this; loaders must not reject
   *  runs that lack it. When present it is round-tripped verbatim on save/load. */
  semanticStatus?: ConductorRunStatus;
  /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** Absolute path to this persisted run-state JSON, when recorded by WorkflowManager. */
  runStatePath?: string;
  /** Effective run-wide wall-clock timeout (ms) captured at start, so resume
   *  keeps the original explicit/settings value. null disables the timeout;
   *  absent (old runs) means the runtime default still applies. */
  workflowTimeoutMs?: number | null;
  /** Effective run-level hard per-agent context cap captured at start. */
  agentMaxContextTokens?: number | null;
  /** Effective run-level context reserve override captured at start. */
  agentContextReserveTokens?: number | null;
  /** Effective run-level compaction policy captured at start. */
  compactionPolicy?: WorkflowRunOptions["compactionPolicy"];
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Cached agent results and replay metadata, keyed by deterministic call index. */
  journal?: JournalEntry[];
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run; stale/corrupt lock files are removed and retried.
   */
  acquireRunLease(runId: string): RunLease | null;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
}

/**
 * Persisted run IDs become filenames and lock names, so keep them deliberately
 * boring: generated ids already use lowercase base36 + hyphen. Rejecting dots,
 * slashes, backslashes, controls, and absolute-looking values closes traversal
 * through every run-state/lease/resume/delete path.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidRunId(runId: unknown): runId is string {
  return typeof runId === "string" && RUN_ID_PATTERN.test(runId);
}

export function assertValidRunId(runId: unknown): asserts runId is string {
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid workflow runId: ${JSON.stringify(runId)}`);
  }
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 */
export type FsLayer = {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

/** Shared formula for a run-state JSON file path: runsDir/runId.json.
 *  Used by both RunPersistence (primaryRunPath) and WorkflowManager.runStatePathFor
 *  so the <recovery> log link can never drift from where the run state is actually
 *  written. */
export function runStateJsonPath(runsDir: string, runId: string): string {
  assertValidRunId(runId);
  return join(runsDir, `${runId}.json`);
}

export function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>): RunPersistence {
  const _existsSync = fsOverride?.existsSync ?? existsSync;
  const _mkdirSync = fsOverride?.mkdirSync ?? mkdirSync;
  const _readdirSync = fsOverride?.readdirSync ?? readdirSync;
  const _readFileSync = fsOverride?.readFileSync ?? readFileSync;
  const _renameSync = fsOverride?.renameSync ?? renameSync;
  const _unlinkSync = fsOverride?.unlinkSync ?? unlinkSync;
  const _writeFileSync = fsOverride?.writeFileSync ?? writeFileSync;

  const paths = workflowProjectPaths(cwd);
  const runsDir = paths.runsDir;
  const legacyRunsDir = paths.legacyRunsDir;

  const ensureDir = () => {
    if (!_existsSync(runsDir)) {
      _mkdirSync(runsDir, { recursive: true });
    }
  };

  const runPath = runStateJsonPath; // shared formula (also used by WorkflowManager.runStatePathFor)
  const primaryRunPath = (runId: string) => runPath(runsDir, runId);
  const legacyRunPath = (runId: string) => runPath(legacyRunsDir, runId);
  const lockPath = (dir: string, runId: string) => {
    assertValidRunId(runId);
    return join(dir, `${runId}.lock`);
  };
  const primaryLockPath = (runId: string) => lockPath(runsDir, runId);
  const legacyLockPath = (runId: string) => lockPath(legacyRunsDir, runId);
  const candidateRunPaths = (runId: string) => [primaryRunPath(runId), legacyRunPath(runId)];

  const pidIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "EPERM") return true;
      return false;
    }
  };

  const readLockAt = (path: string): LockFile | null => {
    try {
      return JSON.parse(_readFileSync(path, "utf-8")) as LockFile;
    } catch {
      return null;
    }
  };

  const readLock = (runId: string): LockFile | null =>
    isValidRunId(runId) ? readLockAt(primaryLockPath(runId)) : null;

  const removeStaleLegacyLock = (runId: string): boolean => {
    if (!isValidRunId(runId)) return false;
    const lock = legacyLockPath(runId);
    const existing = readLockAt(lock);
    if (existing?.runId === runId && pidIsAlive(existing.pid)) return false;
    try {
      if (_existsSync(lock)) _unlinkSync(lock);
    } catch {
      return false;
    }
    return true;
  };

  const readStateFile = (path: string, expectedRunId?: string): PersistedRunState | null => {
    try {
      const state = JSON.parse(_readFileSync(path, "utf-8")) as PersistedRunState;
      const fileRunId = basename(path).replace(/\.json(?:\.bak)?$/, "");
      if (!isValidRunId(state.runId)) return null;
      if (expectedRunId !== undefined && state.runId !== expectedRunId) return null;
      if (isValidRunId(fileRunId) && state.runId !== fileRunId) return null;
      return state;
    } catch {
      return null;
    }
  };

  return {
    save(state: PersistedRunState) {
      assertValidRunId(state.runId);
      ensureDir();
      state.updatedAt = new Date().toISOString();
      const path = primaryRunPath(state.runId);
      const json = JSON.stringify(state, null, 2);
      // Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
      // atomic on the same filesystem). A .bak from the previous good save is the
      // recovery fallback if the primary is somehow truncated.
      _writeFileSync(`${path}.tmp`, json);
      _renameSync(`${path}.tmp`, path);
      try {
        _writeFileSync(`${path}.bak`, json);
      } catch {
        // backup is best-effort; the primary write already succeeded
      }
    },

    load(runId: string): PersistedRunState | null {
      if (!isValidRunId(runId)) return null;
      // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
      for (const path of candidateRunPaths(runId)) {
        for (const candidate of [path, `${path}.bak`]) {
          if (!_existsSync(candidate)) continue;
          const state = readStateFile(candidate, runId);
          if (state) return state;
        }
      }
      return null;
    },

    list(): PersistedRunState[] {
      const byRunId = new Map<string, PersistedRunState>();
      for (const dir of [runsDir, legacyRunsDir]) {
        try {
          if (!_existsSync(dir)) continue;
          const files = _readdirSync(dir).filter((f) => f.endsWith(".json"));
          for (const file of files) {
            const state = readStateFile(join(dir, file));
            if (state && !byRunId.has(state.runId)) byRunId.set(state.runId, state);
          }
        } catch {
          // Skip unreadable directories; another storage location may still work.
        }
      }
      return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },

    delete(runId: string): boolean {
      if (!isValidRunId(runId)) return false;
      let deleted = false;
      try {
        for (const path of candidateRunPaths(runId)) {
          const dir = path === primaryRunPath(runId) ? runsDir : legacyRunsDir;
          // Best-effort cleanup of the sidecar files alongside the primary.
          for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(dir, runId)]) {
            try {
              if (_existsSync(sidecar)) _unlinkSync(sidecar);
            } catch {
              // ignore sidecar cleanup failures
            }
          }
          try {
            if (_existsSync(path)) {
              _unlinkSync(path);
              deleted = true;
            }
          } catch {
            // ignore per-file cleanup failures
          }
        }
        return deleted;
      } catch {
        return deleted;
      }
    },

    acquireRunLease(runId: string): RunLease | null {
      if (!isValidRunId(runId)) return null;
      ensureDir();
      const path = primaryRunPath(runId);
      const lock = primaryLockPath(runId);
      if (!removeStaleLegacyLock(runId)) return null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const payload: LockFile = {
          runId,
          runPath: path,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token,
        };
        try {
          _writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
          return { runId, token };
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "EEXIST") throw err;
          const existing = readLock(runId);
          if (existing && existing.runPath === path && pidIsAlive(existing.pid)) {
            return null;
          }
          try {
            _unlinkSync(lock);
          } catch {
            return null;
          }
        }
      }
      return null;
    },

    releaseRunLease(lease: RunLease): void {
      if (!isValidRunId(lease.runId)) return;
      try {
        const existing = readLock(lease.runId);
        if (existing?.token === lease.token) _unlinkSync(primaryLockPath(lease.runId));
      } catch {
        // Best-effort cleanup only.
      }
    },

    getRunsDir(): string {
      return runsDir;
    },
  };
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
