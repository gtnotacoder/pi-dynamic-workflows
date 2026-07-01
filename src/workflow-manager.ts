/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { WorkflowAgent } from "./agent.js";
import { type AgentRegistry, loadAgentRegistry } from "./agent-registry.js";
import {
  CONDUCTOR_STATE_ENV_PATHS,
  ISSUE_DELIVERY_STATUS_PATH,
  parseConductorStateEnv,
  reconcileStaleWorkflowRun,
} from "./conductor-reconciliation.js";
import type { ConductorRunStatus } from "./conductor-types.js";
import { PERSIST_SUBAGENT_TRANSCRIPTS_DEFAULT } from "./config.js";
import type { ContextModeRegistry } from "./context-mode.js";
import { preview, type WorkflowSnapshot } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { type HarnessConfigRegistry, loadHarnessConfigRegistry } from "./harness-config.js";
import type { HarnessSelection } from "./harness-selector.js";
import {
  assertValidRunId,
  createRunPersistence,
  generateRunId,
  isValidRunId,
  loadHarnessSelection,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
  runStateJsonPath,
  saveHarnessSelection,
} from "./run-persistence.js";
import {
  type JournalEntry,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./workflow.js";
import { workflowProjectPaths } from "./workflow-paths.js";
import { loadWorkflowSettings, type WorkflowSettings } from "./workflow-settings.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
  /**
   * Directory each subagent's NDJSON transcript is written to (one file per
   * subagent), so a failed run is debuggable — matching Claude Code's per-
   * subagent `agent-<id>.jsonl` transcripts. Undefined when transcript persistence
   * is disabled via `persistSubagentTranscripts: false`.
   */
  transcriptDir?: string;
  /** Per-run override of the wall-clock timeout, captured when the run started
   *  so persistence/resume keep the original explicit/settings default. null
   *  disables the run-wide timeout; undefined means the runtime constant applies. */
  workflowTimeoutMs?: number | null;
  /** Whether `workflowTimeoutMs` was explicitly captured for this run. Always
   *  true for fresh runs (startInBackground/runSync resolve it from exec/manager
   *  default at start, even when that resolves to undefined). For resumed runs it
   *  is true only when the persisted state had the field — false for old runs
   *  persisted before this feature, so executeRun passes `undefined` to
   *  runWorkflow and the runtime `DEFAULT_WORKFLOW_TIMEOUT_MS` applies instead of
   *  the current manager/settings default. */
  workflowTimeoutMsCaptured?: boolean;
  /** Path to the persisted run-state JSON (runsDir/<runId>.json), so a failed
   *  run can link to it from the chat <recovery> block. Set regardless of whether
   *  subagent transcript persistence is enabled (the run state is always saved). */
  runStatePath?: string;
  /** Effective run-level hard per-agent context cap captured at start/resume. */
  agentMaxContextTokens?: number | null;
  /** Effective run-level context reserve override captured at start/resume. */
  agentContextReserveTokens?: number | null;
  /** Effective run-level compaction policy captured at start/resume. */
  compactionPolicy?: WorkflowRunOptions["compactionPolicy"];
  /** Effective run-level loop-guard policy captured at start/resume. */
  loopGuard?: WorkflowRunOptions["loopGuard"];
  /** Harness selection snapshot captured at run start and reused on resume. */
  harnessSelection?: HarnessSelection;
  /** Persisted run state used only to resume deterministic harness selection snapshots. */
  persistedRunState?: PersistedRunState;
  /** Run-level isolation worktree (persisted so resume reuses it; undefined when not isolated). */
  worktree?: { cwd: string; branch?: string; repoRoot?: string };
  /** Optional conductor-level semantic status, layered on top of the engine
   *  `status` above. Older runs may omit this. */
  semanticStatus?: ConductorRunStatus;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Replay these journaled agent results for the unchanged prefix (resume). */
  resumeJournal?: Map<number, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Wall-clock timeout for the whole async workflow script. null means no hard timeout. */
  workflowTimeoutMs?: number | null;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /** Default hard cap for provider input/context tokens per agent. */
  agentMaxContextTokens?: number | null;
  /** Default reserve subtracted from model context windows for occupancy. */
  agentContextReserveTokens?: number | null;
  /** Default per-agent compaction posture for this execution. */
  compactionPolicy?: WorkflowRunOptions["compactionPolicy"];
  /** Detect repeated identical agent() calls. Default is warn-only. */
  loopGuard?: WorkflowRunOptions["loopGuard"];
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
  /** Full subagent tool set for this execution; when omitted, the default coding tools are used. */
  tools?: WorkflowRunOptions["tools"];
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
  /** Run-level default context posture for this execution (e.g. slash --mode). */
  contextMode?: string;
  /** Tentative run-level harness runtime selector; inert until Issue D wires expansion. */
  harness_type?: string;
  /** Tentative run-level harness capability/config selector; inert until Issue D wires expansion. */
  harness_config?: string;
  /**
   * Directory to persist each subagent's NDJSON transcript into for this run.
   * Overrides the manager's default (computed from the run id) when set.
   */
  transcriptDir?: string;
  /**
   * Run-level isolation: when `worktree` is true, the run executes in its own git
   * worktree (branch `pi/wf/<runId>`) and never touches the primary checkout's
   * working branch; the worktree is removed when the run settles. The conductor's
   * finalization then delivers a PR from that worktree. (Tier-1 isolation seam.)
   */
  isolation?: RunIsolationOptions;
  /** First-class alias for `isolation: { worktree: true }` (demand an isolated run). */
  worktreeRequired?: boolean;
  /**
   * Resume reuse: when set, executeRun reuses this existing worktree (from a
   * paused run's persisted state) instead of creating a new one, so a resumed
   * run continues in the same isolated tree with its edits intact.
   */
  reuseWorktree?: { cwd: string; branch?: string; repoRoot?: string };
}

/**
 * Run-level isolation options for {@link WorkflowManager.startInBackground}/
 * {@link WorkflowManager.runSync}. The foundation of the Tier-1 conductor seam
 * (see docs/herdr-integration.md §4): a run gets its own git worktree so it never
 * touches the primary checkout, and finalization delivers a PR from it.
 *
 * The tmux/herdr pane spawn (a real `pi` per run) is a tracked follow-up validated
 * against the admin-portal worked example; this option delivers the worktree
 * isolation + PR-from-worktree leg today.
 */
export interface RunIsolationOptions {
  /** Create + run in a git worktree (branch `pi/wf/<runId>`); removed on settle. */
  worktree?: boolean;
  /** Base cwd/repo to add the worktree to (defaults to the manager's cwd). */
  base?: string;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  mainModel?: string;
  /** The pi session id to tag runs with (see setSessionId). */
  sessionId?: string;
  /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /**
   * Default hard wall-clock timeout for a whole run, in milliseconds, applied
   * when a run does not pass its own `workflowTimeoutMs`. null disables the
   * run-wide timeout explicitly; undefined (the default) lets the runtime
   * constant (`DEFAULT_WORKFLOW_TIMEOUT_MS`) still apply. Normalized exactly
   * like `defaultAgentTimeoutMs`.
   */
  defaultWorkflowTimeoutMs?: number | null;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /** Default hard cap for provider input/context tokens per agent. */
  defaultAgentMaxContextTokens?: number | null;
  /** Default reserve subtracted from model context windows for occupancy. */
  defaultAgentContextReserveTokens?: number | null;
  /** Named context-mode registry (built-ins + project-defined) for tool-driven runs. */
  contextModeRegistry?: ContextModeRegistry;
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** True once installTaskPanel() has registered the below-editor panel — lets the
   *  workflow tool suppress redundant chat streaming only when a panel will show
   *  live progress (see workflow-tool.ts). Set by installTaskPanel in task-panel.ts. */
  hasTaskPanel = false;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  /** Resolved settings/option default for the run-wide timeout. undefined keeps the runtime default. */
  private defaultWorkflowTimeoutMs: number | null | undefined;
  private defaultAgentRetries: number;
  private defaultAgentMaxContextTokens: number | null;
  private defaultAgentContextReserveTokens: number | null;
  /** Named context-mode registry threaded into every run so project modes resolve. */
  private contextModeRegistry?: ContextModeRegistry;
  /** Cached setting: whether subagent transcripts are persisted to disk. */
  private persistSubagentTranscripts: boolean;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    // Preserve undefined (runtime constant applies) vs null (explicit disable).
    this.defaultWorkflowTimeoutMs = options.defaultWorkflowTimeoutMs;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.defaultAgentMaxContextTokens = normalizePositiveIntegerOption(options.defaultAgentMaxContextTokens) ?? null;
    this.defaultAgentContextReserveTokens =
      normalizePositiveIntegerOption(options.defaultAgentContextReserveTokens) ?? null;
    this.contextModeRegistry = options.contextModeRegistry;
    this.persistence = createRunPersistence(this.cwd);
    // Read the opt-out once (run start is rare). Default true matches Claude Code.
    try {
      const settings: WorkflowSettings = loadWorkflowSettings({ cwd: this.cwd });
      this.persistSubagentTranscripts = settings.persistSubagentTranscripts ?? PERSIST_SUBAGENT_TRANSCRIPTS_DEFAULT;
      if (options.defaultAgentMaxContextTokens === undefined) {
        this.defaultAgentMaxContextTokens = settings.defaultAgentMaxContextTokens ?? null;
      }
      if (options.defaultAgentContextReserveTokens === undefined) {
        this.defaultAgentContextReserveTokens = settings.defaultAgentContextReserveTokens ?? null;
      }
    } catch {
      this.persistSubagentTranscripts = PERSIST_SUBAGENT_TRANSCRIPTS_DEFAULT;
    }
    this.recoverStaleRuns();
  }

  /** Directory each subagent's transcript is written to for a given run id. */
  private transcriptDirFor(runId: string): string {
    assertValidRunId(runId);
    return join(workflowProjectPaths(this.cwd).runsDir, runId, "subagents");
  }

  /** Path to the persisted run-state JSON for a run id (runsDir/<runId>.json) —
   *  delegates to the shared runStateJsonPath so this can never drift from where
   *  RunPersistence actually writes the file. */
  private runStatePathFor(runId: string): string {
    assertValidRunId(runId);
    return runStateJsonPath(workflowProjectPaths(this.cwd).runsDir, runId);
  }

  /**
   * Resolve the transcript dir for a run, creating it (best-effort) when
   * persistence is enabled. Returns undefined when the user opted out.
   */
  private resolveTranscriptDir(runId: string): string | undefined {
    if (!this.persistSubagentTranscripts) return undefined;
    const dir = this.transcriptDirFor(runId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort: SessionManager.create will also mkdirSync on first agent.
    }
    return dir;
  }

  /** Resolve the per-run wall-clock timeout to capture at start time, so it is
   *  persisted and survives resume. A per-call exec override wins; otherwise the
   *  manager/settings default applies. undefined is preserved (runtime constant). */
  private resolveStartWorkflowTimeoutMs(exec: ExecOptions): number | null | undefined {
    return exec.workflowTimeoutMs !== undefined ? exec.workflowTimeoutMs : this.defaultWorkflowTimeoutMs;
  }

  private resolveStartAgentMaxContextTokens(exec: ExecOptions): number | null {
    if (exec.agentMaxContextTokens === null) return null;
    return normalizePositiveIntegerOption(exec.agentMaxContextTokens) ?? this.defaultAgentMaxContextTokens;
  }

  private resolveStartAgentContextReserveTokens(exec: ExecOptions): number | null {
    if (exec.agentContextReserveTokens === null) return null;
    return normalizePositiveIntegerOption(exec.agentContextReserveTokens) ?? this.defaultAgentContextReserveTokens;
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    try {
      for (const p of this.listAllRuns()) {
        if (p.status === "running" && !this.runs.has(p.runId)) {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            const reconciliation = reconcileStaleWorkflowRun(p, this.readConductorReconciliationSignals());
            this.persistence.save({
              ...p,
              status: reconciliation?.status ?? "paused",
              semanticStatus: reconciliation?.semanticStatus ?? p.semanticStatus,
            });
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        }
      }
    } catch {
      // Recovery is best-effort; never let it block manager construction.
    }
  }

  private readConductorReconciliationSignals(): {
    stateEnvs?: Array<{ path: string; env: Record<string, string | undefined> }>;
    issueDeliveryStatus?: unknown;
  } {
    return {
      stateEnvs: this.readConductorStateEnvs(),
      issueDeliveryStatus: this.readJsonSidecar(ISSUE_DELIVERY_STATUS_PATH),
    };
  }

  private readConductorStateEnvs(): Array<{ path: string; env: Record<string, string | undefined> }> | undefined {
    const sources: Array<{ path: string; env: Record<string, string | undefined> }> = [];
    for (const relativePath of CONDUCTOR_STATE_ENV_PATHS) {
      const text = this.readTextSidecar(relativePath);
      if (text === undefined) continue;
      sources.push({ path: relativePath, env: parseConductorStateEnv(text) });
    }
    return sources.length > 0 ? sources : undefined;
  }

  private readJsonSidecar(relativePath: string): unknown | undefined {
    const text = this.readTextSidecar(relativePath);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  private readTextSidecar(relativePath: string): string | undefined {
    try {
      return readFileSync(join(this.cwd, relativePath), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const runId = generateRunId();
    const controller = new AbortController();
    const parsed = parseWorkflowScript(script);
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: true,
      lease,
      workflowTimeoutMs: this.resolveStartWorkflowTimeoutMs(exec),
      workflowTimeoutMsCaptured: true,
      agentMaxContextTokens: this.resolveStartAgentMaxContextTokens(exec),
      agentContextReserveTokens: this.resolveStartAgentContextReserveTokens(exec),
      compactionPolicy: exec.compactionPolicy,
      loopGuard: exec.loopGuard,
      transcriptDir: this.resolveTranscriptDir(runId),
      runStatePath: this.runStatePathFor(runId),
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state — include the effective run-wide timeout so a
      // crash/restart before the first journal/final persist keeps the explicit/
      // settings value. JSON.stringify omits undefined fields.
      this.persistence.save({
        runId,
        workflowName: parsed.meta.name,
        script,
        args,
        sessionId: this.sessionId,
        status: "running",
        phases: managed.snapshot.phases,
        agents: [],
        logs: [],
        startedAt: managed.startedAt.toISOString(),
        updatedAt: managed.startedAt.toISOString(),
        runStatePath: managed.runStatePath,
        workflowTimeoutMs: managed.workflowTimeoutMs,
        agentMaxContextTokens: managed.agentMaxContextTokens,
        agentContextReserveTokens: managed.agentContextReserveTokens,
        compactionPolicy: managed.compactionPolicy,
        loopGuard: managed.loopGuard,
      });
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const managed = this.createManaged(script, args);
    managed.workflowTimeoutMs = this.resolveStartWorkflowTimeoutMs(exec);
    managed.workflowTimeoutMsCaptured = true;
    managed.agentMaxContextTokens = this.resolveStartAgentMaxContextTokens(exec);
    managed.agentContextReserveTokens = this.resolveStartAgentContextReserveTokens(exec);
    managed.compactionPolicy = exec.compactionPolicy;
    managed.loopGuard = exec.loopGuard;
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    return this.executeRun(managed, script, args, exec);
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args?: unknown): ManagedRun {
    const parsed = parseWorkflowScript(script);
    const runId = generateRunId();
    return {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: false,
      transcriptDir: this.resolveTranscriptDir(runId),
      runStatePath: this.runStatePathFor(runId),
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const {
      resumeJournal,
      maxAgents,
      agentTimeoutMs,
      workflowTimeoutMs,
      externalSignal,
      onProgress,
      tokenBudget,
      agentMaxContextTokens,
      agentContextReserveTokens,
      compactionPolicy,
      loopGuard,
      concurrency,
      agentRetries,
      confirm,
      contextMode,
      tools,
      harness_type,
      harness_config,
      isolation,
      worktreeRequired,
      reuseWorktree,
    } = exec;
    const resolvedAgentTimeoutMs = agentTimeoutMs !== undefined ? agentTimeoutMs : this.defaultAgentTimeoutMs;
    // Effective run-wide timeout precedence:
    //   exec.workflowTimeoutMs   (highest — per-call override)
    //   managed.workflowTimeoutMs (captured at start/resume from persisted or settings)
    //   this.defaultWorkflowTimeoutMs (manager/settings default; fresh runs only)
    //   undefined   -> runWorkflow falls back to DEFAULT_WORKFLOW_TIMEOUT_MS.
    // null at any level explicitly disables the wall timeout.
    // A resumed old run persisted before `workflowTimeoutMs` existed has
    // `workflowTimeoutMsCaptured === false`: skip the manager default so the
    // runtime constant applies (the run never opted into the current default).
    const managedTimeoutApplies =
      managed.workflowTimeoutMsCaptured === false ? false : managed.workflowTimeoutMs !== undefined;
    const resolvedWorkflowTimeoutMs =
      workflowTimeoutMs !== undefined
        ? workflowTimeoutMs
        : managedTimeoutApplies
          ? managed.workflowTimeoutMs
          : this.defaultWorkflowTimeoutMs;
    const resolvedConcurrency = concurrency ?? this.concurrency;
    const resolvedAgentRetries = agentRetries ?? this.defaultAgentRetries;
    const resolvedAgentMaxContextTokens = resolveContextPolicyOption(
      agentMaxContextTokens,
      managed.agentMaxContextTokens,
      this.defaultAgentMaxContextTokens,
    );
    const resolvedAgentContextReserveTokens = resolveContextPolicyOption(
      agentContextReserveTokens,
      managed.agentContextReserveTokens,
      this.defaultAgentContextReserveTokens,
    );
    const resolvedCompactionPolicy = compactionPolicy !== undefined ? compactionPolicy : managed.compactionPolicy;
    const resolvedLoopGuard = loopGuard !== undefined ? loopGuard : managed.loopGuard;
    const progress = () => onProgress?.(managed.snapshot);
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    // Tier-1 run-level isolation: optionally run the whole workflow in its own git
    // worktree so it never touches the primary checkout's working branch. The
    // worktree is removed in the finally below when the run settles TERMINALLY
    // (complete/failed/aborted); a PAUSED run keeps its worktree so resume can
    // continue in the same tree with its edits intact. Finalization delivers a PR
    // from this worktree.
    const wantWorktree = !!(isolation?.worktree || worktreeRequired);
    let runWorktree: Worktree | undefined;
    let runCwd = this.cwd;
    if (reuseWorktree && existsSync(reuseWorktree.cwd)) {
      // Resume reuses the paused run's worktree (its edits live there, not primary).
      runWorktree = {
        isolated: true,
        cwd: reuseWorktree.cwd,
        branch: reuseWorktree.branch,
        repoRoot: reuseWorktree.repoRoot,
      };
    } else if (reuseWorktree) {
      // A persisted worktree was required for resume but is gone (the failed run's
      // tree was removed on terminal settle). Refuse to resume in the primary
      // checkout — that would violate isolation and the prior edits are lost anyway.
      const goneError = new WorkflowError(
        `Cannot resume isolated run: worktree no longer exists at ${reuseWorktree.cwd}`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
      managed.status = "failed";
      managed.error = goneError;
      this.emit("error", { runId: managed.runId, error: goneError });
      this.persistRun(managed);
      this.releaseRunLease(managed);
      throw goneError;
    } else if (wantWorktree) {
      runWorktree = await createWorktree(isolation?.base ?? this.cwd, `run-${managed.runId}`);
      if (!runWorktree.isolated) {
        // Fail closed: isolation was demanded but the worktree is unavailable (not a
        // git repo, git error, …). Refuse to run in the primary checkout — that would
        // violate the isolation contract and risk edits to the user's working branch.
        const failError = new WorkflowError(
          `Run isolation required but worktree unavailable (${runWorktree.reason ?? "unknown"})`,
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: false },
        );
        managed.status = "failed";
        managed.error = failError;
        this.emit("error", { runId: managed.runId, error: failError });
        this.persistRun(managed);
        this.releaseRunLease(managed);
        throw failError;
      }
    }
    if (runWorktree?.isolated) {
      runCwd = runWorktree.cwd;
      // Preserve the caller's subdirectory: if the manager is bound to a subdirectory
      // of the repo (e.g. packages/foo), run inside that subdir within the worktree,
      // not the worktree root.
      if (runWorktree.repoRoot) {
        const sub = relative(runWorktree.repoRoot, this.cwd);
        if (sub && !sub.startsWith("..") && !isAbsolute(sub)) runCwd = join(runWorktree.cwd, sub);
      }
      // Explicit ExecOptions.tools were built for the primary checkout's cwd and can't
      // be relocated; they are DROPPED below (runWorkflow receives undefined) so the
      // agent builds coding tools bound to the worktree cwd. A restricted tool policy
      // is therefore not preserved under isolation — a cwd-bound tool factory is the
      // #93 follow-up. Warn so callers know.
      if (tools) {
        this.emit("log", {
          runId: managed.runId,
          message:
            "[isolation] explicit ExecOptions.tools dropped (primary-cwd bound); the agent builds worktree-cwd tools. Use a cwd-bound factory for custom policy (#93)",
        });
      }
    }
    // Stash the worktree ROOT (not the subdir-adjusted runCwd) so resume re-derives
    // the subdir cleanly instead of appending it twice.
    managed.worktree = runWorktree?.isolated
      ? { cwd: runWorktree.cwd, branch: runWorktree.branch, repoRoot: runWorktree.repoRoot }
      : undefined;
    // Persist the worktree immediately so a crash between `git worktree add` and the
    // first journal callback still leaves the isolation target on disk for resume.
    if (managed.worktree) this.persistRun(managed);
    try {
      const result = await runWorkflow(script, {
        cwd: runCwd,
        agentRegistry: runWorktree?.isolated ? loadAgentRegistry(this.cwd) : undefined,
        harnessConfigRegistry: runWorktree?.isolated ? loadHarnessConfigRegistry(this.cwd) : undefined,
        tools: runWorktree?.isolated ? undefined : tools,
        args,
        runId: managed.runId,
        agent: this.agent,
        mainModel: this.mainModel,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        contextModeRegistry: this.contextModeRegistry,
        maxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        workflowTimeoutMs: resolvedWorkflowTimeoutMs,
        tokenBudget,
        agentMaxContextTokens: resolvedAgentMaxContextTokens,
        agentContextReserveTokens: resolvedAgentContextReserveTokens,
        compactionPolicy: resolvedCompactionPolicy,
        loopGuard: resolvedLoopGuard,
        confirm,
        contextMode,
        harness_type,
        harness_config,
        persistedRunState: managed.persistedRunState,
        onHarnessSelection: (selection) => {
          managed.harnessSelection = selection;
          this.persistRun(managed);
        },
        loadSavedWorkflow: this.loadSavedWorkflow,
        transcriptDir: exec.transcriptDir ?? managed.transcriptDir,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        onAgentJournal: (entry) => {
          // Append (crash-safe-ish): keep the latest entry per index, then persist.
          managed.journal = managed.journal.filter((e) => e.index !== entry.index);
          managed.journal.push(entry);
          this.persistRun(managed);
        },
        onLog: (message) => {
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
          progress();
        },
        onAgentStart: (event) => {
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
            startedAt: event.startedAt ?? new Date().toISOString(),
          });
          this.emit("agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentEnd: (event) => {
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            agent.tokens = event.tokens;
            agent.contextWindow = event.contextWindow;
            if (event.model) agent.model = event.model;
            if (event.startedAt) agent.startedAt = event.startedAt;
            agent.endedAt = event.endedAt ?? new Date().toISOString();
          }
          this.emit("agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onAgentHistory: (event) => {
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.history = event.history;
          }
          this.emit("agentHistory", { runId: managed.runId, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          managed.snapshot.tokenUsage = usage;
          this.emit("tokenUsage", { runId: managed.runId, usage });
          progress();
        },
        onSemanticStatus: (semanticStatus) => {
          this.setSemanticStatus(managed.runId, semanticStatus);
          progress();
        },
      });

      managed.status = "completed";
      managed.result = result;
      managed.harnessSelection = result.harnessSelection;
      this.emit("complete", { runId: managed.runId, result });

      // Persist final state
      this.persistRun(managed);
      this.releaseRunLease(managed);

      return result;
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.WORKFLOW_ABORTED,
              { recoverable: true },
            );

      const usageLimitPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
      if (managed.controller.signal.aborted) {
        // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
        if (managed.status === "running") {
          managed.status = "aborted";
        }
      } else if (usageLimitPaused) {
        // Provider quota/usage limit: NOT a failure. Checkpoint the run as paused so
        // the persisted journal (completed agent results) is replayed by resume()
        // once the budget refills — instead of the user starting from scratch.
        managed.status = "paused";
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      if (usageLimitPaused) {
        this.emit("paused", {
          runId: managed.runId,
          reason: "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
        });
      } else {
        this.emit("error", { runId: managed.runId, error: workflowError });
      }

      // Persist final state
      this.persistRun(managed);
      this.releaseRunLease(managed);

      throw workflowError;
    } finally {
      // Tear down the run-level worktree only when the run is TRULY terminal AND not
      // resumable/repairable. resume() accepts paused AND failed runs, so both keep
      // their worktree (edits live there). A `completed` run whose conductor semantic
      // status is a human-attention state (needs-human/needs-finalize/
      // workflow-complete-pane-open) also keeps its worktree for the operator to
      // repair/finalize. Only clean completion and abort remove it; explicit
      // stop()/deleteRun() handle the rest.
      // Auto-remove the run worktree ONLY on abort: the run unwound, so its agents
      // have exited (no race), and an abort is an explicit terminal stop. Completed,
      // failed, and paused runs KEEP their worktree — completed/failed runs may hold
      // outputs/edits the operator needs to inspect, push, or PR (discard risk), and
      // failed/paused runs are resumable (resume() reuses the worktree). Human-attention
      // semantic statuses (needs-human/needs-finalize) are the issue-delivery
      // repair/finalize handoff and must keep their worktree. Explicit deleteRun()
      // cleans up the rest; finalization removes a delivered worktree.
      if (runWorktree?.isolated && managed.status === "aborted") await removeWorktree(runWorktree);
    }
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private persistRun(managed: ManagedRun) {
    try {
      this.persistence.save({
        runId: managed.runId,
        workflowName: managed.snapshot.name,
        // Persist the real script + journal so the run can be resumed. Runs live
        // in workflow run storage — protect via directory permissions, not blanking.
        script: managed.script,
        args: managed.args,
        sessionId: this.sessionId,
        journal: managed.journal,
        status: managed.status,
        // Why a usage-limit pause happened, so the navigator / a future cold start
        // can show it and (eventually) re-arm resume after the budget refills.
        pauseReason:
          managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
            ? "usage_limit"
            : undefined,
        resetHint:
          managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
            ? managed.error.resetHint
            : undefined,
        phases: managed.snapshot.phases,
        currentPhase: managed.snapshot.currentPhase,
        agents: managed.snapshot.agents.map((a) => ({
          ...a,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
        })),
        logs: managed.snapshot.logs,
        result: managed.result?.result,
        tokenUsage: managed.snapshot.tokenUsage
          ? {
              input: managed.snapshot.tokenUsage.input,
              output: managed.snapshot.tokenUsage.output,
              total: managed.snapshot.tokenUsage.total,
              cost: managed.snapshot.tokenUsage.cost,
              cacheRead: managed.snapshot.tokenUsage.cacheRead,
              cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
            }
          : undefined,
        startedAt: managed.startedAt.toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
        durationMs: managed.result?.durationMs,
        runStatePath: managed.runStatePath,
        // Persist the effective run-wide timeout only when set, so resume keeps
        // the original explicit/settings value. Absent on old runs -> runtime constant.
        workflowTimeoutMs: managed.workflowTimeoutMs,
        agentMaxContextTokens: managed.agentMaxContextTokens,
        agentContextReserveTokens: managed.agentContextReserveTokens,
        compactionPolicy: managed.compactionPolicy,
        loopGuard: managed.loopGuard,
        harnessSelection: saveHarnessSelection(managed.harnessSelection),
        semanticStatus: managed.semanticStatus,
        worktree: managed.worktree,
      });
    } catch (err) {
      // Persistence is best-effort: the run is still healthy in memory.
      // Log so an operator debugging state-loss has a lead, but never crash
      // the workflow over a disk-full situation.
      console.warn("[workflow-manager] Persist run failed:", err);
    }
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    this.emit("paused", { runId });
    this.persistRun(managed);
    this.releaseRunLease(managed);
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   */
  async resume(runId: string): Promise<boolean> {
    if (!isValidRunId(runId)) return false;
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;

    const persisted = this.persistence.load(runId);
    if (!persisted?.script || persisted.status === "completed" || persisted.status === "aborted") return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;

    const controller = new AbortController();
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script: persisted.script,
      args: persisted.args,
      journal: hydrateJournalHistory(persisted.journal ?? [], persisted.agents ?? []),
      background: true,
      lease,
      // Preserve the original explicit/settings timeout so a resumed run keeps
      // the same wall-clock cap it started with. For old runs persisted before
      // this field existed, `workflowTimeoutMsCaptured` is false so executeRun
      // passes `undefined` to runWorkflow and the runtime constant
      // (DEFAULT_WORKFLOW_TIMEOUT_MS) applies — not the current manager/settings
      // default the run never opted into.
      workflowTimeoutMs: persisted.workflowTimeoutMs,
      workflowTimeoutMsCaptured: persisted.workflowTimeoutMs !== undefined,
      // Older persisted runs predate context caps. Treat absent fields as a
      // captured opt-out so resuming them does not silently inherit newer manager
      // defaults and change the original run's policy mid-resume.
      agentMaxContextTokens: persisted.agentMaxContextTokens ?? null,
      agentContextReserveTokens: persisted.agentContextReserveTokens ?? null,
      compactionPolicy: persisted.compactionPolicy,
      loopGuard: persisted.loopGuard,
      harnessSelection: loadHarnessSelection(persisted),
      persistedRunState: persisted,
      transcriptDir: this.resolveTranscriptDir(runId),
      runStatePath: this.runStatePathFor(runId),
      semanticStatus: persisted.semanticStatus,
    };
    this.runs.set(runId, managed);

    const resumeJournal = new Map(managed.journal.map((e) => [e.index, e] as const));
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    void this.executeRun(managed, persisted.script, persisted.args, {
      resumeJournal,
      reuseWorktree: persisted.worktree,
    }).catch(() => {});
    return true;
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (!managed || (managed.status !== "running" && managed.status !== "paused")) return false;

    managed.controller.abort();
    managed.status = "aborted";
    this.emit("stopped", { runId });
    this.persistRun(managed);
    this.releaseRunLease(managed);
    // The worktree is torn down by executeRun's finally once the aborted run's agents
    // unwind (no race with in-flight tool processes); stop() just signals the abort.
    return true;
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Set the conductor-level semantic status for a run.
   * The status is persisted (so it survives resume) and returned by
   * listRuns() alongside the existing engine `status`.
   */
  setSemanticStatus(runId: string, semanticStatus: ConductorRunStatus): void {
    const managed = this.runs.get(runId);
    if (managed) {
      managed.semanticStatus = semanticStatus;
      this.persistRun(managed);
      this.emit("semanticStatus", { runId, semanticStatus });
    }
  }

  /** Cheap in-memory active-run check (no persistence scan) for the task panel's
   *  idle timer — avoids listRuns() disk I/O every tick when nothing is running. */
  hasActiveRuns(): boolean {
    for (const r of this.runs.values()) {
      if (r.status === "running" || r.status === "paused") return true;
    }
    return false;
  }

  /**
   * List all runs (active + persisted).
   */
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run.
   */
  deleteRun(runId: string): boolean {
    if (!isValidRunId(runId)) return false;
    const managed = this.runs.get(runId);
    // Reject deleting an actively-running ISOLATED run: tearing down its worktree
    // mid-flight would strand its in-process agents. Stop/await it first.
    if (managed?.worktree && managed.status === "running") return false;
    if (managed) this.releaseRunLease(managed);
    // Tear down an isolated run's worktree (in-memory or persisted-only) so a
    // deleted run doesn't leave a .pi/worktrees/<id> + pi/wf branch behind. Best-effort.
    const wt = managed?.worktree ?? this.persistence.load(runId)?.worktree;
    if (wt) {
      void removeWorktree({ isolated: true, cwd: wt.cwd, branch: wt.branch, repoRoot: wt.repoRoot });
    }
    this.runs.delete(runId);
    return this.persistence.delete(runId);
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}

function hydrateJournalHistory(journal: JournalEntry[], agents: PersistedRunState["agents"]): JournalEntry[] {
  let nextAgentIndex = 0;
  return [...journal]
    .sort((a, b) => a.index - b.index)
    .map((entry) => {
      if (entry.history?.length || !isAgentJournalEntry(entry)) return entry;
      const matchingAgentIndex = agents.findIndex(
        (agent, index) =>
          index >= nextAgentIndex &&
          agent.status === "done" &&
          agent.label === entry.label &&
          Boolean(agent.history?.length),
      );
      const fallbackAgentIndex = entry.label
        ? -1
        : agents.findIndex(
            (agent, index) => index >= nextAgentIndex && agent.status === "done" && Boolean(agent.history?.length),
          );
      const agentIndex = matchingAgentIndex >= 0 ? matchingAgentIndex : fallbackAgentIndex;
      if (agentIndex < 0) return entry;
      nextAgentIndex = agentIndex + 1;
      return { ...entry, history: agents[agentIndex].history };
    });
}

function isAgentJournalEntry(entry: JournalEntry): boolean {
  return Boolean(entry.label || entry.model || entry.usage || entry.tokens !== undefined);
}

function resolveContextPolicyOption(
  execValue: number | null | undefined,
  managedValue: number | null | undefined,
  defaultValue: number | null,
): number | null {
  if (execValue !== undefined) {
    if (execValue === null) return null;
    return normalizePositiveIntegerOption(execValue) ?? (managedValue !== undefined ? managedValue : defaultValue);
  }
  if (managedValue !== undefined) return managedValue;
  return defaultValue;
}

function normalizePositiveIntegerOption(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
