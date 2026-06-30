import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { listAvailableModelSpecs } from "./agent.js";
import { listAgentTypes, loadAgentRegistry } from "./agent-registry.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import type { LoopGuardOptions } from "./loop-detector.js";
import { parseWorkflowScript, type WorkflowRunResult } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";
import { loadWorkflowSettings } from "./workflow-settings.js";

/**
 * Model routing guideline for workflow authors.
 * Tells the LLM about opts.tier (small/medium/big) for runtime-enforced
 * model selection, and opts.model for an exact provider/id override.
 *
 * This string is injected into the workflow tool's promptGuidelines and
 * therefore appears in the LLM's system prompt for every workflow execution.
 */
export function modelRoutingGuideline(): string {
  const available = listAvailableModelSpecs();
  const list = available.length
    ? `The user's currently available models (route only to these) are: ${available.join(", ")}.`
    : "Use models the user has configured.";
  return [
    "For workflow, the user configures per-tier models (/workflows-models), so TAG EVERY agent with opts.tier by role so those models are actually used.",
    "opts.tier accepts 'small', 'medium', or 'big' and is enforced at runtime.",
    "Small tier: lightweight exploration/search/inventory agents.",
    "Medium tier: balanced analysis agents.",
    "Big tier: synthesis/judgment/decision agents spanning the full context.",
    "An agent with no opts.tier and no opts.model falls back to the user's medium tier; do not rely on that — tag agents explicitly so small/big are used where they fit.",
    "If the user named a specific model, use opts.model with that exact provider/id; opts.model always takes precedence over opts.tier.",
    list,
  ].join(" ");
}

/**
 * Tells the LLM which named subagent definitions (agentType) are available, so
 * it can route an agent() to a reusable role that binds tools+model+prompt.
 * Returns undefined when no definitions are registered (nothing to advertise).
 */
export function agentTypeGuideline(cwd: string = process.cwd()): string | undefined {
  let types: Array<{ name: string; description?: string }>;
  try {
    types = listAgentTypes(loadAgentRegistry(cwd));
  } catch {
    return undefined;
  }
  if (!types.length) return undefined;
  const list = types.map((t) => (t.description ? `${t.name} (${t.description})` : t.name)).join(", ");
  return `For workflow, opts.agentType routes an agent to a named definition that binds its tools, model, and role prompt. Available agentTypes: ${list}. An explicit opts.model still overrides the definition's model.`;
}

const workflowToolSchema = Type.Object({
  script: Type.String({
    description: [
      "Required raw JavaScript workflow script, with no Markdown fences.",
      "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }",
      "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
      "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
    ].join(" "),
  }),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run the workflow in the background. Default: true — the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when it finishes. Set to false only when you need the result inline in this same turn (the call will block until the workflow completes).",
    }),
  ),
  maxAgents: Type.Optional(
    Type.Number({
      description: "Maximum number of agents allowed in this run. Default: 1000.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({
      description:
        "Maximum concurrent agents for this run. Clamped to the runtime maximum. Use when provider/transport stability matters.",
    }),
  ),
  agentRetries: Type.Optional(
    Type.Number({
      description:
        "Retry attempts for recoverable agent failures such as timeout, connection failure, or empty assistant output. Default 0 unless configured.",
    }),
  ),
  agentTimeoutMs: Type.Optional(
    Type.Number({
      description:
        "Timeout per agent in milliseconds. Omit for no hard timeout by default. Set only when the user asks to bound time.",
    }),
  ),
  workflowTimeoutMs: Type.Optional(
    Type.Number({
      description:
        "Total wall-clock timeout for the entire workflow run in milliseconds. Default: 120 minutes (7,200,000 ms).",
    }),
  ),
  loopGuard: Type.Optional(
    Type.Object(
      {
        window: Type.Optional(Type.Number({ description: "Sliding window of recent agent() call identities." })),
        maxRepeats: Type.Optional(
          Type.Number({ description: "Occurrences of one call identity within the window before detection." }),
        ),
        maxConsecutive: Type.Optional(
          Type.Number({ description: "Consecutive identical agent() calls before detection." }),
        ),
        action: Type.Optional(
          Type.Union([Type.Literal("warn"), Type.Literal("abort")], {
            description: "warn logs only; abort stops the workflow.",
          }),
        ),
      },
      {
        description:
          "Detect repeated identical agent() calls from runaway workflow loops. Defaults to warn-only; set action:'abort' to hard-stop.",
      },
    ),
  ),
  tokenBudget: Type.Optional(
    Type.Number({
      description:
        "Hard total-token budget for the whole run. Once spent reaches it, further agent() calls fail and the run stops. Omit for no limit. Set it when the user asks to cap spend.",
    }),
  ),
  agentMaxContextTokens: Type.Optional(
    Type.Union([Type.Number(), Type.Null()], {
      description:
        "Hard per-agent provider input/context token cap. When set, agent() rejects prompts/runs that exceed it to prevent repeated huge prompts on smaller-window models. Pass null to disable a configured default cap for this run.",
    }),
  ),
  agentContextReserveTokens: Type.Optional(
    Type.Union([Type.Number(), Type.Null()], {
      description:
        "Reserve tokens subtracted from each model context window when calculating occupancy warnings. Omit to use the model maxTokens when known. Pass null to disable a configured default reserve for this run.",
    }),
  ),
  compactionPolicy: Type.Optional(
    Type.Union(
      [
        Type.Literal("auto"),
        Type.Literal("default"),
        Type.Literal("aggressive-local"),
        Type.Literal("cache-preserving"),
        Type.Literal("off"),
        Type.Null(),
      ],
      {
        description:
          "Default per-agent compaction policy. Omit or use auto unless explicitly requested; auto makes local/no-cache models compact earlier.",
      },
    ),
  ),
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
  background?: boolean;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  workflowTimeoutMs?: number;
  loopGuard?: LoopGuardOptions;
  tokenBudget?: number;
  agentMaxContextTokens?: number | null;
  agentContextReserveTokens?: number | null;
  compactionPolicy?: "auto" | "default" | "aggressive-local" | "cache-preserving" | "off" | null;
};

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /** Shared manager so background runs are reachable from the `/workflows` command. */
  manager?: WorkflowManager;
  /** Shared saved-workflow storage. */
  storage?: WorkflowStorage;
  /** Default per-agent timeout for runs created by this tool. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /**
   * Default hard wall-clock timeout for runs created by this tool, in ms. null
   * disables the run-wide timeout explicitly; undefined lets the runtime
   * constant apply. Overrides the settings-derived default when provided.
   */
  defaultWorkflowTimeoutMs?: number | null;
  /** Default max concurrent agents when no tool-level concurrency is passed. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /** Default hard per-agent provider input/context token cap. */
  defaultAgentMaxContextTokens?: number | null;
  /** Default reserve subtracted from model context windows for occupancy. */
  defaultAgentContextReserveTokens?: number | null;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  const storage = options.storage ?? createWorkflowStorage(options.cwd ?? process.cwd());
  const cwd = options.cwd ?? process.cwd();
  const defaults = resolveWorkflowToolDefaults(options, cwd);
  const manager =
    options.manager ??
    new WorkflowManager({
      cwd: options.cwd,
      concurrency: defaults.concurrency,
      loadSavedWorkflow: (name: string) => storage.load(name)?.script,
      defaultAgentTimeoutMs: defaults.agentTimeoutMs,
      defaultWorkflowTimeoutMs: defaults.workflowTimeoutMs,
      defaultAgentRetries: defaults.agentRetries,
      defaultAgentMaxContextTokens: defaults.agentMaxContextTokens,
      defaultAgentContextReserveTokens: defaults.agentContextReserveTokens,
    });

  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), pipeline(), and dag().",
      "script is required raw JavaScript. It must start with export const meta = { name, description, phases? } and must call agent() at least once.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description', phases: [{ title: 'Phase name' }] }`; meta.name and meta.description are required non-empty strings.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), dag(nodes), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, prefer the built-in quality helpers when they fit (each is built on agent()/parallel() and returns plain data): verify(item, {reviewers, threshold, lens}) for adversarial fact-checking; judgePanel(attempts, {judges, rubric}) to score N candidates and return the best; loopUntilDry({round, key, consecutiveEmpty}) to keep finding until rounds stop yielding new items; completenessCheck(args, results) as a final 'what's missing' critic.",
      "For workflow, when meta.phases declares more than one phase, call phase('Exact Title') at the start of each phase's work (or set opts.phase on each agent) so every agent groups under the correct phase; never declare a phase you don't switch into — a declared phase with no agents shows as 0/0 and any agent you forgot to move stays in the previous phase.",
      "For workflow, do not set tokenBudget or agentTimeoutMs unless the user explicitly asks to cap spend or time; likewise do not set agentMaxContextTokens unless asked to cap context size; the defaults are unbounded.",
      "For workflow, to bound spend: pass tokenBudget for a hard run-wide cap; carve a per-phase ceiling with phase('Name', {budget: N}) (that phase throws at its sub-budget without touching the run total — wrap its work in try/catch so later phases proceed); use retry(thunk, {attempts, until}) for bounded retry, and gate(thunk, validator, {attempts}) when a validator's feedback should steer the next attempt. To degrade gracefully, branch on budget.remaining() to skip optional rounds or choose a lighter tier.",
      "For workflow context-window guardrails: pass agentMaxContextTokens for a run-wide hard cap, or per-call agent(..., { maxContextTokens }) for one noisy agent; occupancy warnings are logged/persisted automatically at 70/85/95% of the effective model window.",
      "For workflow compaction: opts.compactionPolicy accepts 'auto', 'default', 'aggressive-local', 'cache-preserving', or 'off'. Leave it as auto unless the user explicitly asks; auto makes local/no-cache models compact earlier while cacheable remote models keep the default policy.",
      "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, dag([{ id, dependsOn, run }]) runs dependency-ready nodes in deterministic waves; failed nodes cascade-skip their dependents while independent branches continue.",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
      "For workflow, use low concurrency and agentRetries for unstable provider/transport fan-out runs; retries apply only to recoverable agent failures and still require explicit null handling after exhaustion.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      modelRoutingGuideline(),
      agentTypeGuideline(),
      "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
      "For workflow, runs are background by default: the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when the run finishes. Pass background: false only when you must use the result inline in this same turn (it will block).",
      "For workflow, you may call `await workflow('saved-name', argsObject)` to run a saved workflow inline and use its result; nesting is one level deep only, and the global 16-concurrent / 1000-total caps hold across the nesting.",
    ].filter((g): g is string => typeof g === "string" && g.length > 0),
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);

      // checkpoint() reaches the human only on a UI-bearing foreground run; a
      // background run is detached, so checkpoint() falls back to its headless
      // default. Map a checkpoint to ctx.ui.confirm (a yes/no gate) when available.
      const uiCtx = ctx as
        | { hasUI?: boolean; ui?: { confirm?(title: string, message: string): Promise<boolean> } }
        | undefined;
      const uiConfirm = uiCtx?.hasUI ? uiCtx.ui?.confirm : undefined;
      const confirm = uiConfirm
        ? (promptText: string) => uiConfirm.call(uiCtx?.ui, "Workflow checkpoint", promptText)
        : undefined;

      // Background execution is the default: return immediately so the turn ends
      // and the user isn't blocked. The result is delivered back into the
      // conversation when the run finishes (see installResultDelivery). Only an
      // explicit `background: false` blocks for the result inline.
      if (params.background ?? true) {
        const { runId } = manager.startInBackground(script, params.args, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          workflowTimeoutMs: params.workflowTimeoutMs,
          loopGuard: params.loopGuard,
          tokenBudget: params.tokenBudget,
          agentMaxContextTokens: params.agentMaxContextTokens,
          agentContextReserveTokens: params.agentContextReserveTokens,
          compactionPolicy: params.compactionPolicy,
        });
        const transcriptDir = manager.getRun(runId)?.transcriptDir;
        return {
          content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId, transcriptDir) }],
          details: { runId, background: true },
        };
      }

      // Synchronous execution (blocking) — but routed through the manager so the
      // run shows up live in the /workflows navigator and the task panel while it
      // runs, then stays in history afterwards. We still block on the result and
      // return it inline, so the model gets the full output in the same turn.
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      let latestLive: WorkflowSnapshot | undefined;
      // Live progress for a foreground run is shown by the below-editor task
      // panel (installTaskPanel), which subscribes to the manager directly.
      // Streaming the same progress into chat too duplicated it (chat + "pi
      // status"). Stream to chat only when no panel will show it: a headless/RPC
      // run (no UI), or a UI host that did NOT install the task panel. The latter
      // guard (manager.hasTaskPanel, set by installTaskPanel) keeps live progress
      // visible even if an embedder skips the panel (Codex review: robustness).
      const streamLive = !(uiCtx?.hasUI && manager.hasTaskPanel);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, {
        key: "workflow",
        streamToolUpdates: streamLive,
        maxAgents: 4,
        showResultPreviews: false,
      });

      let result: WorkflowRunResult;
      try {
        result = await manager.runSync(script, params.args, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          workflowTimeoutMs: params.workflowTimeoutMs,
          loopGuard: params.loopGuard,
          tokenBudget: params.tokenBudget,
          agentMaxContextTokens: params.agentMaxContextTokens,
          agentContextReserveTokens: params.agentContextReserveTokens,
          compactionPolicy: params.compactionPolicy,
          confirm,
          externalSignal: signal,
          onProgress(live) {
            // Always capture the latest live snapshot (a cheap reference) so the
            // final tool details render the real agent tree even when we skip the
            // per-event recompute below. The expensive recompute + display.update
            // run only when we stream to chat; when the task panel shows live
            // progress it reads the manager directly and this path is a no-op
            // (Codex review: avoid wasted work on an inert display).
            latestLive = live;
            if (!streamLive) return;
            snapshot = recomputeWorkflowSnapshot(live);
            display.update(snapshot);
          },
        });
      } catch (error) {
        if (signal?.aborted || (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED)) {
          if (latestLive) snapshot = recomputeWorkflowSnapshot(latestLive);
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      // Build the final snapshot from the last live state the manager reported
      // (works whether or not we streamed), so the returned details render the
      // real agent tree instead of the empty initial snapshot.
      if (latestLive) snapshot = recomputeWorkflowSnapshot(latestLive);
      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      // Format token usage (include cost when the provider reports it)
      const tokenInfo = result.tokenUsage
        ? `\n\nToken usage: ${result.tokenUsage.total.toLocaleString()} tokens${
            result.tokenUsage.cost ? ` ($${result.tokenUsage.cost.toFixed(4)})` : ""
          }`
        : "";

      const formattedResult =
        result.result !== undefined ? `\n\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\`` : "";

      return {
        content: [
          {
            type: "text",
            text: `Workflow **${result.meta.name}** completed with **${result.agentCount}** agent(s).${tokenInfo}\n\n## Result${formattedResult}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          tokenUsage: result.tokenUsage,
          runId: result.runId,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial), 0, 0);
      }
      // Fallback: strip markdown syntax so the TUI doesn't display raw asterisks/hashes.
      // The `content` field is for the LLM (where markdown is preserved), but the TUI
      // renderer (Text component) shows text literally — so we strip markdown here.
      const text = result.content?.[0];
      const raw = text?.type === "text" ? text.text : theme.fg("muted", "workflow");
      const clean = raw
        .replace(/\*\*/g, "")
        .replace(/```[a-z]*\n/g, "")
        .replace(/```/g, "")
        .replace(/^##+\s*/gm, "")
        .trim();
      return new Text(clean || theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

export function resolveWorkflowToolDefaults(
  options: WorkflowToolOptions,
  cwd: string,
): {
  agentTimeoutMs: number | null;
  workflowTimeoutMs: number | null | undefined;
  concurrency?: number;
  agentRetries: number;
  agentMaxContextTokens: number | null;
  agentContextReserveTokens: number | null;
} {
  const settings = loadWorkflowSettings({ cwd });
  return {
    agentTimeoutMs:
      options.defaultAgentTimeoutMs !== undefined
        ? options.defaultAgentTimeoutMs
        : (settings.defaultAgentTimeoutMs ?? null),
    workflowTimeoutMs:
      options.defaultWorkflowTimeoutMs !== undefined
        ? options.defaultWorkflowTimeoutMs
        : settings.defaultWorkflowTimeoutMs,
    concurrency: options.defaultConcurrency ?? options.concurrency ?? settings.defaultConcurrency,
    agentRetries: options.defaultAgentRetries ?? settings.defaultAgentRetries ?? 0,
    agentMaxContextTokens:
      options.defaultAgentMaxContextTokens !== undefined
        ? options.defaultAgentMaxContextTokens
        : (settings.defaultAgentMaxContextTokens ?? null),
    agentContextReserveTokens:
      options.defaultAgentContextReserveTokens !== undefined
        ? options.defaultAgentContextReserveTokens
        : (settings.defaultAgentContextReserveTokens ?? null),
  };
}

/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export function backgroundStartedText(name: string, runId: string, transcriptDir?: string): string {
  const lines = [`Workflow "${name}" started in the background.`, `Run ID: ${runId}`];
  if (transcriptDir) {
    // Parity with Claude Code, which surfaces `Transcript dir: <dir>` on async
    // launch so a failed subagent is debuggable from the start.
    lines.push(`Transcript dir: ${transcriptDir}`);
  }
  lines.push(
    "It keeps running on its own. When it finishes, the result is delivered back",
    "here and the conversation continues automatically — the user does not need to",
    "do anything. Tell the user they can simply wait here for it to finish (it will",
    "resume the conversation by itself), or keep chatting / working on other things",
    "in the meantime; either way the result will come back to this conversation.",
    `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
  );
  return lines.join("\n");
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
  const value = args as Record<string, unknown>;
  if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function _isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
