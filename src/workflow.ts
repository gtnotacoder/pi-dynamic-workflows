import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { AgentContextWindowStats, AgentUsage, WorkflowCtxReadGuardrailOptions } from "./agent.js";
import { buildAgentContextWindowStats, WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  applyToolPolicy,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.js";
import type { WorkflowCompactionPolicyName } from "./compaction-policy.js";
import {
  type CollectFinalizationOptions,
  checkFinalization as defaultCheckFinalization,
  type FinalizationCheckResult,
} from "./conductor-finalization.js";
import type { ConductorRunStatus } from "./conductor-types.js";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  MAX_AGENT_RETRIES,
  MAX_AGENTS_PER_RUN,
  MAX_CONCURRENCY,
  MAX_FANOUT_ITEMS,
  MAX_SCRIPT_BYTES,
  SCRIPT_TIMEOUT_MS,
} from "./config.js";
import { type CompactFeedbackRequest, compactFeedback, renderCorrectionDelta } from "./context-compaction.js";
import {
  BUILTIN_CONTEXT_MODES,
  type ContextModeRegistry,
  type ContextPrimitives,
  resolveContextModeLayers,
  type SystemPromptMode,
} from "./context-mode.js";
import { checkEngineFloor, readEngineVersionFromFile } from "./engine-compat.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import {
  expandHarnessConfig,
  HARNESS_TYPES,
  type HarnessConfigRegistry,
  type HarnessExpansion,
  type HarnessType,
  harnessNotWiredSkip,
  loadHarnessConfigRegistry,
} from "./harness-config.js";
import { type HarnessSelection, harnessSelectionKey, selectHarness } from "./harness-selector.js";
import { checkToolRequirements } from "./tool-requirements.js";

const ENGINE_PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

import { createWorkflowLogger } from "./logger.js";
import { LoopDetector, type LoopGuardOptions } from "./loop-detector.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { loadModelTierConfig, resolveTierModel } from "./model-tier-config.js";
import {
  checkPrototypeWorktreeSafety,
  type PrototypeSafetyOptions,
  type PrototypeSafetyResult,
} from "./prototype-safety.js";
import { assertValidRunId, loadHarnessSelection } from "./run-persistence.js";
import {
  renderStageCheckFeedback,
  runStageCheck,
  type StageCheckOptions,
  type StageCheckResult,
} from "./stage-check.js";
import { type DagNode, DagValidationError, runDag, type WaveResult } from "./workflow-dag.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
  /** Default model for agents whose phase has no route and that set no model/tier. */
  model?: string;
}

/** One cached agent() result, keyed by its deterministic call index. */
export interface JournalEntry {
  index: number;
  /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
  hash: string;
  result: unknown;
  /** Agent label used by the original live agent call, when this entry came from agent(). */
  label?: string;
  /** Agent phase used by the original live agent call, when this entry came from agent(). */
  phase?: string;
  /** Tokens used by the original live agent call, preserved for resume replay. */
  tokens?: number;
  /** Provider usage reported by the original live agent call, when available. */
  usage?: AgentUsage;
  /** Context-window occupancy stats captured for this agent, when measurable. */
  contextWindow?: AgentContextWindowStats;
  /** Resolved model used by the original live agent call, when known. */
  model?: string;
  /** ISO timestamp for the original live agent start. */
  startedAt?: string;
  /** ISO timestamp for the original live agent end. */
  endedAt?: string;
  /** Compact tool/message history from the original live agent call, replayed on resume. */
  history?: AgentHistoryEntry[];
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  depth: number;
}

interface WorkflowAgentRunner {
  run(prompt: string, options?: unknown): Promise<unknown>;
}

export interface WorkflowAgentTelemetryConfig {
  tier?: string;
  agentType?: string;
  requestedModel?: string;
  modelSource?: "agent" | "agentType" | "tier" | "phase" | "main" | "session-default";
  contextMode?: string;
  context?: ContextPrimitives;
  timeoutMs?: number | null;
  retries?: number;
  maxContextTokens?: number;
  contextReserveTokens?: number;
  promptTokensEstimate?: number;
  compactionPolicy?: WorkflowCompactionPolicyName | null;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: WorkflowAgentRunner;
  /** The session's main model (provider/id), shown in /workflows for default agents. */
  mainModel?: string;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to scanning `.pi/agents` (project) + `~/.pi/agents`.
   * Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  concurrency?: number;
  /** Retry attempts after a recoverable agent failure. Default 0. */
  agentRetries?: number;
  tokenBudget?: number | null;
  /** Default hard cap for provider input/context tokens per agent. */
  agentMaxContextTokens?: number | null;
  /** Default reserve subtracted from model context windows for occupancy. */
  agentContextReserveTokens?: number | null;
  /** Default per-agent compaction posture. "auto" makes local/no-cache models compact earlier. */
  compactionPolicy?: WorkflowCompactionPolicyName | null;
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Wall-clock timeout for the whole async workflow script. null means no hard timeout. */
  workflowTimeoutMs?: number | null;
  /** Detect repeated identical agent() calls. Default is warn-only. */
  loopGuard?: LoopGuardOptions;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /**
   * Directory to persist each subagent's NDJSON transcript into (one file per
   * subagent). When set, subagent sessions are file-backed so the full message
   * stream survives disposal — matching Claude Code's `agent-<id>.jsonl` per-subagent
   * transcripts. When omitted, subagents use in-memory sessions.
   */
  transcriptDir?: string;
  /** Resume: cached agent results keyed by deterministic call index. */
  resumeJournal?: Map<number, JournalEntry>;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Called after each live agent completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /**
   * Run-level default context posture — the LOWEST-precedence layer, beneath the
   * agentType frontmatter and the per-call `agent()` options. Set by a slash
   * command's `--mode <name>` flag so e.g. `/code-review --mode isolated` runs
   * every reviewer clean-room without editing any agent `.md`.
   */
  contextMode?: string;
  /** Run-level harness runtime selector (`--harness-type`); wired: drives HarnessSelection snapshot, expandHarnessConfig, clean-skip, and agent() seams. */
  harness_type?: string;
  /** Run-level harness capability/config selector (`--harness-config`); wired: drives HarnessSelection snapshot, expandHarnessConfig, clean-skip, and agent() seams. */
  harness_config?: string;
  inheritProjectContext?: boolean;
  systemPromptMode?: SystemPromptMode;
  inheritSkills?: boolean;
  inheritMainRules?: boolean;
  /**
   * Named context-mode registry (built-ins + project-defined). Defaults to the
   * built-ins. Threaded from settings by the extension entry so a project's
   * `contextModes` are resolvable here and in tool-driven runs.
   */
  contextModeRegistry?: ContextModeRegistry;
  /** Persisted run state loaded by the caller for resume, so the harness selection snapshot can be reused. */
  persistedRunState?: import("./run-persistence.js").PersistedRunState;
  /** Harness config registry for expansion. Snapshotted once per run, mirroring agentRegistry. Injectable for tests. */
  harnessConfigRegistry?: HarnessConfigRegistry;
  /** Run-level read-only flag; when set, the harness expansion and agent fence enforce read-only tool policy. */
  readOnly?: boolean;
  /** Called immediately after the run's harness selection snapshot is resolved. */
  onHarnessSelection?: (selection: HarnessSelection) => void;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * Host-side mechanical verification used by the stageCheck() workflow global.
   * Defaults to native TypeScript/Biome detection in src/stage-check.ts.
   */
  stageCheck?: (options: StageCheckOptions) => Promise<StageCheckResult>;
  /**
   * Ask the human a checkpoint() question and resolve to their reply. Threaded from
   * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
   * default (and journals it), so a detached/background run never hangs.
   */
  confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: {
    agentCallId?: string;
    label: string;
    phase?: string;
    prompt: string;
    model?: string;
    startedAt?: string;
    agentConfig?: WorkflowAgentTelemetryConfig;
  }) => void;
  onAgentEnd?: (event: {
    agentCallId?: string;
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    usage?: AgentUsage;
    contextWindow?: AgentContextWindowStats;
    worktree?: string;
    model?: string;
    agentConfig?: WorkflowAgentTelemetryConfig;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    startedAt?: string;
    endedAt?: string;
  }) => void;
  onAgentHistory?: (event: { label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  /** Called to broadcast the current semantic status of the workflow run. */
  onSemanticStatus?: (status: ConductorRunStatus) => void;
  /**
   * Injectable finalization-check callback so tests can avoid real git/gh.
   * When omitted, defaults to `checkFinalization` from conductor-finalization.
   */
  finalizationCheck?: (cwd: string, opts?: CollectFinalizationOptions) => Promise<FinalizationCheckResult>;
  /**
   * Injectable prototype-mode safety check so tests can avoid real git state.
   * When omitted, defaults to the deterministic git worktree checker.
   */
  prototypeSafetyCheck?: (cwd: string, opts?: PrototypeSafetyOptions) => Promise<PrototypeSafetyResult>;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Harness selection snapshot for this run, exposed for resume and telemetry. */
  harnessSelection?: HarnessSelection;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
   * The workflow author chooses per-agent models per the routing policy in the
   * tool guidelines (e.g. a lighter model for exploration, the main model for
   * analysis). When omitted, the session's main model is used.
   */
  model?: string;
  /**
   * Coarse model tier ("small" | "medium" | "big"), resolved from the user's
   * model-tiers config (see /workflows-models). An explicit `model` takes
   * precedence; a tier takes precedence over the phase model. When the tier has
   * no configured entry it falls back to the session's main model.
   */
  tier?: string;
  isolation?: "worktree";
  /**
   * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
   * user). Binds that definition's tool allow/denylist, model, and body prompt
   * to this agent. An explicit `model` overrides the definition's model; the
   * definition's model overrides `tier`/phase. An unknown name logs a warning
   * and falls back to default tools/model (with the name as a prose hint).
   */
  agentType?: string;
  /**
   * Context-inheritance posture: a named mode (`focused` | `isolated` | `scoped`
   * | `legacy` | a project-defined mode) that expands to the primitives below. The
   * agentType definition may set its own; these call-level fields override it
   * (runtime > frontmatter). Default `focused` (main-agent rules don't leak in).
   */
  contextMode?: string;
  /** Tentative per-call harness runtime selector; inert until Issue D wires expansion. */
  harness_type?: string;
  /** Tentative per-call harness capability/config selector; inert until Issue D wires expansion. */
  harness_config?: string;
  /**
   * Per-call read-only fence. Narrow-only: the effective readOnly is `run-level
   * readOnly || agentOptions.readOnly`, so a call (e.g. the Issue Delivery verifier)
   * can add the fence but cannot lift a run-level one. Filters WRITE_TOOL_NAMES from
   * the resolved tool set.
   */
  readOnly?: boolean;
  /** Load project AGENTS.md / context files into this subagent. Default true. */
  inheritProjectContext?: boolean;
  /** "append": base prompt + role-as-task (default); "replace": role IS the base system prompt. */
  systemPromptMode?: SystemPromptMode;
  /** Load skills into this subagent. Default true. */
  inheritSkills?: boolean;
  /** Inherit the main-agent append channel (`.pi/APPEND_SYSTEM.md`). Default false (no leak). */
  inheritMainRules?: boolean;
  /** Per-call coding-tool allowlist. Undefined = agentType/default tool policy. */
  tools?: string[];
  /** Per-call coding-tool denylist, applied after the allowlist. */
  disallowedTools?: string[];
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Hard cap for provider input/context tokens for this agent. */
  maxContextTokens?: number | null;
  /** Override the reserve subtracted from model context windows for occupancy. */
  contextReserveTokens?: number | null;
  /** Per-agent compaction posture. Overrides the run-level compactionPolicy. */
  compactionPolicy?: WorkflowCompactionPolicyName | null;
  /** Retry attempts after a recoverable failure for this specific agent. */
  retries?: number;
}

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Reply used when no UI is available (headless/background) and headless != "abort". */
  default?: unknown;
  /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
  headless?: "default" | "abort";
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
}

const dagNodeScope = new AsyncLocalStorage<boolean>();

interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling and the run-wide spent at the moment the budget was declared. A phase
   * exceeding its ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall
   * budget is untouched. Soft gate (like the global one): spent accrues after each
   * agent, so an in-flight wave may overshoot slightly.
   */
  phaseBudgets: Map<string, { budget: number; startSpent: number; warned: boolean }>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

/** Intersect defined tool allowlists (narrow); undefined lists are ignored. Undefined when none define a list. */
function intersectToolAllowlists(lists: ReadonlyArray<readonly string[] | undefined>): string[] | undefined {
  const defined = lists.filter((l): l is readonly string[] => l !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return [...defined[0]];
  const [first, ...rest] = defined;
  let result = [...first];
  for (const list of rest) result = result.filter((tool) => list.includes(tool));
  return result;
}

/** Union defined denylists (a narrower layer cannot lift a wider layer's deny). */
function unionToolDenylists(lists: ReadonlyArray<readonly string[] | undefined>): string[] | undefined {
  const defined = lists.filter((l): l is readonly string[] => l !== undefined);
  if (defined.length === 0) return undefined;
  return [...new Set(defined.flatMap((list) => [...list]))];
}

/**
 * Canonical names of the default coding tools `createCodingTools(cwd)` returns
 * (read, bash, edit, write) plus the read-only set (grep, find, ls) the agent
 * also exposes. When `runWorkflow` is called without an explicit `options.tools`,
 * the WorkflowAgent builds exactly these, so required/preferred tool-requirement
 * checks must run against this set (intersected with the harness tool policy)
 * rather than skipping enforcement (the old `undefined` availableTools path).
 */
const DEFAULT_CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/**
 * Compute the effective set of tool names an agent will actually receive, by
 * applying the harness/agentType tool policy to the base tool set. Used to
 * enforce `requiredTools`/`preferredTools` against what the agent gets rather
 * than against a possibly-undefined available list.
 *
 * - `baseToolNames`: the names of the tools the agent starts from. Defaults to
 *   the canonical coding tools when `options.tools` is undefined.
 * - `allow`/`deny`: the effective harness/agentType allowlist/denylist.
 * - `readOnly`: the effective read-only fence (strips write tools last).
 *
 * Returns the surviving tool names. An explicit empty allowlist yields `[]`
 * (deny-all), matching `applyToolPolicy` semantics.
 */
function effectiveAvailableToolNames(
  baseToolNames: readonly string[],
  allow: string[] | undefined,
  deny: string[] | undefined,
  readOnly: boolean | undefined,
): string[] {
  const base = baseToolNames.map((name) => ({ name }));
  return applyToolPolicy(base, allow, deny, { readOnly }).map((tool) => tool.name);
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  // Reject oversized scripts up front (524288-byte cap). The size is measured on
  // the raw script source (which is what the model supplies); checking before
  // parse/execute avoids wasted work.
  if (script.length > MAX_SCRIPT_BYTES) {
    throw new WorkflowError(
      `Script exceeds ${MAX_SCRIPT_BYTES} bytes (got ${script.length}); workflow scripts are capped at ${MAX_SCRIPT_BYTES} bytes`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  const { meta, body } = parseWorkflowScript(script);
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const workflowTimeoutMs =
    options.workflowTimeoutMs !== undefined ? options.workflowTimeoutMs : DEFAULT_WORKFLOW_TIMEOUT_MS;
  const runId = options.runId ?? `run-${started.toString(36)}`;
  assertValidRunId(runId);
  const baseCwd = options.cwd ?? process.cwd();

  const workflowController = new AbortController();
  let removeExternalAbortListener: (() => void) | undefined;
  if (options.signal?.aborted) {
    workflowController.abort(options.signal.reason);
  } else if (options.signal) {
    const onAbort = () => workflowController.abort(options.signal?.reason);
    options.signal.addEventListener("abort", onAbort, { once: true });
    removeExternalAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
  }
  const runSignal = workflowController.signal;
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);

  // Load the harness config registry ONCE per run, mirroring agentRegistry snapshot discipline.
  const harnessConfigRegistry: HarnessConfigRegistry =
    options.harnessConfigRegistry ?? loadHarnessConfigRegistry(baseCwd);

  // Snapshot the harness selection ONCE per run so two agent() calls can't
  // observe a mid-run detection change (determinism). On resume, reuse the
  // persisted snapshot instead of re-detecting.
  const explicitConfig = options.harness_config === "none" ? undefined : options.harness_config;
  const explicitDescriptor = explicitConfig ? harnessConfigRegistry.get(explicitConfig) : undefined;
  let explicitType: HarnessType = "pi";
  if (options.harness_type !== undefined && options.harness_type !== "none") {
    if ((HARNESS_TYPES as readonly string[]).includes(options.harness_type)) {
      explicitType = options.harness_type as HarnessType;
    } else if (explicitDescriptor) {
      explicitType = explicitDescriptor.harness_type;
    }
  } else if (explicitDescriptor) {
    explicitType = explicitDescriptor.harness_type;
  }

  let harnessSelection: HarnessSelection;
  if (options.persistedRunState) {
    harnessSelection =
      loadHarnessSelection(options.persistedRunState) ??
      selectHarness(baseCwd, options.harnessConfigRegistry ? { registry: harnessConfigRegistry } : undefined);
  } else if (options.harness_type || options.harness_config) {
    harnessSelection = {
      harness_type: explicitType,
      harness_config: explicitConfig ?? "none",
      source: "explicit" as const,
      detectorVersion: 1,
    } satisfies HarnessSelection;
  } else {
    harnessSelection = selectHarness(
      baseCwd,
      options.harnessConfigRegistry ? { registry: harnessConfigRegistry } : undefined,
    );
  }

  options.onHarnessSelection?.(harnessSelection);

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    phaseBudgets: new Map(),
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  // Expand the harness config into actionable overrides (context mode, tools, stageCheck defaults).
  const persistedHarnessDescriptor = harnessConfigRegistry.get(harnessSelection.harness_config);
  const expansionHarnessType =
    options.persistedRunState && persistedHarnessDescriptor?.invalid
      ? undefined
      : options.persistedRunState || options.harness_type !== undefined
        ? harnessSelection.harness_type
        : undefined;
  const harnessExpansion: HarnessExpansion = expandHarnessConfig({
    harness_type: expansionHarnessType,
    harness_config: harnessSelection.harness_config,
    registry: harnessConfigRegistry,
    readOnly: options.readOnly,
  });
  const harnessCtxReadGuardrail: WorkflowCtxReadGuardrailOptions | undefined =
    harnessExpansion.componentExtensions !== undefined ||
    harnessExpansion.indexExtensions !== undefined ||
    harnessExpansion.directoryModuleSelfFile !== undefined ||
    harnessExpansion.frontendPathTriggers !== undefined
      ? {
          componentExtensions: harnessExpansion.componentExtensions,
          indexExtensions: harnessExpansion.indexExtensions,
          directoryModuleSelfFile: harnessExpansion.directoryModuleSelfFile,
          frontendPathTriggers: harnessExpansion.frontendPathTriggers,
        }
      : undefined;

  // Engine floor: a workflow script may declare `export const meta = { ..., engine:
  // { min: "<semver>" } }`. Enforce it on the production run path (not only via
  // validate-harness): if the running engine is below the floor, OR the declared floor
  // is present but malformed (non-string), clean-skip the run.
  // A present `engine.min` key (even null) is a declared floor; a non-string value
  // is malformed and clean-skips (matching validate-harness). An absent `min` key or
  // no `engine` object means no floor is declared and the run proceeds.
  const metaEngineRaw = (meta as unknown as { engine?: unknown }).engine;
  const metaEngineHasMin = metaEngineRaw && typeof metaEngineRaw === "object" ? "min" in metaEngineRaw : false;
  const metaEngineMinRaw = metaEngineHasMin ? (metaEngineRaw as { min?: unknown }).min : undefined;
  let metaFloorReason: string | undefined;
  if (metaEngineHasMin) {
    if (typeof metaEngineMinRaw !== "string") {
      // A present non-string min (null/number/object) is malformed.
      metaFloorReason = "Workflow meta engine.min must be a semver string";
    } else {
      // A string (including "") is forwarded to checkEngineFloor, which treats an
      // empty/missing floor as optional (no floor) — mirroring validate-harness so a
      // workflow that passes validation also runs.
      const engineVersion = readEngineVersionFromFile(ENGINE_PACKAGE_JSON);
      if (engineVersion) {
        const metaFloor = checkEngineFloor(metaEngineMinRaw, engineVersion);
        if (!metaFloor.ok) {
          metaFloorReason = `Workflow meta engine.min '${metaEngineMinRaw}' is incompatible with the running engine ${metaFloor.engineVersion ? `${metaFloor.engineVersion.major}.${metaFloor.engineVersion.minor}.${metaFloor.engineVersion.patch}` : "?"}: ${metaFloor.reason}`;
        }
      }
    }
  }
  if (metaFloorReason) {
    const skip = harnessNotWiredSkip({ harness_config: "none", reason: metaFloorReason });
    state.logs.push(`[engine-floor-skip] ${skip.reason}`);
    logger.log(`[engine-floor-skip] ${skip.reason}`);
    return {
      meta,
      result: skip as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: 0,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: options.sharedRuntime?.tokenUsage ?? {
        input: 0,
        output: 0,
        total: 0,
        cost: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      harnessSelection,
    };
  }

  // Explicit below-floor harness config clean-skip: `--harness-config <id>` that the
  // loader skipped (engine.min above the running engine) must NOT silently fall back
  // to pi defaults. The skipped descriptor is retained in the registry with a reason.
  if (explicitDescriptor?.skipped) {
    const reason =
      explicitDescriptor.skipReason ?? `Harness config '${explicitConfig ?? "?"}' was skipped by the loader.`;
    const skip = harnessNotWiredSkip({
      harness_type: explicitDescriptor.harness_type,
      harness_config: explicitConfig ?? "none",
      reason,
    });
    state.logs.push(`[harness-skip] ${skip.reason}`);
    logger.log(`[harness-skip] ${skip.reason}`);
    return {
      meta,
      result: skip as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: 0,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: options.sharedRuntime?.tokenUsage ?? {
        input: 0,
        output: 0,
        total: 0,
        cost: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      harnessSelection,
    };
  }

  // Harness-not-wired clean-skip: when the resolved harness type is not wired to
  // the current runtime, short-circuit to a structured skip result instead of
  // executing the script body.
  if (!harnessExpansion.wired) {
    const skip = harnessNotWiredSkip({
      harness_type: harnessExpansion.harness_type,
      harness_config: harnessExpansion.harness_config,
      reason:
        harnessExpansion.skipReason ??
        `Harness '${harnessExpansion.harness_type}' is not wired to the current runtime.`,
    });
    state.logs.push(`[harness-skip] ${skip.reason}`);
    logger.log(`[harness-skip] ${skip.reason}`);
    return {
      meta,
      result: skip as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: 0,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: options.sharedRuntime?.tokenUsage ?? {
        input: 0,
        output: 0,
        total: 0,
        cost: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      harnessSelection,
    };
  }

  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = normalizeConcurrency(
    // Default concurrency floor is 2: min(16, max(2, cores-2)). Keep the floor at
    // 2 so single/dual-core boxes still run 2 agents in parallel.
    options.concurrency ?? Math.max(2, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  // Global caps + budget are shared with any nested workflow() so they hold across nesting.
  const shared: SharedRuntime = options.sharedRuntime ?? {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
  };
  const limiter = shared.limiter;
  // Per-run loop guard (a nested workflow() gets its own). Warn-only unless the
  // caller opts into { loopGuard: { action: "abort" } }.
  const loopDetector = new LoopDetector(options.loopGuard);

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  // Tool-requirement enforcement: check requiredTools/preferredTools against the tools
  // the agent will ACTUALLY receive, not a possibly-undefined available list. When
  // `options.tools` is undefined (the default path — the WorkflowAgent builds its own
  // coding tools), the effective set is the canonical coding tools narrowed by the
  // harness tool policy (allow/deny/readOnly). This closes the gap where a required
  // tool (e.g. web_search) was declared but never provided, yet the check passed
  // because `availableTools` was `undefined` (checkToolRequirements treats undefined as
  // "all tools available"). An explicit `options.tools` overrides the base set.
  const runLevelBaseToolNames = options.tools?.map((tool) => tool.name) ?? [...DEFAULT_CODING_TOOL_NAMES];
  const runLevelAvailableTools = effectiveAvailableToolNames(
    runLevelBaseToolNames,
    harnessExpansion.tools,
    harnessExpansion.disallowedTools,
    options.readOnly,
  );
  const toolResult = checkToolRequirements(
    runLevelAvailableTools,
    harnessExpansion.requiredTools,
    harnessExpansion.preferredTools,
  );
  if (!toolResult.ok) {
    const skip = harnessNotWiredSkip({
      harness_type: harnessExpansion.harness_type,
      harness_config: harnessExpansion.harness_config,
      reason: toolResult.reason ?? "Missing required tool(s)",
    });
    log(`[harness-skip] ${skip.reason}`);
    return {
      meta,
      result: skip as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: 0,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: options.sharedRuntime?.tokenUsage ?? {
        input: 0,
        output: 0,
        total: 0,
        cost: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      harnessSelection,
    };
  }
  if (toolResult.degraded) {
    harnessExpansion.degraded = true;
    harnessExpansion.degradeReason = toolResult.reason;
    log(`[warn] ${toolResult.reason}`);
  }

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current spent (idempotent across resume: the
    // script re-runs phase() and the ceiling is recomputed from live spent).
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
    }
    options.onPhase?.(title);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });

  const setSemanticStatus = (status: ConductorRunStatus) => {
    options.onSemanticStatus?.(status);
  };

  const checkFinalization = async (
    cwdArg: string = baseCwd,
    opts: CollectFinalizationOptions = {},
  ): Promise<FinalizationCheckResult> => {
    throwIfAborted();
    return await (options.finalizationCheck ?? defaultCheckFinalization)(cwdArg, opts);
  };

  const prototypeSafetyCheck = async (safetyOptions: PrototypeSafetyOptions = {}): Promise<PrototypeSafetyResult> => {
    throwIfAborted();
    return await (options.prototypeSafetyCheck ?? checkPrototypeWorktreeSafety)(baseCwd, safetyOptions);
  };

  const stageCheck = async (stageOptions: StageCheckOptions = {}): Promise<StageCheckResult> => {
    throwIfAborted();
    const input = stageOptions && typeof stageOptions === "object" ? stageOptions : {};
    // Per-step harness: when the caller passes `harness_config` (e.g. issue-delivery's
    // LocalChecks for a step), resolve that config's stageCheckDefaults so mechanical
    // checks run in the step's package/cwd, not the run-level default. Mirror agent()'s
    // per-call accept conditions: only use the per-step config when agent() would ACCEPT
    // it (known, valid, not skipped, no harness_type/runtime mismatch); otherwise fall
    // back to run-level defaults so LocalChecks runs in the SAME package the worker did
    // (worker uses run-level when its per-call override is rejected).
    const perStepHarnessConfigRaw = typeof input.harness_config === "string" ? input.harness_config : undefined;
    const perStepHarnessType =
      typeof input.harness_type === "string" && input.harness_type !== "none" ? input.harness_type : undefined;
    let perStepStageCheckDefaults: Record<string, unknown> | undefined;
    if (perStepHarnessConfigRaw === "none") {
      // Explicit clear (mirrors agent()): use empty defaults (baseCwd), NOT the run-level
      // package cwd, so LocalChecks runs where the worker did (root).
      perStepStageCheckDefaults = {};
    } else if (perStepHarnessConfigRaw) {
      const descriptor = harnessConfigRegistry.get(perStepHarnessConfigRaw);
      const typeMatches = !perStepHarnessType || perStepHarnessType === descriptor?.harness_type;
      if (descriptor && !descriptor.invalid && !descriptor.skipped && typeMatches) {
        // Reject unwired runtimes (mirrors agent() throwing HARNESS_NOT_WIRED): only apply
        // the per-step stageCheckDefaults when the resolved runtime is wired.
        const expansion = expandHarnessConfig({
          harness_type: descriptor.harness_type,
          harness_config: perStepHarnessConfigRaw,
          registry: harnessConfigRegistry,
          readOnly: options.readOnly,
        });
        // An accepted per-step config (even with no stageCheck block) uses its own
        // defaults ({} ⇒ baseCwd), NOT the run-level package cwd.
        if (expansion.wired) perStepStageCheckDefaults = expansion.stageCheckDefaults ?? {};
      }
    }
    const stageCheckDefaults = perStepStageCheckDefaults ?? harnessExpansion.stageCheckDefaults ?? {};
    let defaultCwd = baseCwd;
    if (typeof stageCheckDefaults.cwd === "string" && stageCheckDefaults.cwd.length > 0) {
      defaultCwd = isAbsolute(stageCheckDefaults.cwd)
        ? stageCheckDefaults.cwd
        : resolve(baseCwd, stageCheckDefaults.cwd);
    }
    let effectiveCwd = input.cwd ?? defaultCwd;
    const defaultTargetFile =
      typeof stageCheckDefaults.targetFile === "string" ? stageCheckDefaults.targetFile : undefined;
    let effectiveTargetFile = input.targetFile ?? defaultTargetFile;
    if (input.cwd === undefined && defaultCwd !== baseCwd && typeof effectiveTargetFile === "string") {
      if (isAbsolute(effectiveTargetFile)) {
        const rebasedTarget = relative(defaultCwd, effectiveTargetFile);
        if (rebasedTarget && !rebasedTarget.startsWith("..") && !isAbsolute(rebasedTarget)) {
          effectiveTargetFile = rebasedTarget;
        } else {
          effectiveCwd = baseCwd;
        }
      } else {
        const relativeDefaultCwd = relative(baseCwd, defaultCwd).replace(/\\/g, "/");
        const normalizedTarget = effectiveTargetFile.replace(/\\/g, "/");
        if (relativeDefaultCwd && normalizedTarget.startsWith(`${relativeDefaultCwd}/`)) {
          effectiveTargetFile = normalizedTarget.slice(relativeDefaultCwd.length + 1);
        } else if (
          !existsSync(resolve(defaultCwd, normalizedTarget)) &&
          (existsSync(resolve(baseCwd, normalizedTarget)) || isLikelyProjectRootRelativeStageTarget(normalizedTarget))
        ) {
          effectiveCwd = baseCwd;
        }
      }
    }
    const { harness_config: _perStepHarnessConfig, harness_type: _perStepHarnessType, ...inputWithoutHarness } = input;
    const result = await (options.stageCheck ?? runStageCheck)({
      ...stageCheckDefaults,
      ...inputWithoutHarness,
      cwd: effectiveCwd,
      targetFile: effectiveTargetFile,
      signal: runSignal,
    });
    throwIfAborted();
    log(`[stageCheck] ${result.summary}`);
    return result;
  };

  const compactFeedbackForWorkflow = (request: CompactFeedbackRequest) => compactFeedback(request);

  const throwIfAborted = () => {
    if (runSignal.aborted) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const agent = async (prompt: string, agentOptions: AgentOptions = {}) => {
    throwIfAborted();

    // Check agent limit
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }

    if (budget.total !== null && budget.remaining() <= 0) {
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    }

    const effectiveMaxContextTokens = resolveContextPolicyValue(
      agentOptions.maxContextTokens,
      options.agentMaxContextTokens,
    );
    const effectiveContextReserveTokens = resolveContextPolicyValue(
      agentOptions.contextReserveTokens,
      options.agentContextReserveTokens,
    );

    const assignedPhase = agentOptions.phase ?? state.currentPhase;

    // Per-phase soft sub-budget gate: a noisy phase can exhaust its own ceiling
    // without touching the run's overall budget. Soft (spent accrues post-agent),
    // warns once at ~80%, throws at 100%. Scripts can try/catch around a phase's
    // work so later phases still proceed.
    if (assignedPhase) {
      const pb = state.phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = shared.spent - pb.startSpent;
        if (phaseSpent >= pb.budget) {
          throw new WorkflowError(
            `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
            WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
            { recoverable: false },
          );
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
        }
      }
    }

    const requestedLabel = agentOptions.label?.trim();

    // Resolve a named agentType to its bound definition (tools/model/prompt).
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    if (agentOptions.agentType && !agentDef) {
      log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }

    // Per-call harness precedence: agentOptions.harness_type / harness_config override
    // the run-level selection so a leader's mixed plan can route each worker to its
    // own config (e.g. a frontend step + a backend step). The expansion is re-resolved
    // per call. Discipline (issue #64): a step config may only SELECT/NARROW — it must
    // not widen authority. Enforced three ways:
    //   - an unknown/invalid per-call config id is rejected (keep run-level + warn);
    //   - tool allowlists are intersected with the run-level policy and run-level
    //     denylists are preserved (a step config cannot re-grant a revoked tool);
    //   - expandHarnessConfig still filters WRITE_TOOL_NAMES under readOnly.
    // `harness_config: "none"` is a real explicit override (clear to Pi defaults), not
    // a no-op; `harness_type: "none"` means "not set" (inherit), matching run-level.
    // Per-call read-only fence: narrow-only (a call may add readOnly, not lift a run-level one).
    const effectiveReadOnly = options.readOnly || agentOptions.readOnly === true;
    const perCallHarnessType = agentOptions.harness_type === "none" ? undefined : agentOptions.harness_type;
    const perCallHarnessConfigRaw = agentOptions.harness_config;
    const hasPerCallHarness = perCallHarnessType !== undefined || perCallHarnessConfigRaw !== undefined;
    let effectiveHarnessSelection: HarnessSelection = harnessSelection;
    let effectiveHarnessExpansion: HarnessExpansion = harnessExpansion;
    let effectiveHarnessCtxReadGuardrail: WorkflowCtxReadGuardrailOptions | undefined = harnessCtxReadGuardrail;
    if (hasPerCallHarness) {
      // Resolve the per-call config. "none" = explicit clear; a real id must resolve to
      // a known, valid descriptor or we keep the run-level selection (reject typos/invalid).
      let resolvedConfig: string = harnessSelection.harness_config;
      let rejectOverride = false;
      if (perCallHarnessConfigRaw === "none") {
        resolvedConfig = "none";
      } else if (perCallHarnessConfigRaw !== undefined) {
        const descriptor = harnessConfigRegistry.get(perCallHarnessConfigRaw);
        if (!descriptor || descriptor.invalid || descriptor.skipped) {
          log(
            `per-call harness_config "${perCallHarnessConfigRaw}" is ${
              descriptor?.skipped ? "skipped" : descriptor?.invalid ? "invalid" : "unknown"
            }; using run-level harness`,
          );
          rejectOverride = true;
        } else {
          resolvedConfig = descriptor.id;
        }
      }
      // Resolve the per-call type. When the per-call harness_config resolves to a
      // known, valid descriptor, that descriptor's runtime wins (so a config that
      // declares an unwired runtime like opencode is NOT forced through Pi by a bare
      // `harness_type: "pi"`); a conflicting explicit `harness_type` is a mismatch and
      // the whole override is rejected (keep run-level). With no descriptor, a bare
      // valid `harness_type` applies.
      let resolvedType: HarnessType = harnessSelection.harness_type;
      let typeMismatch = false;
      // Look up the descriptor even when the per-call config equals the run-level config:
      // a conflicting `harness_type` against the same config is still a mismatch (keep
      // run-level) rather than letting the unwired type throw HARNESS_NOT_WIRED.
      const perCallConfigSupplied = perCallHarnessConfigRaw !== undefined && perCallHarnessConfigRaw !== "none";
      const configDescriptor = perCallConfigSupplied ? harnessConfigRegistry.get(resolvedConfig) : undefined;
      if (configDescriptor && !configDescriptor.invalid && !configDescriptor.skipped) {
        const descriptorType = configDescriptor.harness_type;
        if (perCallHarnessType) {
          if (perCallHarnessType !== descriptorType) {
            typeMismatch = true;
          } else {
            resolvedType = perCallHarnessType as HarnessType;
          }
        } else if (resolvedConfig !== harnessSelection.harness_config) {
          resolvedType = descriptorType;
        }
      } else if (perCallHarnessType && (HARNESS_TYPES as readonly string[]).includes(perCallHarnessType)) {
        resolvedType = perCallHarnessType as HarnessType;
      }
      if (typeMismatch) {
        log(
          `per-call harness_type "${perCallHarnessType}" conflicts with harness_config "${resolvedConfig}" runtime; using run-level harness`,
        );
        rejectOverride = true;
      }
      if (!rejectOverride) {
        const candidateSelection: HarnessSelection = {
          harness_type: resolvedType,
          harness_config: resolvedConfig,
          source: "explicit",
          detectorVersion: 1,
        };
        const candidateExpansion = expandHarnessConfig({
          harness_type: resolvedType,
          harness_config: resolvedConfig,
          registry: harnessConfigRegistry,
          readOnly: effectiveReadOnly,
        });
        if (candidateExpansion.wired) {
          effectiveHarnessSelection = candidateSelection;
          // Narrow tool policy (a step config may only SELECT/NARROW, never widen).
          // Intersect the per-step allowlist with the run-level allowlist and keep the
          // result even when empty: `applyToolPolicy` treats an explicit empty allowlist
          // as deny-all, so a disjoint per-step/run-level policy denies tools rather than
          // widening to the run-level set. `resolvedConfig === "none"` (candidateTools
          // undefined) falls through to the run-level allowlist (Pi defaults would be
          // broader). The read-path guardrail below is cleared for "none" (reads are not
          // mutation authority).
          const candidateTools = candidateExpansion.tools;
          const runLevelTools = harnessExpansion.tools;
          let narrowedTools: string[] | undefined;
          if (candidateTools && runLevelTools) {
            narrowedTools = candidateTools.filter((tool) => runLevelTools.includes(tool));
          } else {
            narrowedTools = candidateTools ?? runLevelTools;
          }
          const narrowedDisallowed = [
            ...(candidateExpansion.disallowedTools ?? []),
            ...(harnessExpansion.disallowedTools ?? []),
          ];
          // Preserve run-level context fences: a per-step config that only defines tools
          // (or guardrail) must NOT clear run-level contextMode/inherit* settings. Inherit
          // any context/inheritance field the candidate leaves undefined from the run-level.
          effectiveHarnessExpansion = {
            ...candidateExpansion,
            contextMode: candidateExpansion.contextMode ?? harnessExpansion.contextMode,
            inheritProjectContext: candidateExpansion.inheritProjectContext ?? harnessExpansion.inheritProjectContext,
            inheritSkills: candidateExpansion.inheritSkills ?? harnessExpansion.inheritSkills,
            inheritMainRules: candidateExpansion.inheritMainRules ?? harnessExpansion.inheritMainRules,
            systemPromptMode: candidateExpansion.systemPromptMode ?? harnessExpansion.systemPromptMode,
            tools: narrowedTools,
            disallowedTools: narrowedDisallowed.length > 0 ? narrowedDisallowed : undefined,
          };
          effectiveHarnessCtxReadGuardrail =
            candidateExpansion.componentExtensions !== undefined ||
            candidateExpansion.indexExtensions !== undefined ||
            candidateExpansion.directoryModuleSelfFile !== undefined ||
            candidateExpansion.frontendPathTriggers !== undefined
              ? {
                  componentExtensions: candidateExpansion.componentExtensions,
                  indexExtensions: candidateExpansion.indexExtensions,
                  directoryModuleSelfFile: candidateExpansion.directoryModuleSelfFile,
                  frontendPathTriggers: candidateExpansion.frontendPathTriggers,
                }
              : undefined;
        } else {
          // Clean failure: a per-call selection of an unwired runtime (e.g. opencode/hermes)
          // must NOT fall back to the run-level (pi) harness and mutate under the wrong
          // runtime. Throw a non-recoverable error so the step fails fast. (The run-level
          // path clean-skips unwired harnesses; this mirrors that for per-call selections.)
          throw new WorkflowError(
            `Per-call harness (type=${perCallHarnessType ?? "-"}, config=${resolvedConfig}) is not wired to this runtime; refusing to run under a different harness.`,
            WorkflowErrorCode.HARNESS_NOT_WIRED,
            { recoverable: false, agentLabel: requestedLabel },
          );
        }
      }
    }

    // Per-call tool-requirement re-check (PR #108 finding 2): a per-call harness_config
    // override re-resolves the expansion (and its requiredTools/preferredTools) but the
    // run-level check above only validated the RUN-level config. When the per-call config
    // requires a tool the run-level config lacks, the tool would be silently absent from
    // the agent's effective tool set instead of triggering a clean-skip. Re-run
    // checkToolRequirements against the per-call effective tool set. On a required-miss,
    // throw a non-recoverable error (clean failure: the step cannot run under this config
    // without the tool); on a preferred-miss, log a degradation warning and mark the
    // expansion degraded so the missing-tool state folds into the resume hash (finding 4).
    const perCallAvailableTools = effectiveAvailableToolNames(
      runLevelBaseToolNames,
      effectiveHarnessExpansion.tools,
      effectiveHarnessExpansion.disallowedTools,
      effectiveReadOnly,
    );
    const perCallToolResult = checkToolRequirements(
      perCallAvailableTools,
      effectiveHarnessExpansion.requiredTools,
      effectiveHarnessExpansion.preferredTools,
    );
    if (!perCallToolResult.ok) {
      throw new WorkflowError(
        `Per-call harness (config=${effectiveHarnessExpansion.harness_config}) is missing required tool(s): ${
          perCallToolResult.missingRequired?.join(", ") ?? perCallToolResult.reason ?? "unknown"
        }; refusing to run without the required tool.`,
        WorkflowErrorCode.HARNESS_NOT_WIRED,
        { recoverable: false, agentLabel: requestedLabel },
      );
    }
    if (perCallToolResult.degraded) {
      // Mark the effective expansion degraded so downstream consumers (telemetry,
      // /workflows) and the resume hash see the missing-preferred-tool state. Do NOT
      // mutate the shared run-level harnessExpansion.
      effectiveHarnessExpansion = {
        ...effectiveHarnessExpansion,
        degraded: true,
        degradeReason: perCallToolResult.reason,
      };
      log(`[warn] ${perCallToolResult.reason}`);
    }

    // Resolve the context-inheritance posture once: the harness expansion is the
    // lowest-precedence layer, agentType frontmatter is mid, agent() call options highest.
    // The result is passed to run() as explicit primitives (which win over any bare
    // mode), so run()'s own resolveContextMode reproduces exactly this stack.
    const { primitives: ctx, unknownMode } = resolveContextModeLayers(
      [
        // Lowest precedence: harness expansion (from expandHarnessConfig).
        {
          contextMode: effectiveHarnessExpansion.contextMode,
          inheritProjectContext: effectiveHarnessExpansion.inheritProjectContext,
          systemPromptMode: effectiveHarnessExpansion.systemPromptMode as SystemPromptMode | undefined,
          inheritSkills: effectiveHarnessExpansion.inheritSkills,
          inheritMainRules: effectiveHarnessExpansion.inheritMainRules,
        },
        // Next: run-level default (e.g. a `--mode` flag).
        {
          contextMode: options.contextMode,
          inheritProjectContext: options.inheritProjectContext,
          systemPromptMode: options.systemPromptMode,
          inheritSkills: options.inheritSkills,
          inheritMainRules: options.inheritMainRules,
        },
        // Middle: the agentType `.md` frontmatter.
        {
          contextMode: agentDef?.contextMode,
          inheritProjectContext: agentDef?.inheritProjectContext,
          systemPromptMode: agentDef?.systemPromptMode,
          inheritSkills: agentDef?.inheritSkills,
          inheritMainRules: agentDef?.inheritMainRules,
        },
        // Highest: the per-call agent() options.
        {
          contextMode: agentOptions.contextMode,
          inheritProjectContext: agentOptions.inheritProjectContext,
          systemPromptMode: agentOptions.systemPromptMode,
          inheritSkills: agentOptions.inheritSkills,
          inheritMainRules: agentOptions.inheritMainRules,
        },
      ],
      options.contextModeRegistry ?? BUILTIN_CONTEXT_MODES,
    );
    if (unknownMode) {
      log(`[warn] unknown contextMode "${unknownMode}"`);
    }
    // Under "replace" the role prompt becomes the system prompt, so it must NOT
    // also be injected into the task. buildAgentInstructions is told to skip it.
    const roleAsSystemPrompt = ctx.systemPromptMode === "replace";
    const agentInstructions = buildAgentInstructions(assignedPhase, agentOptions, agentDef, roleAsSystemPrompt);
    const roleSystemPrompt = roleAsSystemPrompt ? agentDef?.prompt : undefined;

    // Model precedence: explicit agentOptions.model > agentType.model > tier > phase model.
    // The "explicit-level" model is opts.model, else the definition's model — either
    // beats tier/phase. When only a tier is set, pass undefined here so the tier (not
    // the phase model) decides inside WorkflowAgent.run().
    const explicitAgentModel = agentOptions.model;
    const agentTypeModel = explicitAgentModel === undefined ? agentDef?.model : undefined;
    const phaseModel = resolveModelForPhase(assignedPhase, routingConfig);
    const explicitModel = explicitAgentModel ?? agentTypeModel;
    const modelTierConfig = loadModelTierConfig();
    const configuredTierModel =
      agentOptions.tier && modelTierConfig ? resolveTierModel(agentOptions.tier, modelTierConfig) : undefined;
    const defaultTierModel =
      !explicitModel && !agentOptions.tier && !phaseModel && modelTierConfig
        ? resolveTierModel("medium", modelTierConfig)
        : undefined;
    const effectiveTier = agentOptions.tier ?? (defaultTierModel ? "medium" : undefined);
    const modelSpec = explicitModel ?? (agentOptions.tier ? undefined : phaseModel);
    const modelSource: WorkflowAgentTelemetryConfig["modelSource"] = explicitAgentModel
      ? "agent"
      : agentTypeModel
        ? "agentType"
        : agentOptions.tier || defaultTierModel
          ? "tier"
          : phaseModel
            ? "phase"
            : options.mainModel
              ? "main"
              : "session-default";
    // For display in /workflows: the model this agent runs on — its explicit/phase
    // spec, else the session's main model. The real resolved id overrides this via
    // onModelResolved once the subagent session is created.
    let displayModel = modelSpec ?? configuredTierModel ?? defaultTierModel ?? options.mainModel;

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const callIndex = state.callSeq++;
    const agentCallId = `${runId}:${callIndex}`;
    // Loop guard: catch a script issuing the same agent() call over and over (a
    // runaway while / loopUntilDry that silently burns budget). Keyed on the call
    // identity (phase | label | resolved model | prompt). Warn-only by default so genuine
    // identical-prompt fan-out (verify / judgePanel reviewers) is never aborted;
    // opt into { loopGuard: { action: "abort" } } to hard-stop. Never touches
    // resume state, so replays stay deterministic.
    const loopRouteModel = displayModel ?? "";
    const loopRouteTier = explicitModel ? "" : (effectiveTier ?? "");
    const loopVerdict = loopDetector.record(
      `${assignedPhase ?? ""}\u0000${requestedLabel ?? ""}\u0000${loopRouteModel}\u0000${loopRouteTier}\u0000${prompt}`,
    );
    if (loopVerdict.looping) {
      log(`[warn] possible loop: ${loopVerdict.reason} — agent "${requestedLabel ?? "agent"}"`);
      if (loopDetector.action === "abort") {
        throw new WorkflowError(
          `loop guard tripped: ${loopVerdict.reason} for agent "${requestedLabel ?? "agent"}"`,
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: false },
        );
      }
    }
    const effectiveContextPolicy = {
      maxContextTokens: effectiveMaxContextTokens,
      contextReserveTokens: effectiveContextReserveTokens,
    };
    const effectiveCompactionPolicy = Object.hasOwn(agentOptions, "compactionPolicy")
      ? agentOptions.compactionPolicy
      : options.compactionPolicy;
    const hashAgentOptions: AgentOptions = {
      ...agentOptions,
      compactionPolicy: effectiveCompactionPolicy,
    };
    // Resume-hash harness key: the auto-detected default fallback (source
    // "default") collapses to the 'none' sentinel so unchanged default runs keep
    // today's hashes and still hit the resume cache. Any explicit/auto/frontmatter
    // selection is serialized in full, so a harness_type/harness_config change (or
    // a newly detected selection) busts every cached agent result on resume.
    const harnessSelectionHashKey = harnessSelectionKey(
      effectiveHarnessSelection.source === "default" ? undefined : effectiveHarnessSelection,
    );
    const legacyNoHarnessSelectionHashKey =
      options.harness_type === "none" &&
      effectiveHarnessSelection.source === "explicit" &&
      effectiveHarnessSelection.harness_config === "none"
        ? '{"detectorVersion":1,"harness_config":"none","harness_type":"none","source":"explicit"}'
        : null;
    const harnessHashKey =
      harnessSelectionHashKey === '"none"'
        ? harnessSelectionHashKey
        : JSON.stringify({
            selection: harnessSelectionHashKey,
            toolPolicy: {
              tools: effectiveHarnessExpansion.tools ?? null,
              disallowedTools: effectiveHarnessExpansion.disallowedTools ?? null,
            },
            ctxReadGuardrail: effectiveHarnessCtxReadGuardrail ?? null,
            // Fold preferred-tool degradation state into the resume hash (PR #108 finding 4):
            // a cached result produced with a preferred tool available must NOT replay
            // after that tool disappears (the degradation warning would be stale). The
            // missing-tool state is part of the call identity, so a change in degradation
            // busts the cache and forces a live re-run.
            degraded: effectiveHarnessExpansion.degraded === true,
            degradeReason: effectiveHarnessExpansion.degradeReason ?? null,
          });
    const agentDefKey = agentDefinitionKey(agentDef);
    const callHash = hashAgentCall(
      prompt,
      modelSpec,
      assignedPhase,
      hashAgentOptions,
      effectiveContextPolicy,
      agentDefKey,
      ctx,
      harnessHashKey,
    );
    const legacyCallHash = hashAgentCall(
      prompt,
      modelSpec,
      assignedPhase,
      hashAgentOptions,
      effectiveContextPolicy,
      agentDefKey,
      ctx,
      harnessHashKey,
      { includeContextPolicy: false },
    );
    const legacyNoHarnessCallHash = legacyNoHarnessSelectionHashKey
      ? hashAgentCall(
          prompt,
          modelSpec,
          assignedPhase,
          hashAgentOptions,
          effectiveContextPolicy,
          agentDefKey,
          ctx,
          legacyNoHarnessSelectionHashKey,
        )
      : null;
    const legacyNoHarnessNoContextCallHash = legacyNoHarnessSelectionHashKey
      ? hashAgentCall(
          prompt,
          modelSpec,
          assignedPhase,
          hashAgentOptions,
          effectiveContextPolicy,
          agentDefKey,
          ctx,
          legacyNoHarnessSelectionHashKey,
          { includeContextPolicy: false },
        )
      : null;

    const estimatedPromptTokens =
      estimateTokens(prompt) + estimateTokens(agentInstructions) + estimateTokens(roleSystemPrompt);
    const baseAgentConfig: WorkflowAgentTelemetryConfig = {
      tier: effectiveTier,
      agentType: agentOptions.agentType,
      requestedModel:
        modelSpec ?? configuredTierModel ?? defaultTierModel ?? (agentOptions.tier ? options.mainModel : undefined),
      modelSource,
      contextMode: agentOptions.contextMode ?? agentDef?.contextMode ?? options.contextMode ?? "focused",
      context: ctx,
      maxContextTokens: effectiveMaxContextTokens,
      contextReserveTokens: effectiveContextReserveTokens,
      promptTokensEstimate: estimatedPromptTokens,
      compactionPolicy: effectiveCompactionPolicy ?? "auto",
    };

    if (effectiveMaxContextTokens !== undefined) {
      if (estimatedPromptTokens > effectiveMaxContextTokens) {
        throw new WorkflowError(
          `agent "${requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount + 1)}" estimated prompt context ${estimatedPromptTokens.toLocaleString()} exceeds maxContextTokens ${effectiveMaxContextTokens.toLocaleString()}`,
          WorkflowErrorCode.CONTEXT_WINDOW_EXCEEDED,
          { recoverable: false, agentLabel: requestedLabel },
        );
      }
    }

    // Reserve the agent slot synchronously — atomic with the limit/budget gate
    // above (no await in between) — so a parallel() fan-out can't all observe the
    // same agentCount and overshoot maxAgents. (Token budget stays a soft gate:
    // spent accrues after each agent, matching Claude Code; in-flight agents may
    // push slightly past total, then further agent() calls throw.)
    shared.agentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);
    const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
    const retryAttempts = normalizeAgentRetries(agentOptions.retries ?? options.agentRetries ?? 0);
    const agentConfig: WorkflowAgentTelemetryConfig = {
      ...baseAgentConfig,
      timeoutMs: timeout,
      retries: retryAttempts,
    };

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    const cached = options.resumeJournal?.get(callIndex);
    const legacyHashMatches =
      cached != null &&
      (cached.hash === legacyCallHash || cached.hash === legacyNoHarnessNoContextCallHash) &&
      effectiveMaxContextTokens === undefined &&
      effectiveContextReserveTokens === undefined;
    const legacyNoHarnessHashMatches = cached != null && cached.hash === legacyNoHarnessCallHash;
    const hashMatches = cached != null && (cached.hash === callHash || legacyHashMatches || legacyNoHarnessHashMatches);
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
      const cachedModel = cached.model ?? displayModel;
      if (cached.usage) {
        shared.tokenUsage.input += cached.usage.input;
        shared.tokenUsage.output += cached.usage.output;
        shared.tokenUsage.total += cached.usage.total;
        shared.tokenUsage.cost += cached.usage.cost;
        shared.tokenUsage.cacheRead += cached.usage.cacheRead;
        shared.tokenUsage.cacheWrite += cached.usage.cacheWrite;
      } else if (typeof cached.tokens === "number") {
        shared.tokenUsage.total += cached.tokens;
      }
      options.onAgentStart?.({
        agentCallId,
        label,
        phase: assignedPhase,
        prompt,
        model: cachedModel,
        startedAt: cached.startedAt,
        agentConfig,
      });
      if (cached.history) options.onAgentHistory?.({ label, phase: assignedPhase, history: cached.history });
      const cachedContextWindow =
        cached.contextWindow ??
        contextWindowFromUsage(cached.usage, cached.tokens, {
          maxContextTokens: effectiveMaxContextTokens,
          reserve: effectiveContextReserveTokens,
        });
      const cachedContextError = contextWindowExceededError(label, cachedContextWindow);
      if (cachedContextError) {
        options.onAgentEnd?.({
          agentCallId,
          label,
          phase: assignedPhase,
          result: null,
          tokens: cached.tokens,
          usage: cached.usage,
          contextWindow: cachedContextWindow,
          model: cachedModel,
          agentConfig,
          error: cachedContextError.message,
          errorCode: cachedContextError.code,
          recoverable: cachedContextError.recoverable,
          startedAt: cached.startedAt,
          endedAt: cached.endedAt,
        });
        throw cachedContextError;
      }
      options.onAgentEnd?.({
        agentCallId,
        label,
        phase: assignedPhase,
        result: cached.result,
        tokens: cached.tokens,
        usage: cached.usage,
        contextWindow: cachedContextWindow,
        model: cachedModel,
        agentConfig,
        startedAt: cached.startedAt,
        endedAt: cached.endedAt,
      });
      return cached.result;
    }
    // A genuine miss (no journal entry, or the hash changed) marks where the
    // unchanged prefix ends; this call and every later one then run live.
    if (!hashMatches || cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);

    return limiter(async () => {
      const maxAttempts = retryAttempts + 1;
      const startedAt = new Date().toISOString();

      options.onAgentStart?.({
        agentCallId,
        label,
        phase: assignedPhase,
        prompt,
        model: displayModel,
        startedAt,
        agentConfig,
      });

      // Optional per-agent worktree isolation (deterministic name -> stable resume keys).
      let worktree: Worktree | undefined;
      if (agentOptions.isolation === "worktree") {
        worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
        if (!worktree.isolated) log(`isolation ignored for "${label}" (${worktree.reason})`);
      }
      // Fall back to the run-level baseCwd (run-level isolation) so the agent receives the
      // worktree cwd and rebuilds coding tools for it (agent.ts), not primary-cwd tools.
      const runCwd = worktree?.isolated ? worktree.cwd : baseCwd;

      // Captured from the subagent's real session usage; falls back to an
      // estimate when the provider reports no usage (total === 0). Usage is reset
      // per retry attempt so a failed attempt does not double-count the next one.
      let usage: AgentUsage | undefined;
      let agentTokens = 0;
      let agentUsage: AgentUsage | undefined;
      let contextWindow: AgentContextWindowStats | undefined;
      let contextWindowWarningEmitted = false;
      let compactHistory: AgentHistoryEntry[] | undefined;
      const recordTokens = (result: unknown): number => {
        const tokens = usage && usage.total > 0 ? usage.total : estimateTokens(result) + estimateTokens(prompt);
        if (usage) {
          shared.tokenUsage.input += usage.input;
          shared.tokenUsage.output += usage.output;
          shared.tokenUsage.cost += usage.cost;
          shared.tokenUsage.cacheRead += usage.cacheRead;
          shared.tokenUsage.cacheWrite += usage.cacheWrite;
          agentUsage = addAgentUsage(agentUsage, usage);
        }
        shared.tokenUsage.total += tokens;
        shared.spent += tokens;
        agentTokens += tokens;
        return tokens;
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          usage = undefined;
          contextWindow = undefined;
          contextWindowWarningEmitted = false;
          let attemptTokens = 0;
          let recordedAttempt = false;
          try {
            throwIfAborted();

            // Run agent with an abortable timeout. On timeout we abort the
            // attempt and wait for the underlying runner to settle before retrying,
            // releasing the limiter slot, or deleting an isolated worktree.
            const result = await runWithAbortableTimeout(
              (attemptSignal) =>
                agentRunner.run(prompt, {
                  label,
                  schema: agentOptions.schema,
                  signal: attemptSignal,
                  instructions: agentInstructions,
                  model: modelSpec,
                  tier: agentOptions.tier,
                  // Tool policy: an explicit per-call `tools`/`disallowedTools` override wins
                  // (it is part of the resume call-hash, so it is safe to widen a single call).
                  // Otherwise narrow: intersect the agentType allowlist with the harness
                  // allowlist (an agentType may only narrow the harness authority, never mask
                  // it), and union the denylists. A disjoint intersection yields deny-all
                  // (applyToolPolicy honors []). This keeps resume hashes sound: the same
                  // effective harness + agentType produce the same narrowed policy.
                  toolNames:
                    agentOptions.tools ?? intersectToolAllowlists([agentDef?.tools, effectiveHarnessExpansion.tools]),
                  disallowedToolNames:
                    agentOptions.disallowedTools ??
                    unionToolDenylists([agentDef?.disallowedTools, effectiveHarnessExpansion.disallowedTools]),
                  readOnly: effectiveReadOnly,
                  ctxReadGuardrail: effectiveHarnessCtxReadGuardrail,
                  // The workflow layer is the single resolution authority: it passes
                  // the fully-resolved primitives, so the raw mode name is intentionally
                  // NOT forwarded (a project-mode name would be unknown to agent.ts's
                  // built-in registry and warn spuriously).
                  inheritProjectContext: ctx.inheritProjectContext,
                  systemPromptMode: ctx.systemPromptMode,
                  inheritSkills: ctx.inheritSkills,
                  inheritMainRules: ctx.inheritMainRules,
                  // Role prompt → system prompt only under "replace"; otherwise undefined.
                  systemPromptText: roleSystemPrompt,
                  cwd: runCwd,
                  transcriptDir: options.transcriptDir,
                  onModelResolved: (id: string) => {
                    displayModel = id;
                  },
                  onModelFallback: (spec: string) => {
                    // Make the silent degrade visible in /workflows, not just console.
                    log(`${label}: model "${spec}" unavailable — using the session default`);
                  },
                  onUsage: (u: AgentUsage) => {
                    usage = u;
                  },
                  onContextWindow: (stats: AgentContextWindowStats) => {
                    contextWindow = withContextWindowPolicy(stats, {
                      maxContextTokens: effectiveMaxContextTokens,
                      reserve: effectiveContextReserveTokens,
                    });
                  },
                  maxContextTokens: effectiveMaxContextTokens,
                  contextReserveTokens: effectiveContextReserveTokens,
                  compactionPolicy: effectiveCompactionPolicy,
                  workflowRunId: runId,
                  phase: assignedPhase,
                  onHistory: (history: AgentHistoryEntry[]) => {
                    compactHistory = history;
                    options.onAgentHistory?.({ label, phase: assignedPhase, history });
                  },
                } as any),
              timeout,
              label,
              runSignal,
            );

            throwIfAborted();
            if (isEmptyTextAgentResult(result, agentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }

            attemptTokens = recordTokens(result);
            recordedAttempt = true;
            contextWindow = contextWindowForAttempt(contextWindow, usage, attemptTokens, {
              maxContextTokens: effectiveMaxContextTokens,
              reserve: effectiveContextReserveTokens,
            });
            contextWindowWarningEmitted = emitContextWindowWarning(
              label,
              contextWindow,
              log,
              contextWindowWarningEmitted,
            );
            const successContextError = contextWindowExceededError(label, contextWindow);
            if (successContextError) throw successContextError;
            const endedAt = new Date().toISOString();
            const finalUsage = alignAgentUsageTotal(agentUsage, agentTokens);
            options.onAgentJournal?.({
              index: callIndex,
              hash: callHash,
              result,
              label,
              phase: assignedPhase,
              tokens: agentTokens,
              usage: finalUsage,
              contextWindow,
              model: displayModel,
              startedAt,
              endedAt,
              history: compactHistory,
            });
            options.onAgentEnd?.({
              agentCallId,
              label,
              phase: assignedPhase,
              result,
              tokens: agentTokens,
              usage: finalUsage,
              contextWindow,
              worktree: runCwd,
              model: displayModel,
              agentConfig,
              startedAt,
              endedAt,
            });
            return result;
          } catch (error) {
            if (runSignal.aborted) throw error;

            const workflowError = wrapError(error, { agentLabel: label });
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            if (!recordedAttempt) attemptTokens = recordTokens(null);

            contextWindow = contextWindowForAttempt(contextWindow, usage, attemptTokens, {
              maxContextTokens: effectiveMaxContextTokens,
              reserve: effectiveContextReserveTokens,
            });
            contextWindowWarningEmitted = emitContextWindowWarning(
              label,
              contextWindow,
              log,
              contextWindowWarningEmitted,
            );
            const capError = contextWindowExceededError(label, contextWindow);
            const finalUsage = alignAgentUsageTotal(agentUsage, agentTokens);
            if (capError) {
              options.onAgentEnd?.({
                agentCallId,
                label,
                phase: assignedPhase,
                result: null,
                tokens: agentTokens,
                usage: finalUsage,
                contextWindow,
                worktree: runCwd,
                model: displayModel,
                agentConfig,
                error: capError.message,
                errorCode: capError.code,
                recoverable: capError.recoverable,
                startedAt,
                endedAt: new Date().toISOString(),
              });
              throw capError;
            }

            if (workflowError.recoverable && attempt < maxAttempts) {
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              continue;
            }
            options.onAgentEnd?.({
              agentCallId,
              label,
              phase: assignedPhase,
              result: null,
              tokens: agentTokens,
              usage: finalUsage,
              contextWindow,
              worktree: runCwd,
              model: displayModel,
              agentConfig,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
              startedAt,
              endedAt: new Date().toISOString(),
            });

            if (workflowError.recoverable) {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              if (dagNodeScope.getStore() === true) throw workflowError;
              return null;
            }
            throw workflowError;
          }
        }
        return null;
      } finally {
        // Always tear down the worktree, even on timeout/abort.
        if (worktree?.isolated) await removeWorktree(worktree);
      }
    });
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    if (thunks.length > MAX_FANOUT_ITEMS) {
      throw new WorkflowError(
        `parallel() accepts at most ${MAX_FANOUT_ITEMS} items (got ${thunks.length})`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    const settled = await Promise.all(
      thunks.map(async (thunk, index): Promise<{ ok: true; value: unknown } | { ok: false; error: WorkflowError }> => {
        try {
          return { ok: true, value: await thunk() };
        } catch (error) {
          if (runSignal.aborted) throw error;
          const workflowError = wrapError(error);
          // Non-recoverable failures (token budget / agent limit exhausted) must
          // halt the whole run, exactly like a directly-awaited agent() — not be
          // swallowed into a null in the result array. Inside dag() nodes, even
          // recoverable helper failures should fail the node so dependents skip.
          if (!workflowError.recoverable) throw workflowError;
          if (dagNodeScope.getStore() === true && workflowError.agentLabel) {
            return { ok: false, error: workflowError };
          }
          log(`parallel[${index}] failed: ${workflowError.message}`);
          return { ok: true, value: null };
        }
      }),
    );
    const failure = settled.find((entry): entry is { ok: false; error: WorkflowError } => !entry.ok);
    if (failure) throw failure.error;
    return settled.map((entry) => (entry.ok ? entry.value : undefined));
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    if (items.length > MAX_FANOUT_ITEMS) {
      throw new WorkflowError(
        `pipeline() accepts at most ${MAX_FANOUT_ITEMS} items (got ${items.length})`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    const settled = await Promise.all(
      items.map(async (item, index): Promise<{ ok: true; value: unknown } | { ok: false; error: WorkflowError }> => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (runSignal.aborted) throw error;
            const workflowError = wrapError(error);
            // Non-recoverable failures halt the whole run (see parallel()). Inside
            // dag() nodes, recoverable helper failures fail the node after sibling
            // item promises settle instead of becoming successful null data.
            if (!workflowError.recoverable) throw workflowError;
            if (dagNodeScope.getStore() === true && workflowError.agentLabel)
              return { ok: false, error: workflowError };
            log(`pipeline[${index}] failed: ${workflowError.message}`);
            return { ok: true, value: null };
          }
        }
        return { ok: true, value };
      }),
    );
    const failure = settled.find((entry): entry is { ok: false; error: WorkflowError } => !entry.ok);
    if (failure) throw failure.error;
    return settled.map((entry) => (entry.ok ? entry.value : undefined));
  };

  // Dependency-aware DAG: run nodes in deterministic waves honoring `dependsOn`,
  // cascade-skipping the dependents of any failed node so a dead upstream never
  // hangs the wave. Wave nodes execute in stable declaration order (rather than
  // Promise completion order) so agent() callSeq remains deterministic even when
  // a node awaits before calling agent(). Agent calls still use the shared limiter.
  const dag = async (nodes: Array<DagNode<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(nodes)) throw new TypeError("dag() expects an array of { id, dependsOn?, run } nodes");
    if (nodes.length > MAX_FANOUT_ITEMS) {
      throw new WorkflowError(
        `dag() accepts at most ${MAX_FANOUT_ITEMS} nodes (got ${nodes.length})`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    try {
      return await runDag(nodes, async (batch) => {
        const results: WaveResult<unknown>[] = [];
        for (const { node, deps } of batch) {
          try {
            throwIfAborted();
            const value = await dagNodeScope.run(true, async () => await node.run(deps));
            throwIfAborted();
            results.push({ id: node.id, ok: true, value });
          } catch (error) {
            // Non-recoverable agent/workflow failures halt the whole run like
            // parallel()/pipeline(). Recoverable node errors are contained: the
            // node fails and its dependents cascade-skip.
            const workflowError = wrapError(error);
            if (runSignal.aborted || !workflowError.recoverable) throw workflowError;
            log(`dag["${node.id}"] failed: ${workflowError.message}`);
            results.push({ id: node.id, ok: false, error: workflowError.message });
          }
        }
        return results;
      });
    } catch (error) {
      if (error instanceof DagValidationError) {
        throw new WorkflowError(error.message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
      }
      throw error;
    }
  };

  // Nested workflow(): run a saved workflow (or a raw script) inline, sharing this
  // run's limiter/counters/budget so the global caps hold. One level deep only.
  const workflowFn = async (nameOrScript: string, childArgs?: unknown) => {
    throwIfAborted();
    if (shared.depth >= 1) {
      throw new WorkflowError("workflow() can nest only one level deep", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    const resolved = options.loadSavedWorkflow?.(String(nameOrScript));
    const childScript = resolved ?? String(nameOrScript);
    shared.depth++;
    try {
      const child = await runWorkflow(childScript, {
        ...options,
        args: childArgs,
        sharedRuntime: shared,
        signal: runSignal,
        // A nested run is its own script; never reuse the parent's resume journal.
        resumeJournal: undefined,
        resumeFromRunId: undefined,
        runId: `${runId}-nested${shared.depth}`,
        persistLogs: false,
      });
      return child.result;
    } finally {
      shared.depth--;
    }
  };

  // ── Quality-pattern stdlib: reusable, deterministic helpers built purely on
  // agent()/parallel() (so callSeq ordering stays stable and resume keeps working).
  // Injected as globals so workflow scripts compose them directly. ──

  const VERIFY_SCHEMA = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const reviewers = Math.max(1, opts.reviewers ?? 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallel(
        Array.from(
          { length: reviewers },
          (_v, i) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
            ),
        ),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    return { real: votes.length > 0 && realCount / votes.length >= threshold, realCount, total: votes.length, votes };
  };

  const JUDGE_SCHEMA = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  };
  const judgePanel = async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    const judges = Math.max(1, opts.judges ?? 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att);
          const js = (
            await parallel(
              Array.from(
                { length: judges },
                (_v, j) => () =>
                  agent(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    {
                      label: `judge ${idx + 1}.${j + 1}`,
                      schema: JUDGE_SCHEMA,
                    },
                  ),
              ),
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : 0;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index.
    let best = scored[0];
    for (const s of scored) if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s;
    return best;
  };

  const loopUntilDry = async (opts: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    if (!opts || typeof opts.round !== "function")
      throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
    const maxRounds = opts.maxRounds ?? 50;
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      let items: unknown[];
      try {
        items = (await opts.round(r)) ?? [];
      } catch (error) {
        // Budget / agent-limit exhaustion: return the partial result, don't abort.
        const code = (error as { code?: string })?.code;
        if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) break;
        throw error;
      }
      const fresh = (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    return all;
  };

  const COMPLETENESS_SCHEMA = {
    type: "object",
    properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    required: ["complete"],
  };
  const completenessCheck = (taskArgs: unknown, results: unknown) =>
    agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA },
    );

  // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
  // agent() pattern, but each attempt is a real agent() call so it auto-journals
  // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
  // and a delay has no resume value. NOTE: attempt N+1's call hash depends on N's
  // live result, so a retry/gate chain cache-miss-cascades on resume (correct).
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      if (!opts.until || opts.until(last)) return last;
    }
    return last; // attempts exhausted — return the last result (caller inspects it)
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      const verdict = await validator(last);
      if (verdict?.ok) return { ok: true, value: last, attempts: i + 1 };
      feedback = verdict?.feedback; // fed into the next attempt
    }
    return { ok: false, value: last, attempts };
  };

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless (no UI threaded in): takes the
  // declared default and journals THAT, so a detached/background run never hangs.
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    throwIfAborted();
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    const callIndex = state.callSeq++;
    const callHash = hashCheckpoint(promptText, checkpointOptions);
    const cached = options.resumeJournal?.get(callIndex);
    if (cached != null && cached.hash === callHash && callIndex < state.firstMiss) {
      shared.agentCount++;
      return cached.result; // replay the journaled human reply
    }
    if (cached == null || cached.hash !== callHash) state.firstMiss = Math.min(state.firstMiss, callIndex);
    shared.agentCount++;

    let reply: unknown;
    if (options.confirm) {
      reply = await options.confirm(promptText, checkpointOptions);
    } else if (checkpointOptions.headless === "abort") {
      throw new WorkflowError(
        `checkpoint "${promptText}" needs human input but none is available (headless run)`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
    } else {
      reply = checkpointOptions.default ?? true;
    }
    throwIfAborted();
    options.onAgentJournal?.({ index: callIndex, hash: callHash, result: reply });
    return reply;
  };

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    dag,
    workflow: workflowFn,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    retry,
    gate,
    checkpoint,
    log,
    phase,
    setSemanticStatus,
    checkFinalization,
    prototypeSafetyCheck,
    stageCheck,
    compactFeedback: compactFeedbackForWorkflow,
    renderCorrectionDelta,
    renderStageCheckFeedback,
    args: options.args,
    runId,
    workflowRunId: runId,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  let result: unknown;
  try {
    // Guard synchronous script setup with the 30000 ms runInContext timeout. The
    // async agent body runs after the Promise is returned, so that timeout only
    // bounds synchronous parse/setup; wrap the returned Promise too so trusted
    // scripts that suspend forever are rejected by a real wall-clock timer.
    const execution = Promise.resolve(
      new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context, {
        timeout: SCRIPT_TIMEOUT_MS,
      }),
    );
    result = await withWorkflowTimeout(execution, workflowTimeoutMs, meta.name, workflowController);
  } finally {
    removeExternalAbortListener?.();
  }

  // Persist logs
  const logFile = logger.persist();
  if (logFile) {
    log(`Logs persisted to ${logFile}`);
  }

  // Emit final token usage
  options.onTokenUsage?.(shared.tokenUsage);

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: shared.agentCount,
    durationMs: Date.now() - started,
    runId,
    tokenUsage: shared.tokenUsage,
    harnessSelection,
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new WorkflowError(
      "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression":
      return evaluateObjectLiteral(node, path);
    case "ArrayExpression": {
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    }
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function evaluateObjectLiteral(node: AnyNode, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties as AnyNode[]) {
    if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
    if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
    if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
    if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
    const key = propertyKey(prop.key as AnyNode, path);
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`reserved key name not allowed in ${path}: ${key}`);
    }
    out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
  }
  return out;
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

/** Stable identity hash for an agent() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string, options: CheckpointOptions): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Compute a stable hash for an agent() call, used as the resume cache key.
 *
 * @param harnessKey - Stable harness selection/expansion key. When the
 *   selection is the default 'none' sentinel, this must reproduce the same
 *   string as older code that did not include harness information, so that
 *   changing the harness type, config, or expanded tool policy busts every
 *   cached agent result on resume while default selections preserve existing
 *   hashes.
 */
function hashAgentCall(
  prompt: string,
  model: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  effectiveContextPolicy: { maxContextTokens?: number; contextReserveTokens?: number },
  agentDefKey: string | null,
  resolvedContext: ContextPrimitives,
  harnessKey: string,
  hashOptions: { includeContextPolicy?: boolean } = {},
): string {
  const identityValue: Record<string, unknown> = {
    prompt,
    model: model ?? null,
    tier: options.tier ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved context primitives are the material session posture. Include them
    // (not just raw options.contextMode) so a run-level legacy/focused switch or a
    // project-mode registry change cannot replay stale agent output on resume.
    context: {
      inheritProjectContext: resolvedContext.inheritProjectContext,
      systemPromptMode: resolvedContext.systemPromptMode,
      inheritSkills: resolvedContext.inheritSkills,
      inheritMainRules: resolvedContext.inheritMainRules,
    },
    rawContext: {
      contextMode: options.contextMode ?? null,
      inheritProjectContext: options.inheritProjectContext ?? null,
      systemPromptMode: options.systemPromptMode ?? null,
      inheritSkills: options.inheritSkills ?? null,
      inheritMainRules: options.inheritMainRules ?? null,
    },
    toolPolicy: {
      tools: options.tools ?? null,
      disallowedTools: options.disallowedTools ?? null,
    },
    // Resolved definition (tools/model/prompt/context) so editing an agent .md
    // invalidates this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
  };
  // Harness selection snapshot: a change in harness_type or harness_config
  // invalidates every cached agent result on resume, but the 'none' sentinel
  // (default undefined selection) reproduces today's hashes — so unchanged
  // default runs still hit the cache.
  if (harnessKey !== '"none"') {
    identityValue.harness = harnessKey;
  }
  if (options.compactionPolicy !== undefined && options.compactionPolicy !== null) {
    identityValue.compactionPolicy = options.compactionPolicy;
  }
  if (hashOptions.includeContextPolicy !== false) {
    identityValue.contextPolicy = {
      maxContextTokens: effectiveContextPolicy.maxContextTokens ?? null,
      contextReserveTokens: effectiveContextPolicy.contextReserveTokens ?? null,
    };
  }
  return createHash("sha256").update(JSON.stringify(identityValue)).digest("hex");
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
  roleAsSystemPrompt = false,
): string | undefined {
  const lines: string[] = [];
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  // When the resolved context mode is "replace", the role prompt is installed as
  // the session system prompt instead of the task, so skip it here to avoid
  // duplicating it across both the system prompt and the task turn.
  if (def?.prompt && !roleAsSystemPrompt) lines.push(def.prompt);
  else if (options.agentType && !def?.prompt) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function isLikelyProjectRootRelativeStageTarget(targetFile: string): boolean {
  return /^(apps|packages|services|libs)\//.test(targetFile);
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function resolveContextPolicyValue(callValue: unknown, runValue: unknown): number | undefined {
  if (callValue === null) return undefined;
  const callNormalized = normalizeOptionalPositiveInteger(callValue);
  if (callNormalized !== undefined) return callNormalized;
  return normalizeOptionalPositiveInteger(runValue);
}

function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function withContextWindowPolicy(
  stats: AgentContextWindowStats,
  options: { maxContextTokens?: number; reserve?: number },
): AgentContextWindowStats {
  const adjusted =
    options.reserve !== undefined && stats.runtimeContextWindow !== undefined
      ? buildAgentContextWindowStats(
          { input: stats.contextTokens, total: stats.contextTokens },
          {
            runtimeContextWindow: stats.runtimeContextWindow,
            reserve: options.reserve,
            maxContextTokens: options.maxContextTokens,
          },
        )
      : { ...stats, maxContextTokens: options.maxContextTokens ?? stats.maxContextTokens };
  if (options.maxContextTokens === undefined) return adjusted;
  return buildAgentContextWindowStats(
    { input: adjusted.contextTokens, total: adjusted.contextTokens },
    {
      runtimeContextWindow: adjusted.runtimeContextWindow,
      reserve: adjusted.reserve,
      maxContextTokens: options.maxContextTokens,
    },
  );
}

function contextWindowFromUsage(
  usage: AgentUsage | undefined,
  tokens: number | undefined,
  options: { maxContextTokens?: number; reserve?: number } = {},
): AgentContextWindowStats | undefined {
  if (!usage && typeof tokens !== "number") return undefined;
  return buildAgentContextWindowStats(
    { input: usage?.input ?? 0, total: usage?.total ?? tokens ?? 0 },
    { reserve: options.reserve, maxContextTokens: options.maxContextTokens },
  );
}

function contextWindowForAttempt(
  reported: AgentContextWindowStats | undefined,
  usage: AgentUsage | undefined,
  tokens: number | undefined,
  options: { maxContextTokens?: number; reserve?: number } = {},
): AgentContextWindowStats | undefined {
  const adjusted = reported ? withContextWindowPolicy(reported, options) : undefined;
  if (adjusted && adjusted.contextTokens > 0) return adjusted;
  if (!usage && typeof tokens !== "number") return adjusted;
  const contextTokens = usage && usage.input > 0 ? usage.input : usage && usage.total > 0 ? usage.total : (tokens ?? 0);
  return buildAgentContextWindowStats(
    { input: contextTokens, total: contextTokens },
    {
      runtimeContextWindow: adjusted?.runtimeContextWindow,
      reserve: options.reserve ?? adjusted?.reserve,
      maxContextTokens: options.maxContextTokens,
    },
  );
}

function contextWindowExceededError(
  label: string,
  stats: AgentContextWindowStats | undefined,
): WorkflowError | undefined {
  if (!stats?.exceededMaxContextTokens) return undefined;
  return new WorkflowError(
    stats.warning ?? `agent "${label}" exceeded maxContextTokens`,
    WorkflowErrorCode.CONTEXT_WINDOW_EXCEEDED,
    {
      recoverable: false,
      agentLabel: label,
      details: stats,
    },
  );
}

function emitContextWindowWarning(
  label: string,
  stats: AgentContextWindowStats | undefined,
  log: (message: string) => void,
  alreadyEmitted = false,
): boolean {
  if (alreadyEmitted || !stats?.warning) return alreadyEmitted;
  log(`[context-window] ${label}: ${stats.warning}`);
  return true;
}

function addAgentUsage(current: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  return {
    input: (current?.input ?? 0) + next.input,
    output: (current?.output ?? 0) + next.output,
    total: (current?.total ?? 0) + next.total,
    cost: (current?.cost ?? 0) + next.cost,
    cacheRead: (current?.cacheRead ?? 0) + next.cacheRead,
    cacheWrite: (current?.cacheWrite ?? 0) + next.cacheWrite,
  };
}

function alignAgentUsageTotal(usage: AgentUsage | undefined, tokens: number): AgentUsage | undefined {
  if (!usage) return undefined;
  if (tokens <= usage.total) return usage;
  return { ...usage, total: tokens };
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

function linkAbortSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => {};
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

/**
 * Run one agent attempt with an abortable timeout. A timeout aborts the attempt
 * and then awaits the underlying runner before returning control to the limiter,
 * so retries/worktree cleanup cannot race a still-running timed-out agent.
 */
async function runWithAbortableTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number | null,
  label: string,
  parentSignal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const unlinkParent = linkAbortSignal(parentSignal, controller);
  const attemptSignal = controller.signal;
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(run(attemptSignal));
  } catch (error) {
    unlinkParent();
    throw error;
  }
  if (ms === null) {
    try {
      return await promise;
    } finally {
      unlinkParent();
    }
  }

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutError = new WorkflowError(
    `Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
    WorkflowErrorCode.AGENT_TIMEOUT,
    { recoverable: true, agentLabel: label },
  );
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
      controller.abort(timeoutError);
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch (error) {
    if (!timedOut) throw error;
    // The timeout is the public result. Still wait for the runner to observe the
    // abort and settle before a retry or finally-block can proceed.
    try {
      await promise;
    } catch {
      // Ignore the runner's abort error; report the timeout consistently.
    }
    throw timeoutError;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    unlinkParent();
  }
}

/**
 * Bounds async workflow scripts that suspend forever. This is a trusted-code
 * safety belt, not a same-process CPU-loop sandbox; on timeout we abort the
 * workflow signal so any in-flight agents can clean up.
 */
async function withWorkflowTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  workflowName: string,
  controller: AbortController,
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  const races: Promise<T | never>[] = [promise];
  const abortError = () =>
    controller.signal.reason instanceof WorkflowError
      ? controller.signal.reason
      : new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });

  races.push(
    new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => reject(abortError());
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    }),
  );

  if (ms !== null) {
    const timeoutError = new WorkflowError(
      `Workflow "${workflowName}" timed out after ${ms}ms`,
      WorkflowErrorCode.WORKFLOW_TIMEOUT,
      { recoverable: true },
    );
    races.push(
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, ms);
      }),
    );
  }

  try {
    return (await Promise.race(races)) as T;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener?.();
  }
}
