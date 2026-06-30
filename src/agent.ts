import { existsSync, mkdirSync } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  type ContextUsage,
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { type AgentHistoryEntry, compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import {
  resolveWorkflowCompactionPolicy,
  type WorkflowCompactionPolicyDecision,
  type WorkflowCompactionPolicyName,
} from "./compaction-policy.js";
import { emitCompactionTelemetry } from "./compaction-telemetry.js";
import {
  DEFAULT_CONTEXT_MODE,
  needsResourceLoader,
  resolveContextMode,
  resourceLoaderFlags,
  type SystemPromptMode,
} from "./context-mode.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { type GuardCtxReadOptions, guardCtxReadPath } from "./lean-ctx-guardrail.js";
import { loadModelTierConfig, type ModelTierConfig, resolveTierModel } from "./model-tier-config.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(text: string, schema: TSchema): T | undefined {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
}

/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
  messages: unknown[];
}

/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: { maxSchemaRetries?: number; signal?: AbortSignal; label?: string; checkContextCap?: () => void },
  lastText: (messages: unknown[]) => string,
): Promise<T> {
  options.checkContextCap?.();
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  // Restrict to the schema tool so the only useful next action is calling it
  // (takes effect on the next prompt turn). Best-effort.
  try {
    session.setActiveToolsByName?.(["structured_output"]);
  } catch {
    // ignore — the re-prompt alone still drives most models to comply
  }
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    options.checkContextCap?.();
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    await session.prompt(
      "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
    );
    options.checkContextCap?.();
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  // A repair re-prompt can itself hit the provider limit. Surface that as the real
  // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
  throwIfProviderLimit(session.messages, options.label);

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
export function resolveAgentModelSpec(
  options: { model?: string; tier?: string },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
): string | undefined {
  if (options.model) return options.model;
  const config = loadConfig();
  if (options.tier) {
    return (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel;
  }
  // Untagged agent: default to the configured medium tier when one exists.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) return medium;
  }
  return undefined;
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /**
   * The session's main model (`provider/modelId`). Used as a fallback when
   * resolving opts.tier and no model-tiers.json config exists. Without this,
   * a workflow using `{ tier: "small" }` would log a warning and fall through
   * to the session default when no config is saved yet.
   */
  mainModel?: string;
}

/**
 * List the user's currently available models (those with auth configured) as
 * `provider/modelId` specs. Used to tell the workflow author which models it may
 * route agents to. Best-effort: returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(): string[] {
  try {
    const dir = getAgentDir();
    const auth = AuthStorage.create(join(dir, "auth.json"));
    const registry = ModelRegistry.create(auth, join(dir, "models.json"));
    return registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  } catch {
    return [];
  }
}

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export type AgentContextWindowLevel = "ok" | "warn" | "critical" | "over" | "unknown";

export interface AgentContextWindowStats {
  /** Tokens currently occupying the model context, usually provider input tokens for the completed turn. */
  contextTokens: number;
  /** Model/runtime context window, when known. */
  runtimeContextWindow?: number;
  /** Reserved response/scratch tokens subtracted from runtimeContextWindow, when known. */
  reserve?: number;
  /** Runtime window minus reserve. */
  effectiveWindow?: number;
  /** contextTokens / effectiveWindow, when effectiveWindow is known. */
  occupancy?: number;
  /** Highest threshold crossed by this measurement. */
  threshold?: number;
  /** Human-readable severity for UI/telemetry. */
  level: AgentContextWindowLevel;
  /** Optional hard cap supplied by workflow policy. */
  maxContextTokens?: number;
  /** True when contextTokens exceeded maxContextTokens. */
  exceededMaxContextTokens?: boolean;
  /** Human-readable warning for UI/log/telemetry. */
  warning?: string;
}

export type WorkflowCtxReadGuardrailOptions = Omit<GuardCtxReadOptions, "cwd" | "exists" | "stat" | "realpath">;

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Called once with this subagent's real usage, read from the session right
   * before disposal. Fires on both the success and error paths so partial
   * usage is never lost. `total === 0` means the provider reported no usage.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
   * bare `modelId`. When it can't be resolved, the session default is used and
   * a warning is logged. When omitted, the session default applies.
   */
  model?: string;
  /**
   * Model tier name (e.g. "small", "medium", "big"). When set (and no explicit
   * `model` is given), the model is resolved from the user's model-tiers.json
   * config before `run()` starts, falling back to the session's main model when
   * the tier has no configured entry. An explicit `model` always takes priority,
   * so workflow scripts can use `{ tier: "small" }` for coarse routing without
   * caring which concrete model backs that tier.
   */
  tier?: string;
  /** Called with the resolved model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** Called when `model`/`tier`/phase resolved to a spec that wasn't found (fell back to session default). */
  onModelFallback?: (requestedSpec: string) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Called with model-window occupancy stats for this subagent, when measurable. */
  onContextWindow?: (stats: AgentContextWindowStats) => void;
  /** Per-subagent compaction policy. "auto" makes local/no-cache models compact earlier. */
  compactionPolicy?: WorkflowCompactionPolicyName | null;
  /** Workflow run id/phase used to scope compaction telemetry emitted by this subagent. */
  workflowRunId?: string;
  phase?: string;
  /** Hard cap for provider input/context tokens for this subagent. */
  maxContextTokens?: number;
  /** Override the model output/reserve tokens used to compute effective context window. */
  contextReserveTokens?: number;
  /** Run this agent in a different working directory (e.g. an isolated worktree). */
  cwd?: string;
  /**
   * Directory to persist this subagent's NDJSON transcript into. When set,
   * a real (file-backed) SessionManager is used so the full subagent message
   * stream survives session disposal — matching Claude Code's per-subagent
   * `agent-<id>.jsonl` transcript. When omitted, an in-memory session is used
   * (ad-hoc `agent()` with no run context) and nothing is written to disk.
   */
  transcriptDir?: string;
  /**
   * Restrict the subagent's coding tools to these names (an agentType
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * structured_output tool is always added after this filter, so a schema
   * still works under a restrictive allowlist.
   */
  toolNames?: string[];
  /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
  disallowedToolNames?: string[];
  /** Optional read-path guardrail options supplied by a harness_config expansion. */
  ctxReadGuardrail?: WorkflowCtxReadGuardrailOptions;
  /**
   * With `schema`: how many extra repair turns to allow if the model finishes
   * without calling structured_output. Each retry re-prompts (tools restricted to
   * structured_output) before falling back to strict prose extraction. Default 2.
   */
  maxSchemaRetries?: number;
  /**
   * Context-inheritance posture for this subagent (expands to the three
   * primitives below). When omitted, the explicit fields — else `inherit` —
   * apply. See context-mode.ts. Default `inherit` == today's behavior.
   */
  contextMode?: string;
  /** Load project AGENTS.md / context files into the subagent session. Default true. */
  inheritProjectContext?: boolean;
  /** "append": base prompt intact, role-as-task (default); "replace": role IS the base system prompt. */
  systemPromptMode?: SystemPromptMode;
  /** Load skills into the subagent session. Default true. */
  inheritSkills?: boolean;
  /**
   * Inherit the main-agent append channel (`.pi/APPEND_SYSTEM.md`) into this
   * subagent. Default false: the main session's orchestration-only rules do not
   * leak into subagents (OpenCode-style). Set true (or use the `legacy` mode) to
   * restore the pre-feature behavior where subagents inherited them.
   */
  inheritMainRules?: boolean;
  /**
   * The agentType role prompt to install AS the system prompt when the resolved
   * `systemPromptMode` is "replace". The workflow layer passes the agent `.md`
   * body here (and omits it from the task to avoid duplication). Ignored unless
   * the resolved mode is "replace".
   */
  systemPromptText?: string;
  /**
   * Read-only fence: when true, the subagent never receives write tools
   * (edit, bash, write). The fence is the last filter step so it cannot be
   * bypassed by an allowlist from `harness_config` or `agentType`.
   */
  readOnly?: boolean;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export function createGuardedReadOperations(cwd: string, guardrail: WorkflowCtxReadGuardrailOptions) {
  const remappedPaths = new Map<string, string>();
  const remap = (absolutePath: string): string =>
    remappedPaths.get(absolutePath) ?? resolveGuardedReadPath(cwd, absolutePath, guardrail);
  return {
    async access(absolutePath: string): Promise<void> {
      const guardedPath = resolveGuardedReadPath(cwd, absolutePath, guardrail);
      await fsAccess(guardedPath);
      if (guardedPath === absolutePath) {
        remappedPaths.delete(absolutePath);
      } else {
        remappedPaths.set(absolutePath, guardedPath);
      }
    },
    async readFile(absolutePath: string): Promise<Buffer> {
      return await fsReadFile(remap(absolutePath));
    },
    async detectImageMimeType(absolutePath: string): Promise<string | null> {
      return imageMimeType(remap(absolutePath));
    },
  };
}

export function applyCtxReadGuardrailToTools(
  baseTools: ToolDefinition[],
  cwd: string,
  guardrail: WorkflowCtxReadGuardrailOptions,
): ToolDefinition[] {
  const guardedReadTool = createCodingTools(cwd, {
    read: { operations: createGuardedReadOperations(cwd, guardrail) },
  }).find((tool) => tool.name === "read");
  if (!guardedReadTool) return baseTools;
  return baseTools.map((tool) => (tool.name === "read" ? guardedReadTool : tool));
}

function resolveGuardedReadPath(cwd: string, absolutePath: string, guardrail: WorkflowCtxReadGuardrailOptions): string {
  const normalizedPath = relativeToCwd(cwd, absolutePath);
  if (!normalizedPath) throw new Error(`Path escapes the repository: ${absolutePath}`);
  const outcome = guardCtxReadPath(normalizedPath, { cwd, ...guardrail });
  if (outcome.ok && outcome.normalizedPath) return resolve(cwd, outcome.normalizedPath);
  throw new Error([outcome.reason, outcome.fallbackHint].filter(Boolean).join(" "));
}

function relativeToCwd(cwd: string, absolutePath: string): string | undefined {
  const normalized = relative(cwd, absolutePath).split(sep).join("/") || ".";
  if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) return undefined;
  return normalized;
}

function imageMimeType(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function hasCtxReadGuardrailOptions(
  value: WorkflowCtxReadGuardrailOptions | undefined,
): value is WorkflowCtxReadGuardrailOptions {
  return value !== undefined && Object.values(value).some((entry) => entry !== undefined);
}

export function buildAgentContextWindowStats(
  usage: Pick<AgentUsage, "input" | "total">,
  options: { runtimeContextWindow?: number; reserve?: number; maxContextTokens?: number } = {},
): AgentContextWindowStats {
  const contextTokens = usage.input > 0 ? usage.input : usage.total;
  const runtimeContextWindow = positiveIntegerField(options.runtimeContextWindow);
  const reserve = positiveIntegerField(options.reserve);
  const effectiveWindow =
    runtimeContextWindow !== undefined ? Math.max(1, runtimeContextWindow - (reserve ?? 0)) : undefined;
  const occupancy = effectiveWindow !== undefined ? contextTokens / effectiveWindow : undefined;
  const threshold =
    occupancy === undefined
      ? undefined
      : occupancy >= 0.95
        ? 0.95
        : occupancy >= 0.85
          ? 0.85
          : occupancy >= 0.7
            ? 0.7
            : undefined;
  const exceededMaxContextTokens = options.maxContextTokens !== undefined && contextTokens > options.maxContextTokens;
  const level: AgentContextWindowLevel = exceededMaxContextTokens
    ? "over"
    : occupancy === undefined
      ? "unknown"
      : occupancy >= 1
        ? "over"
        : occupancy >= 0.95
          ? "critical"
          : occupancy >= 0.7
            ? "warn"
            : "ok";
  const warning = buildContextWindowWarning({
    contextTokens,
    effectiveWindow,
    occupancy,
    threshold,
    maxContextTokens: options.maxContextTokens,
    exceededMaxContextTokens,
  });
  return {
    contextTokens,
    runtimeContextWindow,
    reserve,
    effectiveWindow,
    occupancy,
    threshold,
    level,
    maxContextTokens: options.maxContextTokens,
    exceededMaxContextTokens,
    warning,
  };
}

export function buildContextWindowStatsForSession(
  usage: Pick<AgentUsage, "input" | "total">,
  contextUsage: ContextUsage | undefined,
  options: { runtimeContextWindow?: number; reserve?: number; maxContextTokens?: number } = {},
): AgentContextWindowStats {
  const currentContextTokens = positiveIntegerField(contextUsage?.tokens);
  const contextTokens = currentContextTokens ?? (usage.input > 0 ? usage.input : usage.total);
  return buildAgentContextWindowStats(
    { input: contextTokens, total: contextTokens },
    {
      runtimeContextWindow: positiveIntegerField(contextUsage?.contextWindow) ?? options.runtimeContextWindow,
      reserve: options.reserve,
      maxContextTokens: options.maxContextTokens,
    },
  );
}

function buildContextWindowWarning(input: {
  contextTokens: number;
  effectiveWindow?: number;
  occupancy?: number;
  threshold?: number;
  maxContextTokens?: number;
  exceededMaxContextTokens?: boolean;
}): string | undefined {
  if (input.exceededMaxContextTokens && input.maxContextTokens !== undefined) {
    return `context tokens ${input.contextTokens.toLocaleString()} exceeded configured cap ${input.maxContextTokens.toLocaleString()}`;
  }
  if (input.occupancy === undefined || input.threshold === undefined) return undefined;
  const pct = Math.round(input.occupancy * 100);
  const effective = input.effectiveWindow ? `/${input.effectiveWindow.toLocaleString()}` : "";
  return `context window ${pct}% used (${input.contextTokens.toLocaleString()}${effective} tokens)`;
}

function positiveIntegerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function emitCompactionPolicyTelemetry(
  decision: WorkflowCompactionPolicyDecision,
  input: {
    label?: string;
    phase?: string;
    workflowRunId?: string;
    modelSpec?: string;
    model?: Partial<Model<any>>;
    baseSettings: { reserveTokens: number; keepRecentTokens: number };
  },
): void {
  const configuredWindow = positiveIntegerField(input.model?.contextWindow);
  const reserve = decision.settings?.reserveTokens ?? input.baseSettings.reserveTokens;
  emitCompactionTelemetry({
    type: "workflow_compaction_policy",
    workflowRunId: input.workflowRunId,
    phase: input.phase,
    trigger: "agent_start",
    configuredWindow,
    runtimeContextWindow: configuredWindow,
    reserve,
    effectiveWindow: configuredWindow ? Math.max(1, configuredWindow - reserve) : undefined,
    compactionKeepRecentTokens: decision.settings?.keepRecentTokens ?? input.baseSettings.keepRecentTokens,
    compactionPolicy: decision.policy,
    compactionPolicyReason: decision.reason,
    compactionCacheValue: decision.cacheValue,
    compactor: "pi-sdk-auto",
    suppressedByCacheHot: false,
    source: [input.model?.provider, input.model?.id].filter(Boolean).join("/") || input.modelSpec || undefined,
  });
}

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
  private registry?: ModelRegistry;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
  }

  private getRegistry(): ModelRegistry {
    if (!this.registry) {
      const dir = getAgentDir();
      // Same agentDir/auth files createAgentSession uses by default, so a model
      // resolved here carries valid credentials.
      const auth = AuthStorage.create(join(dir, "auth.json"));
      this.registry = ModelRegistry.create(auth, join(dir, "models.json"));
    }
    return this.registry;
  }

  /**
   * Resolve a model spec to a Model. Accepts `provider/modelId` (unambiguous)
   * or a bare `modelId` (prefers auth-configured models, then any known model).
   * Returns undefined when nothing matches.
   */
  private resolveModel(spec: string): Model<any> | undefined {
    const registry = this.getRegistry();
    const slash = spec.indexOf("/");
    if (slash > 0) {
      return registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    }
    return registry.getAvailable().find((m) => m.id === spec) ?? registry.getAll().find((m) => m.id === spec);
  }

  private resolveSettingsDefaultModel(settingsManager: SettingsManager): Model<any> | undefined {
    const provider = settingsManager.getDefaultProvider();
    const modelId = settingsManager.getDefaultModel();
    if (provider && modelId) return this.getRegistry().find(provider, modelId);
    return modelId ? this.resolveModel(modelId) : undefined;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    // Per-call cwd (e.g. a worktree) needs coding tools bound to that directory,
    // since tools capture their cwd at construction and can't be relocated.
    const runCwd = options.cwd ?? this.cwd;
    const baseToolsForCwd = runCwd === this.cwd ? this.baseTools : createCodingTools(runCwd);
    const baseTools = hasCtxReadGuardrailOptions(options.ctxReadGuardrail)
      ? applyCtxReadGuardrailToTools(baseToolsForCwd, runCwd, options.ctxReadGuardrail)
      : baseToolsForCwd;
    // Apply the agentType tool policy BEFORE adding structured_output, so a
    // restrictive allowlist never strips the schema tool.
    const customTools: ToolDefinition[] = applyToolPolicy(
      [...baseTools, ...(options.tools ?? [])],
      options.toolNames,
      options.disallowedToolNames,
      { readOnly: options.readOnly },
    );

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    // Resolve the model spec (explicit model > tier > session default). This
    // composes with phase-based routing in workflow.ts, which only supplies
    // options.model when a phase pattern matches — so an explicit model wins.
    const modelSpec = resolveAgentModelSpec(options, this.mainModel);

    // Resolve a requested model spec to a Model object. A given-but-unresolved
    // spec falls back to the session default (with a warning) rather than failing.
    let resolvedModel: Model<any> | undefined;
    if (modelSpec) {
      resolvedModel = this.resolveModel(modelSpec);
      if (resolvedModel) {
        options.onModelResolved?.(`${resolvedModel.provider}/${resolvedModel.id}`);
      } else {
        console.warn(`[workflow] model "${modelSpec}" not found; using session default`);
        options.onModelFallback?.(modelSpec);
      }
    }

    const agentDir = getAgentDir();
    // Single SettingsManager shared by the session and (when built) the loader, so
    // the subagent inherits the user's default provider/model exactly as today.
    const settingsManager = SettingsManager.create(this.cwd, agentDir);
    const settingsDefaultModel = this.resolveSettingsDefaultModel(settingsManager);
    const activeModel =
      resolvedModel ??
      (this.sessionOptions.model as Partial<Model<any>> | undefined) ??
      (modelSpec === undefined && this.mainModel ? this.resolveModel(this.mainModel) : undefined) ??
      settingsDefaultModel;
    const baseCompactionSettings = settingsManager.getCompactionSettings();
    const resolvedModelSpec = resolvedModel ? modelSpec : undefined;
    const compactionPolicy = resolveWorkflowCompactionPolicy({
      requested: options.compactionPolicy,
      modelSpec: resolvedModelSpec,
      model: activeModel,
      contextWindow: positiveIntegerField(activeModel?.contextWindow),
    });
    if (compactionPolicy.settings) {
      settingsManager.applyOverrides({ compaction: compactionPolicy.settings });
    }
    emitCompactionPolicyTelemetry(compactionPolicy, {
      label: options.label,
      phase: options.phase,
      workflowRunId: options.workflowRunId,
      modelSpec: resolvedModelSpec,
      model: activeModel,
      baseSettings: baseCompactionSettings,
    });

    // Resolve the context-inheritance posture (run options are the runtime layer;
    // any frontmatter layer was already folded in by the workflow layer, which
    // passes explicit primitives that win over a mode). `inherit` (the default)
    // resolves to needsResourceLoader === false, so the block below is skipped and
    // the session is constructed exactly as before — the backward-compat gate.
    const { primitives: ctx, unknownMode } = resolveContextMode(undefined, {
      contextMode: options.contextMode,
      inheritProjectContext: options.inheritProjectContext,
      systemPromptMode: options.systemPromptMode,
      inheritSkills: options.inheritSkills,
      inheritMainRules: options.inheritMainRules,
    });
    if (unknownMode) {
      console.warn(`[workflow] unknown contextMode "${unknownMode}"; using "${DEFAULT_CONTEXT_MODE}"`);
    }
    let resourceLoader: ResourceLoader | undefined;
    if (needsResourceLoader(ctx)) {
      // Enforcement mapping lives in resourceLoaderFlags (pure + unit-tested):
      // inheritProjectContext:false → noContextFiles; inheritSkills:false → noSkills;
      // inheritMainRules:false → appendSystemPrompt:[] (block `.pi/APPEND_SYSTEM.md`);
      // replace → role prompt AS the base system prompt (workflow layer omits it from the task).
      // The SDK's own default loader uses exactly { cwd, agentDir, settingsManager }
      // (createAgentSession), so adding only these overrides loses no other config.
      const flags = resourceLoaderFlags(ctx, options.systemPromptText);
      const loader = new DefaultResourceLoader({
        cwd: runCwd,
        agentDir,
        settingsManager,
        noContextFiles: flags.noContextFiles,
        noSkills: flags.noSkills,
        systemPrompt: flags.systemPrompt,
        appendSystemPrompt: flags.appendSystemPrompt,
      });
      await loader.reload();
      resourceLoader = loader;
    }

    // Persist the subagent's full message stream to disk when a transcript dir is
    // provided (workflow runs), so a failed run is debuggable — matching Claude
    // Code's per-subagent `agent-<id>.jsonl` transcript. Ad-hoc `agent()` with no
    // run context keeps the in-memory session so nothing is written to disk.
    let sessionManager: SessionManager;
    if (options.transcriptDir) {
      try {
        if (!existsSync(options.transcriptDir)) mkdirSync(options.transcriptDir, { recursive: true });
      } catch {
        // Best-effort: SessionManager.create will also mkdirSync. Never let a
        // transient FS failure downgrade a run to in-memory silently.
      }
      sessionManager = SessionManager.create(runCwd, options.transcriptDir);
    } else {
      sessionManager = SessionManager.inMemory();
    }
    const { session } = await createAgentSession({
      cwd: runCwd,
      agentDir,
      sessionManager,
      // Use real SettingsManager to inherit user's default provider/model settings.
      // SettingsManager.inMemory() doesn't load ~/.pi/settings.json, so subagents
      // would fall back to the first available model (e.g. openai-codex) which may
      // not have valid auth, causing silent empty responses.
      settingsManager,
      customTools,
      // A custom resource loader is supplied only for a non-default context mode;
      // otherwise createAgentSession builds its own DefaultResourceLoader as before.
      ...(resourceLoader ? { resourceLoader } : {}),
      ...this.sessionOptions,
      // Per-call model wins over any sessionOptions.model.
      ...(resolvedModel ? { model: resolvedModel } : {}),
    });

    let removeAbortListener: (() => void) | undefined;
    let removeSessionListener: (() => void) | undefined;
    let lastHistoryEmit = 0;
    let usageEmitted = false;
    const emitHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
    const readUsageAndContext = (): { usage: AgentUsage; contextWindow: AgentContextWindowStats } | undefined => {
      try {
        const { tokens, cost } = session.getSessionStats();
        const usage: AgentUsage = {
          input: tokens.input,
          output: tokens.output,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          total: tokens.total,
          cost,
        };
        const contextUsage = session.getContextUsage();
        return {
          usage,
          contextWindow: buildContextWindowStatsForSession(usage, contextUsage, {
            runtimeContextWindow: positiveIntegerField(activeModel?.contextWindow),
            reserve: positiveIntegerField(options.contextReserveTokens) ?? positiveIntegerField(activeModel?.maxTokens),
            maxContextTokens: positiveIntegerField(options.maxContextTokens),
          }),
        };
      } catch {
        // Usage/context stats are best-effort; never let stats failure mask the real result/error.
        return undefined;
      }
    };
    const throwIfContextCapExceeded = (contextWindow: AgentContextWindowStats | undefined): void => {
      if (!contextWindow?.exceededMaxContextTokens) return;
      throw new WorkflowError(
        contextWindow.warning ?? "Subagent exceeded maxContextTokens",
        WorkflowErrorCode.CONTEXT_WINDOW_EXCEEDED,
        { recoverable: false, agentLabel: options.label, details: contextWindow },
      );
    };
    const emitUsageAndContext = (enforceCap: boolean): void => {
      if (usageEmitted) return;
      usageEmitted = true;
      if (!options.onUsage && !options.onContextWindow && options.maxContextTokens === undefined) return;
      const current = readUsageAndContext();
      if (!current) return;
      try {
        options.onUsage?.(current.usage);
      } catch {
        // Usage hooks are diagnostic only; cap enforcement must still run.
      }
      try {
        options.onContextWindow?.(current.contextWindow);
      } catch {
        // Context hooks are diagnostic only; cap enforcement must still run.
      }
      if (enforceCap) throwIfContextCapExceeded(current.contextWindow);
    };
    const maybeEmitHistory = () => {
      if (!options.onHistory) return;
      const now = Date.now();
      if (now - lastHistoryEmit < 250) return;
      lastHistoryEmit = now;
      emitHistory();
    };
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      removeSessionListener = session.subscribe((event: { type: string; [key: string]: unknown }) => {
        maybeEmitHistory();
        if (event.type === "compaction_start") {
          emitCompactionTelemetry({
            type: "precompact",
            workflowRunId: options.workflowRunId,
            phase: options.phase,
            trigger: event.reason as string | undefined,
            configuredWindow: positiveIntegerField(activeModel?.contextWindow),
            reserve: compactionPolicy.settings?.reserveTokens ?? baseCompactionSettings.reserveTokens,
            compactionKeepRecentTokens:
              compactionPolicy.settings?.keepRecentTokens ?? baseCompactionSettings.keepRecentTokens,
            compactionPolicy: compactionPolicy.policy,
            compactionPolicyReason: compactionPolicy.reason,
            compactionCacheValue: compactionPolicy.cacheValue,
            recommended: compactionPolicy.policy === "aggressive-local",
            suppressedByCacheHot: false,
            compactor: "pi-sdk-auto",
          });
        } else if (event.type === "compaction_end") {
          const result = event.result as { tokensBefore?: number } | undefined;
          emitCompactionTelemetry({
            type: "compaction_result",
            workflowRunId: options.workflowRunId,
            phase: options.phase,
            trigger: event.reason as string | undefined,
            beforeTokens: result?.tokensBefore,
            compactionPolicy: compactionPolicy.policy,
            compactionPolicyReason: compactionPolicy.reason,
            compactionCacheValue: compactionPolicy.cacheValue,
            compactor: "pi-sdk-auto",
            error: typeof event.errorMessage === "string" ? event.errorMessage : undefined,
          });
        }
      });

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // The SDK buries a provider usage/quota limit in the assistant message rather
      // than throwing; detect it here (before the schema/empty-text branches) so it
      // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
      // (schema path) or a silent empty-output null (non-schema path).
      throwIfProviderLimit(session.messages, options.label);

      if (options.schema) {
        const structured = (await resolveStructuredOutput(
          session,
          capture,
          options.schema,
          { ...options, checkContextCap: () => throwIfContextCapExceeded(readUsageAndContext()?.contextWindow) },
          (m) => this.lastAssistantText(m),
        )) as AgentRunResult<TSchemaDef>;
        emitUsageAndContext(true);
        return structured;
      }

      const text = this.lastAssistantText(session.messages);
      if (!text.trim()) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: options.label,
        });
      }
      emitUsageAndContext(true);
      return text as AgentRunResult<TSchemaDef>;
    } catch (error) {
      emitUsageAndContext(true);
      throw error;
    } finally {
      removeAbortListener?.();
      removeSessionListener?.();
      try {
        emitHistory();
      } catch {
        // History is diagnostic only; never let it mask the real result/error.
      }
      session.dispose();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
