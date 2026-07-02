/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.js";
import { loadAgentRegistry } from "./agent-registry.js";
import {
  CONDUCTOR_STATE_ENV_PATHS,
  ISSUE_DELIVERY_STATUS_PATH,
  parseConductorStateEnv,
  reconcileStaleWorkflowRun,
} from "./conductor-reconciliation.js";
import type { ConductorRunStatus, ConductorStatusName } from "./conductor-types.js";
import { PERSIST_SUBAGENT_TRANSCRIPTS_DEFAULT } from "./config.js";
import type { ContextModeRegistry } from "./context-mode.js";
import { preview, type WorkflowSnapshot } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { HARNESS_RUNTIME_INFO, HARNESS_TYPES, loadHarnessConfigRegistry } from "./harness-config.js";
import type { HarnessSelection } from "./harness-selector.js";
import {
  conductorToHerdrState,
  createDefaultHerdrInvoker,
  createPaneHandle,
  type HerdrInvoker,
  PaneSpawnCoordinator,
  type RunPaneHandle,
  resolveNesting,
  type SpawnLease,
} from "./pane-spawn.js";
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
import { createWorktree, removeWorktree, resolveRepoRoot, type Worktree } from "./worktree.js";

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
  /** Optional herdr-pane handle (only when paneSpawn isolation is active). */
  paneHandle?: RunPaneHandle;
  /** Persisted herdr pane id for a pane-spawn run, so resume can recreate the
   *  pane handle and keep driving the pane's lifecycle/finalization. */
  paneId?: string;
  /** Optional pane-spawn coordinator lease (released in executeRun's finally). */
  _spawnLease?: SpawnLease;
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
  /**
   * Enable herdr pane-spawn: spawn a real pi process in a herdr-managed pane,
   * nested under the caller's workspace/tab/split. The herdr-managed worktree
   * replaces src/worktree.ts — single source of truth, no double bookkeeping.
   * Requires `herdrPaneSpawn` setting to be enabled on the manager.
   */
  paneSpawn?: boolean;
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
  /** Host session ModelRegistry shared with workflow subagents (upstream #49 port). */
  modelRegistry?: ModelRegistry;
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
  /** Injectable HerdrInvoker for pane-spawning (tests inject a mock). */
  herdrInvoker?: HerdrInvoker;
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
  /** Host session ModelRegistry shared with workflow subagents (see setModelRegistry). */
  private modelRegistry?: ModelRegistry;
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
  /** Injectable herdr invoker for pane-spawning (real or mock). */
  private herdrInvoker: HerdrInvoker;
  /** Pane-spawn concurrency coordinator (enforces herdrMaxPanes cap). */
  private paneCoordinator: PaneSpawnCoordinator;
  /** Cached herdrPaneSpawn setting ('off' | 'auto'). */
  private herdrPaneSpawnSetting: "off" | "auto";

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    // Preserve undefined (runtime constant applies) vs null (explicit disable).
    this.defaultWorkflowTimeoutMs = options.defaultWorkflowTimeoutMs;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.defaultAgentMaxContextTokens = normalizePositiveIntegerOption(options.defaultAgentMaxContextTokens) ?? null;
    this.defaultAgentContextReserveTokens =
      normalizePositiveIntegerOption(options.defaultAgentContextReserveTokens) ?? null;
    this.contextModeRegistry = options.contextModeRegistry;
    this.herdrInvoker = options.herdrInvoker ?? createDefaultHerdrInvoker();
    this.persistence = createRunPersistence(this.cwd);
    // Read settings once (run start is rare). Default true matches Claude Code.
    this.herdrPaneSpawnSetting = "off";
    // Pre-initialize with a temporary instance — replaced below once settings are loaded.
    this.paneCoordinator = new PaneSpawnCoordinator(4);
    try {
      const settings: WorkflowSettings = loadWorkflowSettings({ cwd: this.cwd });
      this.persistSubagentTranscripts = settings.persistSubagentTranscripts ?? PERSIST_SUBAGENT_TRANSCRIPTS_DEFAULT;
      this.herdrPaneSpawnSetting = settings.herdrPaneSpawn ?? "off";
      {
        let maxPanes = 4;
        if (
          typeof settings.herdrMaxPanes === "number" &&
          Number.isFinite(settings.herdrMaxPanes) &&
          settings.herdrMaxPanes > 0
        ) {
          maxPanes = Math.min(64, Math.floor(settings.herdrMaxPanes));
        }
        this.paneCoordinator = PaneSpawnCoordinator.get(this.cwd, maxPanes);
      }
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
    // Reconcile the pane-spawn cap with persisted runs that still have a live Herdr
    // pane after a restart. A failed/paused/attention pane-spawn run keeps its
    // pane open and its `paneId` on disk; without re-seeding the coordinator, a
    // fresh manager permits another full cap of pane-spawn runs and defeats the
    // VM memory ceiling. Only runs NOT currently in memory are seeded (in-memory
    // runs already hold their lease).
    this.reconcilePaneCap();
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

  /**
   * Seed the pane-spawn coordinator with persisted runs that still have a live
   * Herdr pane (a `paneId` on disk) after a process restart. Such runs kept
   * their pane open across the restart (failed/paused/attention states retain
   * the pane + lease), so they must continue counting against `herdrMaxPanes` —
   * otherwise the fresh manager over-allocates panes and breaches the VM memory
   * ceiling. Runs already in memory (an in-process lease) are skipped.
   */
  private reconcilePaneCap(): void {
    try {
      const persistedPaneRunIds = this.listAllRuns()
        .filter((p) => Boolean(p.paneId) && !this.runs.has(p.runId))
        .map((p) => p.runId);
      this.paneCoordinator.reconcile(persistedPaneRunIds);
    } catch {
      // Best-effort: never block construction on cap reconciliation.
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
   * Share the host session's ModelRegistry with workflow subagents (upstream #49
   * port). Set on session_start; runs started afterwards resolve tier/phase/model
   * routing against the same registry as the main Pi session, so extension-
   * registered providers are routable instead of silently falling back.
   */
  setModelRegistry(registry: ModelRegistry | undefined): void {
    this.modelRegistry = registry;
  }

  /** The shared host ModelRegistry, when one has been set (see setModelRegistry). */
  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
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
    // Harness-descriptor `worktreeRequired` auto-isolation: a harness may demand
    // run-level isolation. For an explicit `--harness-config <id>`, consult that
    // descriptor (auto-detected harnesses are resolved inside runWorkflow; their
    // worktreeRequired is a deeper follow-up). Load the registry once when needed
    // (including on resume, so a reused isolated run keeps the primary's descriptors).
    const needsRegistry = !!(
      isolation?.worktree ||
      isolation?.paneSpawn ||
      worktreeRequired ||
      reuseWorktree ||
      harness_config
    );
    const harnessRegistry = needsRegistry ? loadHarnessConfigRegistry(this.cwd) : undefined;
    const harnessDescriptor = harness_config ? harnessRegistry?.get(harness_config) : undefined;
    // The EFFECTIVE runtime is the caller's `harness_type` override (if valid) else
    // the descriptor's runtime — so an opencode descriptor launched with `--harness-type pi`
    // is wired (pi) and CAN demand isolation, while an unwired descriptor with no override
    // reaches runWorkflow's clean-skip.
    const effectiveHarnessType =
      harness_type && (HARNESS_TYPES as readonly string[]).includes(harness_type)
        ? harness_type
        : harnessDescriptor?.harness_type;
    const effectiveWired = effectiveHarnessType
      ? HARNESS_RUNTIME_INFO[effectiveHarnessType as keyof typeof HARNESS_RUNTIME_INFO].wired
      : true;
    // A valid caller `harness_type` override redeems an invalid descriptor runtime
    // (the effective runtime is the override, not the descriptor's typo), so only block
    // on `invalid` when there is no valid override.
    const validOverride = !!harness_type && (HARNESS_TYPES as readonly string[]).includes(harness_type);
    const descriptorUsable =
      !!harnessDescriptor &&
      !harnessDescriptor.skipped &&
      (!harnessDescriptor.invalid || validOverride) &&
      effectiveWired;
    const descriptorRequiresWorktree = !!harnessDescriptor?.worktreeRequired && descriptorUsable;
    // A harness that REQUIRES isolation cannot be satisfied when the caller also supplied
    // an explicit `tools` policy: isolation drops those (primary-cwd-bound) tools, which
    // would silently strip a read-only fence from a review workflow. Fail closed so the
    // conflict is surfaced (a cwd-bound tool factory that preserves policy under
    // isolation is #93) instead of silently running unisolated or dropping the fence.
    if (descriptorRequiresWorktree && tools) {
      const conflict = new WorkflowError(
        `Harness '${harness_config}' requires worktree isolation but an explicit tools policy cannot be preserved under isolation; drop tools or use a cwd-bound tool factory (#93)`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
      managed.status = "failed";
      managed.error = conflict;
      this.persistRun(managed);
      this.releaseRunLease(managed);
      this.emit("error", { runId: managed.runId, error: conflict });
      throw conflict;
    }
    const wantWorktree = !!(isolation?.worktree || worktreeRequired || descriptorRequiresWorktree);
    // Pane-spawn takes precedence over a plain worktree when active. Per docs
    // §4.6 an active herdr pane-spawn replaces src/worktree.ts (single source of
    // truth). Two selection paths enable it:
    //   1. An explicit caller opt-in via `isolation.paneSpawn: true` (e.g. a
    //      saved workflow that knows it wants a dedicated pane).
    //   2. The `herdrPaneSpawn: "auto"` setting, which docs define as enabling
    //      pane-spawn for isolated runs ONLY when inside herdr
    //      (`HERDR_PANE_ID` present). Without this, an operator enabling the
    //      setting still gets the plain `createWorktree` path for
    //      worktree-required runs.
    // The `HERDR_PANE_ID` feature gate is applied to the auto path so a normal
    // terminal with the setting enabled does not attempt `herdr worktree create`
    // (which degrades to an empty cwd and aborts the run instead of no-op'ing).
    const insideHerdr = !!process.env.HERDR_PANE_ID?.trim();
    // An explicit caller opt-in to pane-spawn (`isolation.paneSpawn: true`) must
    // not silently degrade: if the Herdr feature gate is absent (`insideHerdr` is
    // false) or the project setting is still the default `off`, `wantPaneSpawn`
    // would become false while `wantWorktree` does NOT include `paneSpawn`, so the
    // run would fall through with `runCwd = this.cwd` — silently executing in the
    // primary checkout instead of the requested isolated pane/worktree. Fail
    // closed so the explicit request surfaces instead of violating isolation.
    // Falling back to a plain worktree would silently change the semantics the
    // caller asked for, so we refuse rather than substitute.
    const explicitPaneSpawnRequested = !!isolation?.paneSpawn;
    if (explicitPaneSpawnRequested && (!insideHerdr || this.herdrPaneSpawnSetting === "off")) {
      const reason = !insideHerdr
        ? "not inside a herdr pane (HERDR_PANE_ID absent)"
        : `herdrPaneSpawn setting is 'off'`;
      const spawnDisabledError = new WorkflowError(
        `Pane-spawn isolation requested but cannot be honored (${reason}); enable herdrPaneSpawn or run inside herdr, or drop isolation.paneSpawn`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
      managed.status = "failed";
      managed.error = spawnDisabledError;
      this.persistRun(managed);
      this.releaseRunLease(managed);
      this.emit("error", { runId: managed.runId, error: spawnDisabledError });
      throw spawnDisabledError;
    }
    const wantPaneSpawn =
      (!!isolation?.paneSpawn || (this.herdrPaneSpawnSetting === "auto" && wantWorktree && insideHerdr)) &&
      this.herdrPaneSpawnSetting !== "off" &&
      insideHerdr;
    // Pane-spawn sets `managed.worktree`, so `runWorkflow` would receive
    // `tools: undefined` below and a default WorkflowAgent rebuilds the normal
    // mutating coding tools for the worktree cwd. That silently strips a
    // read-only/restricted tool fence from a review-style run launched with
    // pane-spawn — exactly the silent-fence-drop the descriptorRequiresWorktree
    // conflict above guards against. Fail closed here too until a cwd-bound
    // tool factory that preserves policy under pane-spawn isolation exists (#93).
    if (wantPaneSpawn && tools) {
      const conflict = new WorkflowError(
        `Pane-spawn isolation cannot preserve an explicit tools policy; drop tools or use a cwd-bound tool factory (#93)`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
      managed.status = "failed";
      managed.error = conflict;
      this.persistRun(managed);
      this.releaseRunLease(managed);
      this.emit("error", { runId: managed.runId, error: conflict });
      throw conflict;
    }
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
      // Reattach a pane-spawn run: the prior pane handle was lost when the
      // managed run was torn down, so recreate it from the persisted pane id and
      // re-acquire the coordinator lease. Without this, resumed failed/paused
      // pane-spawn workflows continue in the worktree with no pane updates and
      // later semantic/finalization statuses leave the Herdr pane stale/open.
      if (managed.paneId) {
        const spawnSlot = this.paneCoordinator.acquire(managed.runId);
        if (!spawnSlot) {
          const capError = new WorkflowError(
            `herdr pane concurrency cap reached on resume (${this.paneCoordinator.activeCount}/${this.paneCoordinator.maxPanes}); raise herdrMaxPanes or wait`,
            WorkflowErrorCode.WORKFLOW_ABORTED,
            { recoverable: false },
          );
          managed.status = "failed";
          managed.error = capError;
          this.persistRun(managed);
          this.releaseRunLease(managed);
          this.emit("error", { runId: managed.runId, error: capError });
          throw capError;
        }
        managed._spawnLease = spawnSlot;
        managed.paneHandle = createPaneHandle(this.herdrInvoker, managed.paneId);
      }
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
    } else if (wantPaneSpawn) {
      // ── Pane-spawn path: herdr-managed worktree replaces src/worktree.ts ──
      // Checked BEFORE the plain worktree branch so an isolated run that also
      // requests paneSpawn spawns via herdr instead of src/worktree.ts.
      // Acquire the concurrency lease (fail closed when the cap is exceeded).
      const spawnSlot = this.paneCoordinator.acquire(managed.runId);
      if (!spawnSlot) {
        const capError = new WorkflowError(
          `herdr pane concurrency cap reached (${this.paneCoordinator.activeCount}/${this.paneCoordinator.maxPanes}); raise herdrMaxPanes or wait`,
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: false },
        );
        managed.status = "failed";
        managed.error = capError;
        this.persistRun(managed);
        this.releaseRunLease(managed);
        this.emit("error", { runId: managed.runId, error: capError });
        throw capError;
      }
      managed._spawnLease = spawnSlot;

      // herdr worktree create — single source of truth, no double bookkeeping.
      // docs §2: --base is a git *ref*, --cwd is the repo path. Pass the repo path
      // via --cwd; the herdr-managed branch is the wf/<runId> ref.
      //
      // When the caller did not supply `isolation.base`, derive the repo root via
      // `git rev-parse --show-toplevel` (the same call `createWorktree` uses) instead
      // of falling back to `this.cwd`. If the manager is rooted at a repo subdirectory
      // (e.g. packages/foo), using `this.cwd` as `spawnBase` makes the later
      // `relative(spawnBase, this.cwd)` empty by construction, so the caller's
      // subdirectory is lost and the run lands at the herdr worktree root instead of
      // `worktree/packages/foo`. Resolving the toplevel preserves the subdirectory
      // offset the same way the plain worktree path does. When not inside a git
      // repo (or `isolation.base` is explicit), fall back to the prior behavior.
      const spawnBase = isolation?.base ?? (await resolveRepoRoot(this.cwd)) ?? this.cwd;
      const herdrWt = await this.herdrInvoker.worktreeCreate({
        cwd: spawnBase,
        branch: `wf/${managed.runId}`,
      });
      if (!herdrWt.cwd) {
        const wtError = new WorkflowError(
          "herdr worktree create returned empty path — pane spawn aborted",
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: false },
        );
        managed.status = "failed";
        managed.error = wtError;
        spawnSlot.release();
        this.persistRun(managed);
        this.releaseRunLease(managed);
        this.emit("error", { runId: managed.runId, error: wtError });
        throw wtError;
      }

      // Persist the herdr-managed worktree onto managed.worktree.
      managed.worktree = { cwd: herdrWt.cwd, branch: herdrWt.branch, repoRoot: spawnBase };
      this.persistRun(managed);

      // Resolve nesting so the spawned pane is nested under the caller pane.
      const nesting = resolveNesting(process.env);

      // agentStart — the pane nests under HERDR_WORKSPACE_ID/HERDR_TAB_ID.
      const runArgs = ["--mode", "focused"];
      const agentResult = await this.herdrInvoker.agentStart(
        {
          name: `wf-${managed.runId}`,
          cwd: herdrWt.cwd,
          ...nesting,
        },
        ["pi", ...runArgs],
      );

      // Fail closed when agentStart returned no pane id: the default invoker returns
      // `{ paneId: "" }` when `herdr agent start` failed or produced unparsable
      // output. Continuing would acquire a spawnSlot and persist a herdr worktree
      // with no paneHandle, so completed/failed pane lifecycle code could neither
      // close the pane nor release the coordinator lease — the cap would stay
      // consumed until manual deletion and later pane-spawn runs could be blocked.
      // Treat a missing paneId like a spawn failure: release the lease, clean up
      // the worktree, and abort before running the workflow.
      if (!agentResult.paneId) {
        const spawnError = new WorkflowError(
          "herdr agent start returned no pane id — pane spawn aborted",
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: false },
        );
        managed.status = "failed";
        managed.error = spawnError;
        spawnSlot.release();
        // The herdr worktree was created but no pane attaches to it; remove it so a
        // failed spawn does not leave a stray worktree + branch behind. Use the
        // Herdr worktree API (not the local git `removeWorktree` helper) so Herdr's
        // internal workspace/group bookkeeping stays consistent — deleting the
        // checkout behind Herdr's back can leave a stale Herdr workspace entry.
        await this.herdrInvoker.worktreeRemove({ cwd: spawnBase, branch: herdrWt.branch });
        managed.worktree = undefined;
        this.persistRun(managed);
        this.releaseRunLease(managed);
        this.emit("error", { runId: managed.runId, error: spawnError });
        throw spawnError;
      }

      // Store the pane handle for lifecycle management, and persist the pane id
      // so resume() can recreate the handle and keep driving the pane lifecycle.
      managed.paneId = agentResult.paneId;
      managed.paneHandle = createPaneHandle(this.herdrInvoker, agentResult.paneId);
      this.persistRun(managed);

      // Set runCwd (same subdir-adjustment logic as the plain worktree path below).
      // Derive the relative subpath from the repo root used for worktreeCreate
      // (`spawnBase`), so an auto pane-spawn run triggered by `worktreeRequired`/a
      // descriptor from a manager rooted at a repo subdirectory (e.g. packages/foo)
      // runs inside that subdir within the herdr worktree — not at herdrWt.cwd. The
      // explicit `isolation.base` path is the special case of the same rule.
      runCwd = herdrWt.cwd;
      const sub = relative(spawnBase, this.cwd);
      if (sub && !sub.startsWith("..") && !isAbsolute(sub)) {
        runCwd = join(herdrWt.cwd, sub);
      }
      // Note: explicit ExecOptions.tools are rejected above (fail-closed) before
      // this point, so no tools-drop warning is needed here.
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
        this.persistRun(managed);
        this.releaseRunLease(managed);
        this.emit("error", { runId: managed.runId, error: failError });
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
    // (Pane-spawn path already set managed.worktree via herdr — don't overwrite.)
    if (!managed.worktree && runWorktree?.isolated) {
      managed.worktree = { cwd: runWorktree.cwd, branch: runWorktree.branch, repoRoot: runWorktree.repoRoot };
    }
    // Persist the worktree immediately so a crash between `git worktree add` and the
    // first journal callback still leaves the isolation target on disk for resume.
    if (managed.worktree) this.persistRun(managed);
    try {
      const result = await runWorkflow(script, {
        cwd: runCwd,
        agentRegistry: managed.worktree ? loadAgentRegistry(this.cwd) : undefined,
        harnessConfigRegistry: managed.worktree ? harnessRegistry : undefined,
        tools: managed.worktree ? undefined : tools,
        args,
        runId: managed.runId,
        agent: this.agent,
        mainModel: this.mainModel,
        modelRegistry: this.modelRegistry,
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
      // Route the engine terminal state through the pane handle in case the
      // workflow completed without the conductor setting a semantic `completed`
      // (otherwise the pane would stay stale/open after the engine completes).
      this.applyEngineTerminalPaneStatus(managed);
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
      // Route the engine terminal state through the pane handle. A pane-spawn run
      // that throws before the conductor sets a semantic `failed` would otherwise
      // leave its pane stale/open; an abort maps to a failed pane cell. Paused
      // (usage-limit) runs keep their pane open and lease retained.
      this.applyEngineTerminalPaneStatus(managed);
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
      // Pane-spawn runs set `managed.worktree` directly (herdr owns the worktree)
      // and leave `runWorktree` undefined, so wrap `managed.worktree` here too —
      // otherwise an aborted pane-spawn run skips removal and leaves the herdr
      // worktree + branch behind until a later manual deleteRun(), regressing the
      // existing isolation contract for stop()/abort.
      if (runWorktree?.isolated && managed.status === "aborted") await removeWorktree(runWorktree);
      else if (!runWorktree?.isolated && managed.worktree && managed.status === "aborted")
        await removeWorktree({
          isolated: true,
          cwd: managed.worktree.cwd,
          branch: managed.worktree.branch,
          repoRoot: managed.worktree.repoRoot,
        });
      // Release the pane-spawn coordinator lease ONLY when the pane is actually
      // closed/gone. Kept-open conductor states (workflow-complete-pane-open,
      // needs-finalize, needs-human) and resumable terminal states (failed,
      // paused) intentionally leave the Herdr pane running, so releasing the
      // lease here would drop `activeCount` while the real pane is still open —
      // repeated runs could then exceed `herdrMaxPanes` and defeat the memory
      // cap. The lease is released when the pane is truly closed: on `completed`
      // (setSemanticStatus closes it), on deleteRun(), or here on abort (the run
      // unwound and the worktree is gone, so the pane is stale/closed).
      if (managed._spawnLease && managed.status === "aborted") {
        managed._spawnLease.release();
        managed._spawnLease = undefined;
        // The pane is stale after an abort — close it so it doesn't linger.
        if (managed.paneHandle) {
          managed.paneHandle.close();
          managed.paneHandle = undefined;
        }
        // Clear the persisted pane id too: the catch block above persisted the run
        // with paneId still set, so after a process restart reconcilePaneCap()
        // would treat the stale paneId as a live pane and permanently consume a
        // herdrMaxPanes slot until the user manually deletes the run. Mirror the
        // completed-path cleanup (setSemanticStatus) by clearing paneId and
        // persisting the cleared state once the pane is actually closed.
        if (managed.paneId) {
          managed.paneId = undefined;
          this.persistRun(managed);
        }
      }
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
        paneId: managed.paneId,
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
      // Restore the persisted pane id so executeRun's reuse-worktree branch can
      // recreate the pane handle and keep driving the pane lifecycle for a
      // resumed pane-spawn run (otherwise the pane is left stale/open).
      paneId: persisted.paneId,
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
   * Push the engine terminal state through the pane handle.
   *
   * Pane updates normally flow from `setSemanticStatus` (the conductor's
   * `onSemanticStatus` callback), but a pane-spawn workflow that completes
   * without setting a semantic `completed` — or throws before setting semantic
   * `failed` — would leave its `paneHandle` stale and open after the engine
   * emits complete/error. Route the manager's terminal `completed`/`failed`/
   * `aborted` transitions through the pane handle here so generic pane-spawn runs
   * and early failures still apply the documented close/failed mapping.
   */
  private applyEngineTerminalPaneStatus(managed: ManagedRun): void {
    if (!managed.paneHandle) return;
    const engineStatus = managed.status;
    // Map the engine status to the closest conductor semantic status. We only
    // synthesize the terminal ones here; non-terminal/kept-open states are still
    // driven by the conductor via setSemanticStatus.
    const semantic: ConductorRunStatus | null =
      engineStatus === "completed"
        ? { status: "completed", reason: "engine completed" }
        : engineStatus === "failed"
          ? { status: "failed", reason: "engine failed" }
          : engineStatus === "aborted"
            ? { status: "failed", reason: "aborted" }
            : null;
    if (!semantic) return;
    // Don't double-push: if the conductor already set the same semantic status,
    // setSemanticStatus already drove the pane (and may have closed it).
    if (managed.semanticStatus?.status === semantic.status) return;
    // Preserve kept-open/attention semantic statuses set by the conductor (or the
    // workflow itself via setSemanticStatus) when the engine returns normally.
    // Issue Delivery publishes `workflow-complete-pane-open`/`needs-human`/
    // `needs-finalize` immediately before returning (see src/issue-delivery.ts);
    // synthesizing `completed` here would call setSemanticStatus(), which closes
    // the pane (conductorToHerdrState(completed).closePane) and defeats the
    // documented kept-open handoff. Skip synthesis whenever an existing semantic
    // status is one of the conductor-owned kept-open/attention states, not only
    // when it exactly equals `completed`.
    //
    // Only apply this kept-open skip on successful engine completion: when the
    // engine has already driven `managed.status` to `failed` (e.g. a workflow that
    // published `workflow-complete-pane-open` then threw), the kept-open status is
    // stale and must NOT suppress the `failed` synthesis — otherwise the Herdr pane
    // keeps showing the prior complete/attention state instead of the failed run.
    if (
      engineStatus === "completed" &&
      managed.semanticStatus &&
      KEPT_OPEN_PANE_STATUSES.has(managed.semanticStatus.status)
    )
      return;
    this.setSemanticStatus(managed.runId, semantic);
  }

  /**
   * Set the conductor-level semantic status for a run.
   * The status is persisted (so it survives resume) and returned by
   * listRuns() alongside the existing engine `status`.
   * When a pane handle is attached (pane-spawn isolation), this also pushes
   * the conductorToHerdrState mapping into the herdr cell and auto-closes
   * the pane on `completed`.
   */
  setSemanticStatus(runId: string, semanticStatus: ConductorRunStatus): void {
    const managed = this.runs.get(runId);
    if (managed) {
      managed.semanticStatus = semanticStatus;
      this.persistRun(managed);
      this.emit("semanticStatus", { runId, semanticStatus });
      // Drive the herdr pane cell (docs §4 fan-in point).
      if (managed.paneHandle) {
        const mapping = conductorToHerdrState(semanticStatus);
        managed.paneHandle.updateStatus(semanticStatus);
        if (mapping.closePane) {
          managed.paneHandle.close();
          managed.paneHandle = undefined;
          // The pane is now closed — release the coordinator lease retained for
          // kept-open states so activeCount reflects reality and the cap stays
          // meaningful. Also clear the persisted pane id so a later resume does
          // not try to drive a closed pane.
          if (managed._spawnLease) {
            managed._spawnLease.release();
            managed._spawnLease = undefined;
          }
          if (managed.paneId) {
            managed.paneId = undefined;
            this.persistRun(managed);
          }
        }
      }
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
    // Close the pane and release the retained coordinator lease for a kept-open
    // pane-spawn run (needs-finalize/needs-human/workflow-complete-pane-open).
    // deleteRun() is the explicit terminal cleanup path, so the pane must close
    // and the lease must return here — not linger after the run is gone.
    // Cold-delete path: after a restart `managed` is absent but the persisted run
    // can still have a live Herdr pane (`paneId` on disk with no in-memory handle).
    // Load the persisted paneId, recreate a handle, close the pane, and release
    // the coordinator membership that was seeded by reconcilePaneCap() —
    // otherwise deleteRun() removes run state/worktree while leaving the Herdr
    // pane orphaned and the cap slot consumed.
    if (managed?.paneHandle) {
      managed.paneHandle.close();
      managed.paneHandle = undefined;
    } else {
      const persistedPaneId = this.persistence.load(runId)?.paneId;
      if (persistedPaneId) {
        try {
          createPaneHandle(this.herdrInvoker, persistedPaneId).close();
        } catch {
          // Best-effort: the pane may already be gone.
        }
        // Release the coordinator membership seeded at restart so the cap reflects
        // the deleted run. acquire() is idempotent for runId, so a lease here just
        // hands back the existing membership to release.
        const lease = this.paneCoordinator.acquire(runId);
        lease?.release();
      }
    }
    if (managed?._spawnLease) {
      managed._spawnLease.release();
      managed._spawnLease = undefined;
    }
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

/** Conductor-owned kept-open/attention semantic statuses that intentionally keep the
 *  Herdr pane open across a normal engine completion (see applyEngineTerminalPaneStatus).
 *  These are the conductor handoff states: the workflow published one of these
 *  immediately before returning, so synthesizing `completed` would close the pane
 *  and defeat the handoff. `workflow-complete-pane-open` is an active kept-open
 *  state; `needs-finalize`/`needs-human` are the human-attention handoff states. */
const KEPT_OPEN_PANE_STATUSES: ReadonlySet<ConductorStatusName> = new Set<ConductorStatusName>([
  "workflow-complete-pane-open",
  "needs-finalize",
  "needs-human",
]);

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
