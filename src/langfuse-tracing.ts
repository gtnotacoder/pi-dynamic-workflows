import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// NOTE: This tracer targets the pinned legacy Langfuse v3 client — see README for the dependency-pin
// rationale. It will be migrated to the @langfuse/* observation API once the v3 pin is lifted.
import { Langfuse } from "langfuse";
import type { AgentContextWindowStats, AgentUsage } from "./agent.js";
import {
  type CompactionTelemetryEvent,
  createCompactionEventTail,
  onCompactionTelemetry,
} from "./compaction-telemetry.js";
import { DEFAULT_WORKFLOW_TIMEOUT_MS } from "./config.js";
import { summarizeLeanCtxFromAgents } from "./lean-ctx-telemetry.js";
import { loadModelTierConfig } from "./model-tier-config.js";
import { classifyPiTelemetryEnv, type PiTelemetryEnvDecision } from "./telemetry-env.js";
import type { WorkflowAgentTelemetryConfig, WorkflowRunResult } from "./workflow.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";

interface LangfuseLike {
  trace(body?: Record<string, unknown>): TraceLike;
  flushAsync(): Promise<void>;
  shutdownAsync(): Promise<void>;
}

interface TraceLike extends ObservationParentLike {
  update(body: Record<string, unknown>): unknown;
}

interface ObservationParentLike {
  span(body: Record<string, unknown>): SpanLike;
  generation(body: Record<string, unknown>): GenerationLike;
}

interface SpanLike extends ObservationParentLike {
  update(body: Record<string, unknown>): unknown;
  end?(body?: Record<string, unknown>): unknown;
}

interface GenerationLike {
  update(body: Record<string, unknown>): unknown;
  end?(body?: Record<string, unknown>): unknown;
}

interface AgentObservation {
  callId?: string;
  label: string;
  phase?: string;
  generation: GenerationLike;
  startedAt?: string;
  ended: boolean;
  agentConfig?: WorkflowAgentTelemetryConfig;
}

interface RunTraceState {
  runId: string;
  traceId: string;
  parentTraceId?: string;
  sessionId: string;
  trace: TraceLike;
  root: SpanLike;
  agents: AgentObservation[];
}

export interface WorkflowLangfuseConfig {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  flushAt?: number;
  flushIntervalMs?: number;
}

export interface TelemetryConfig {
  serviceName?: string;
  serviceVersion?: string;
  includePayloads?: boolean;
  langfuse?: WorkflowLangfuseConfig;
}

export interface WorkflowLangfuseTracingOptions {
  cwd?: string;
  /** Injectable for tests and callers; environment variables are used by default. */
  config?: TelemetryConfig;
  /** Injectable for tests; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable for tests; defaults to a real Langfuse client when enabled. */
  client?: LangfuseLike;
  /** Best-effort diagnostics hook. Never receives payloads or secrets. */
  onError?: (message: string) => void;
  /** Autocompactor JSONL bridge. false disables file tailing; string overrides path. */
  compactionEventsPath?: string | false;
  /** Poll interval for the autocompactor JSONL bridge. false disables polling and drains only on workflow events/close. */
  compactionPollIntervalMs?: number | false;
  /** Grace period to let active background runs finish before shutdown detaches listeners. Defaults to 10 seconds. */
  shutdownGraceMs?: number;
}

export interface WorkflowLangfuseTracingHandle {
  enabled: boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface ResolvedWorkflowLangfuseConfig {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  flushAt: number;
  flushIntervalMs: number;
  serviceName: string;
  serviceVersion?: string;
  includePayloads: boolean;
  harness: HarnessMetadata;
}

interface HarnessMetadata {
  packageName?: string;
  packageVersion?: string;
  packageGitSha?: string;
}

const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";
const DEFAULT_FLUSH_AT = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const WORKFLOW_TRACING_INTEGRATION = "pi-dynamic-workflows";

export function installWorkflowLangfuseTracing(
  manager: WorkflowManager,
  options: WorkflowLangfuseTracingOptions = {},
): WorkflowLangfuseTracingHandle {
  const tracer = createWorkflowLangfuseTracer(options);
  if (!tracer.enabled) return tracer;

  let compactionTail: { read(): CompactionTelemetryEvent[] } | undefined;
  if (options.compactionEventsPath !== false) {
    compactionTail = createCompactionEventTail({
      filePath: typeof options.compactionEventsPath === "string" ? options.compactionEventsPath : undefined,
      startAtEnd: true,
    });
  }

  const shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? 10_000);

  const resolveCompactionRun = (event: CompactionTelemetryEvent) =>
    event.workflowRunId ? manager.getRun(event.workflowRunId) : undefined;

  const drainCompactionTail = () => {
    for (const event of compactionTail?.read() ?? []) {
      tracer.compactionEvent(resolveCompactionRun(event), event);
    }
  };

  const safe = (op: () => void | Promise<void>, _fallbackRun?: ManagedRun) => {
    try {
      const result = op();
      drainCompactionTail();
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((error) => tracer.report(error));
      }
    } catch (error) {
      tracer.report(error);
    }
  };

  let compactionPollIntervalMs: number | undefined;
  if (compactionTail && options.compactionPollIntervalMs !== false) {
    compactionPollIntervalMs = Math.max(250, options.compactionPollIntervalMs ?? 5_000);
  }
  const compactionPoll = compactionPollIntervalMs
    ? setInterval(() => safe(() => undefined), compactionPollIntervalMs)
    : undefined;
  compactionPoll?.unref?.();

  const unsubscribeCompactionTelemetry = onCompactionTelemetry((event) =>
    safe(() => tracer.compactionEvent(resolveCompactionRun(event), event)),
  );

  const onPhase = (event: { runId: string; title: string }) => {
    const run = manager.getRun(event.runId);
    safe(() => tracer.notePhase(run, event.title), run);
  };
  const onAgentStart = (event: {
    runId: string;
    agentCallId?: string;
    label: string;
    phase?: string;
    prompt: string;
    model?: string;
    startedAt?: string;
    agentConfig?: WorkflowAgentTelemetryConfig;
  }) => {
    const run = manager.getRun(event.runId);
    safe(() => tracer.agentStart(run, event), run);
  };
  const onAgentEnd = (event: {
    runId: string;
    agentCallId?: string;
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    model?: string;
    agentConfig?: WorkflowAgentTelemetryConfig;
    error?: string;
    errorCode?: string;
    recoverable?: boolean;
    startedAt?: string;
    endedAt?: string;
    usage?: AgentUsage;
    contextWindow?: AgentContextWindowStats;
  }) => {
    const run = manager.getRun(event.runId);
    safe(() => tracer.agentEnd(run, event), run);
  };
  const onTokenUsage = (event: { runId: string; usage: WorkflowRunResult["tokenUsage"] }) => {
    const run = manager.getRun(event.runId);
    safe(() => tracer.updateTokenUsage(run, event.usage), run);
  };
  const onComplete = (event: { runId: string; result: WorkflowRunResult }) => {
    const run = manager.getRun(event.runId);
    safe(() => tracer.complete(run, event.result), run);
  };
  const onError = (event: { runId: string; error: unknown }) => {
    const run = manager.getRun(event.runId);
    if (run?.status === "paused") return;
    safe(() => tracer.fail(run, event.error), run);
  };
  const onPaused = (event: { runId: string; reason?: string; error?: unknown; resetHint?: string }) => {
    const run = manager.getRun(event.runId);
    safe(() => tracer.pause(run, event), run);
  };

  manager.on("phase", onPhase);
  manager.on("agentStart", onAgentStart);
  manager.on("agentEnd", onAgentEnd);
  manager.on("tokenUsage", onTokenUsage);
  manager.on("complete", onComplete);
  manager.on("error", onError);
  manager.on("paused", onPaused);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const hasRunningRuns = () => manager.listRuns().some((run) => run.status === "running");
  const waitForRunningRuns = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (hasRunningRuns() && Date.now() < deadline) {
      await sleep(25);
    }
  };

  return {
    enabled: true,
    flush: () => tracer.flush(),
    close: async () => {
      await waitForRunningRuns(shutdownGraceMs);
      if (hasRunningRuns()) {
        for (const run of manager.listRuns()) {
          if (run.status === "running") {
            const activeRun = manager.getRun(run.runId);
            if (activeRun) tracer.fail(activeRun, new Error("workflow stopped during Langfuse tracing shutdown"));
            manager.stop(run.runId);
          }
        }
        await waitForRunningRuns(Math.min(1_000, shutdownGraceMs));
      }

      manager.off("phase", onPhase);
      manager.off("agentStart", onAgentStart);
      manager.off("agentEnd", onAgentEnd);
      manager.off("tokenUsage", onTokenUsage);
      manager.off("complete", onComplete);
      manager.off("error", onError);
      manager.off("paused", onPaused);
      if (compactionPoll) clearInterval(compactionPoll);
      unsubscribeCompactionTelemetry();
      drainCompactionTail();
      await tracer.close();
    },
  };
}

function createWorkflowLangfuseTracer(options: WorkflowLangfuseTracingOptions): WorkflowLangfuseTracer {
  const env = options.env ?? process.env;
  const rawConfig = options.config;
  const config = resolveWorkflowLangfuseConfig(rawConfig, env, options.cwd);
  if (!config.enabled) {
    const reason = workflowLangfuseDisabledReason(rawConfig, env);
    if (reason) options.onError?.(`Langfuse workflow tracing disabled: ${reason}`);
    return WorkflowLangfuseTracer.disabled(options.onError);
  }

  const client =
    options.client ??
    (new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      flushAt: config.flushAt,
      flushInterval: config.flushIntervalMs,
      release: config.serviceVersion,
      sdkIntegration: WORKFLOW_TRACING_INTEGRATION,
      environment: env.LANGFUSE_TRACING_ENVIRONMENT,
      enabled: true,
    }) as unknown as LangfuseLike);

  return new WorkflowLangfuseTracer(client, config, env, options.onError);
}

function resolveWorkflowLangfuseConfig(
  rawConfig: TelemetryConfig | undefined,
  env: Record<string, string | undefined>,
  cwd?: string,
): ResolvedWorkflowLangfuseConfig {
  const config = rawConfig ?? {};
  const langfuse = config.langfuse;
  const publicKey = firstNonEmpty(langfuse?.publicKey, env.LANGFUSE_PUBLIC_KEY) ?? "";
  const secretKey = firstNonEmpty(langfuse?.secretKey, env.LANGFUSE_SECRET_KEY) ?? "";
  const enabledSetting = langfuse?.enabled ?? envBoolean(env.LANGFUSE_ENABLED) ?? Boolean(publicKey && secretKey);
  const enabled = Boolean(enabledSetting && publicKey && secretKey);
  return {
    enabled,
    publicKey,
    secretKey,
    baseUrl:
      firstNonEmpty(langfuse?.baseUrl, env.LANGFUSE_BASE_URL, env.LANGFUSE_BASEURL, env.LANGFUSE_HOST) ??
      DEFAULT_LANGFUSE_BASE_URL,
    flushAt: positiveInteger(langfuse?.flushAt ?? envNumber(env.LANGFUSE_FLUSH_AT), DEFAULT_FLUSH_AT),
    flushIntervalMs: positiveInteger(
      langfuse?.flushIntervalMs ??
        envNumber(env.LANGFUSE_FLUSH_INTERVAL_MS) ??
        envSecondsToMs(env.LANGFUSE_FLUSH_INTERVAL),
      DEFAULT_FLUSH_INTERVAL_MS,
    ),
    serviceName: config.serviceName ?? WORKFLOW_TRACING_INTEGRATION,
    serviceVersion: config.serviceVersion,
    includePayloads: rawConfig?.includePayloads ?? envBoolean(env.LANGFUSE_INCLUDE_PAYLOADS) ?? false,
    harness: resolveHarnessMetadata(cwd),
  };
}

class WorkflowLangfuseTracer {
  readonly enabled: boolean;
  private readonly runs = new Map<string, RunTraceState>();
  private compactionSequence = 0;

  constructor(
    private readonly client: LangfuseLike | undefined,
    private readonly config: ResolvedWorkflowLangfuseConfig | undefined,
    private readonly env: Record<string, string | undefined>,
    private readonly onError: ((message: string) => void) | undefined,
  ) {
    this.enabled = Boolean(client && config?.enabled);
  }

  static disabled(onError: ((message: string) => void) | undefined): WorkflowLangfuseTracer {
    return new WorkflowLangfuseTracer(undefined, undefined, {}, onError);
  }

  notePhase(run: ManagedRun | undefined, title: string): void {
    const state = this.ensureRun(run);
    if (!state) return;
    state.root.update({ metadata: { ...this.runMetadata(run, state), currentPhase: title } });
  }

  agentStart(
    run: ManagedRun | undefined,
    event: {
      agentCallId?: string;
      label: string;
      phase?: string;
      prompt: string;
      model?: string;
      startedAt?: string;
      agentConfig?: WorkflowAgentTelemetryConfig;
    },
  ): void {
    const state = this.ensureRun(run);
    if (!state || !run) return;
    const startedAt = event.startedAt ?? new Date().toISOString();
    const generation = state.root.generation({
      id: observationId(state.traceId, `agent:${run.runId}:${event.agentCallId ?? state.agents.length}:${event.label}`),
      name: `workflow agent: ${event.label}`,
      startTime: startedAt,
      model: event.model,
      input: this.payload({ prompt: event.prompt }),
      metadata: cleanObject({
        ...this.runMetadata(run, state),
        label: event.label,
        phase: event.phase,
        model: event.model,
        agentConfig: event.agentConfig,
      }),
    });
    state.agents.push({
      callId: event.agentCallId,
      label: event.label,
      phase: event.phase,
      generation,
      startedAt,
      ended: false,
      agentConfig: event.agentConfig,
    });
  }

  agentEnd(
    run: ManagedRun | undefined,
    event: {
      agentCallId?: string;
      label: string;
      phase?: string;
      result: unknown;
      tokens?: number;
      model?: string;
      agentConfig?: WorkflowAgentTelemetryConfig;
      error?: string;
      errorCode?: string;
      recoverable?: boolean;
      endedAt?: string;
      usage?: AgentUsage;
      contextWindow?: AgentContextWindowStats;
    },
  ): void {
    const state = this.ensureRun(run);
    if (!state || !run) return;
    const agent = findOpenAgent(state, event.label, event.agentCallId);
    const generation =
      agent?.generation ??
      state.root.generation({
        id: observationId(state.traceId, `agent:${run.runId}:late:${event.label}`),
        name: `workflow agent: ${event.label}`,
        startTime: agent?.startedAt ?? new Date().toISOString(),
      });
    const endedAt = event.endedAt ?? new Date().toISOString();
    const usageSummary = usageSummaryFromAgent(event.usage, event.tokens, event.model);
    generation.end?.({
      endTime: endedAt,
      model: event.model,
      output: this.payload(event.error ? { error: event.error } : { result: event.result }),
      level: event.error ? "ERROR" : "DEFAULT",
      statusMessage: event.error,
      usageDetails: usageSummary.usageDetails,
      costDetails: usageSummary.costDetails,
      metadata: cleanObject({
        ...this.runMetadata(run, state),
        agentCallId: event.agentCallId,
        label: event.label,
        phase: event.phase ?? agent?.phase,
        model: event.model,
        tokens: event.tokens,
        usageSource: usageSummary.source,
        cacheUsageSource: usageSummary.cacheSource,
        cacheReadPct: usageSummary.cacheReadPct,
        promptTokensEstimate: event.agentConfig?.promptTokensEstimate ?? agent?.agentConfig?.promptTokensEstimate,
        agentConfig: cleanObject({ ...(agent?.agentConfig ?? {}), ...(event.agentConfig ?? {}) }),
        errorCode: event.errorCode,
        recoverable: event.recoverable,
        contextWindow: event.contextWindow,
      }),
    });
    if (agent) agent.ended = true;
  }

  updateTokenUsage(run: ManagedRun | undefined, usage: WorkflowRunResult["tokenUsage"]): void {
    const state = this.ensureRun(run);
    if (!state || !run) return;
    if (!usage) return;
    state.root.update({
      metadata: cleanObject({
        ...this.runMetadata(run, state),
        tokenUsage: usage,
      }),
    });
  }

  complete(run: ManagedRun | undefined, result: WorkflowRunResult): void {
    const state = this.ensureRun(run);
    if (!state || !run) return;
    const endedAt = new Date(run.startedAt.getTime() + result.durationMs).toISOString();
    const output = this.payload({ result: result.result });
    state.root.end?.({
      endTime: endedAt,
      output,
      level: "DEFAULT",
      metadata: cleanObject({
        ...this.runMetadata(run, state),
        status: "completed",
        durationMs: result.durationMs,
        agentCount: result.agentCount,
        tokenUsage: result.tokenUsage,
      }),
    });
    state.trace.update({
      output,
      metadata: cleanObject({
        ...this.runMetadata(run, state),
        status: "completed",
        durationMs: result.durationMs,
        agentCount: result.agentCount,
        tokenUsage: result.tokenUsage,
      }),
    });
    void this.flush().catch((error) => this.report(error));
  }

  fail(run: ManagedRun | undefined, error: unknown): void {
    const state = this.ensureRun(run);
    if (!state || !run) return;
    const message = errorMessage(error);
    const output = this.payload({ error: message });
    const endedAt = new Date().toISOString();
    this.endOpenAgents(run, state, endedAt, message, output);
    state.root.end?.({
      endTime: endedAt,
      output,
      level: "ERROR",
      statusMessage: message,
      metadata: cleanObject({ ...this.runMetadata(run, state), status: "failed", error: message }),
    });
    state.trace.update({ output, metadata: cleanObject({ ...this.runMetadata(run, state), status: "failed" }) });
    void this.flush().catch((flushError) => this.report(flushError));
  }

  pause(run: ManagedRun | undefined, event: { reason?: string; error?: unknown; resetHint?: string }): void {
    const state = this.ensureRun(run);
    if (!state || !run) return;
    const message = event.reason ?? "paused";
    const output = this.payload({ paused: true, reason: event.reason });
    const endedAt = new Date().toISOString();
    this.endOpenAgents(run, state, endedAt, message, output, "WARNING", "paused");
    state.root.update({
      level: "WARNING",
      statusMessage: message,
      metadata: cleanObject({
        ...this.runMetadata(run, state),
        status: "paused",
        reason: event.reason,
        error: errorMessage(event.error),
        resetHint: event.resetHint,
      }),
    });
    void this.flush().catch((flushError) => this.report(flushError));
  }

  compactionEvent(run: ManagedRun | undefined, event: CompactionTelemetryEvent): void {
    if (!this.enabled || !this.client || !this.config) return;
    const state = run ? this.ensureRun(run) : undefined;
    const startTime = event.timestamp ?? new Date().toISOString();
    const statusMessage = compactionStatusMessage(event);
    const level = compactionLevel(event);
    const observationKey = this.compactionObservationKey(event, startTime);

    if (state) {
      const metadata = cleanObject({
        ...this.runMetadata(run, state),
        ...compactionMetadata(event, this.config.includePayloads),
      });
      const span = state.root.span({
        id: observationId(state.traceId, `compaction:${observationKey}`),
        name: `pi compaction: ${event.type}`,
        startTime,
        level,
        statusMessage,
        metadata,
      });
      span.end?.({ endTime: startTime, level, statusMessage, metadata });
      return;
    }

    const sessionId = event.sessionId ?? this.env.PI_TELEMETRY_SESSION_ID ?? "compaction";
    const traceId = langfuseTraceId(`compaction:${sessionId}:${event.timestamp ?? startTime}:${observationKey}`);
    const telemetry = summarizeTelemetryParent(this.env);
    const metadata = cleanObject({
      serviceName: this.config.serviceName,
      serviceVersion: this.config.serviceVersion,
      integration: WORKFLOW_TRACING_INTEGRATION,
      packageName: this.config.harness.packageName,
      packageVersion: this.config.harness.packageVersion,
      packageGitSha: this.config.harness.packageGitSha,
      harness: cleanObject({
        ...this.config.harness,
        serviceName: this.config.serviceName,
        serviceVersion: this.config.serviceVersion,
        integration: WORKFLOW_TRACING_INTEGRATION,
      }),
      sessionId,
      parentPiTraceId: this.env.PI_TELEMETRY_TRACE_ID,
      traceParentStatus: telemetry.traceParentStatus,
      traceParentReason: telemetry.reason,
      telemetryProcessRole: telemetry.telemetryProcessRole,
      modelTiers: loadModelTierConfig()?.tiers,
      ...compactionMetadata(event, this.config.includePayloads),
    });
    const trace = this.client.trace({
      id: traceId,
      name: `pi compaction: ${event.type}`,
      timestamp: startTime,
      sessionId,
      tags: cleanArray(["pi", "compaction", event.type]),
      release: this.config.serviceVersion,
      metadata,
    });
    const span = trace.span({
      id: observationId(traceId, `compaction:${observationKey}`),
      name: `pi compaction: ${event.type}`,
      startTime,
      level,
      statusMessage,
      metadata,
    });
    span.end?.({ endTime: startTime, level, statusMessage, metadata });
  }

  async flush(): Promise<void> {
    await this.client?.flushAsync();
  }

  async close(): Promise<void> {
    if (!this.client) return;
    await this.client.flushAsync();
    await this.client.shutdownAsync();
  }

  report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.onError?.(`Langfuse workflow tracing failed: ${message}`);
  }

  private compactionObservationKey(event: CompactionTelemetryEvent, startTime: string): string {
    const stablePart = stableHex(JSON.stringify(event), 16);
    if (event.timestamp) return stablePart;
    this.compactionSequence++;
    return `${stablePart}:${startTime}:${this.compactionSequence}`;
  }

  private endOpenAgents(
    run: ManagedRun,
    state: RunTraceState,
    endedAt: string,
    message: string | undefined,
    output: unknown,
    level: "ERROR" | "WARNING" = "ERROR",
    status = "failed",
  ): void {
    for (const agent of state.agents) {
      if (agent.ended) continue;
      agent.generation.end?.({
        endTime: endedAt,
        output,
        level,
        statusMessage: message,
        metadata: cleanObject({
          ...this.runMetadata(run, state),
          agentCallId: agent.callId,
          label: agent.label,
          phase: agent.phase,
          agentConfig: agent.agentConfig,
          status,
          error: level === "ERROR" ? message : undefined,
        }),
      });
      agent.ended = true;
    }
  }

  private ensureRun(run: ManagedRun | undefined): RunTraceState | undefined {
    if (!this.enabled || !run) return undefined;
    if (!this.client || !this.config) return undefined;
    const existing = this.runs.get(run.runId);
    if (existing) return existing;

    const parentTraceId = this.env.PI_TELEMETRY_TRACE_ID;
    const rawTraceId = `workflow:${run.runId}`;
    const traceId = langfuseTraceId(rawTraceId);
    const sessionId = this.env.PI_TELEMETRY_SESSION_ID ?? `workflow:${run.runId}`;
    const input = this.payload({ args: run.args });
    const metadata = this.runMetadata(run, { runId: run.runId, traceId, parentTraceId, sessionId } as RunTraceState);
    const trace = this.client.trace({
      id: traceId,
      name: `pi workflow: ${run.snapshot.name}`,
      timestamp: run.startedAt.toISOString(),
      sessionId,
      input,
      tags: cleanArray(["pi", "workflow", run.snapshot.name]),
      release: this.config.serviceVersion,
      metadata,
    });
    const root = trace.span({
      id: observationId(traceId, `workflow:${run.runId}`),
      name: `workflow run: ${run.snapshot.name}`,
      startTime: run.startedAt.toISOString(),
      input,
      metadata,
    });
    const state = { runId: run.runId, traceId, parentTraceId, sessionId, trace, root, agents: [] };
    this.runs.set(run.runId, state);
    return state;
  }

  private runMetadata(run: ManagedRun | undefined, state: RunTraceState): Record<string, unknown> {
    const telemetry = summarizeTelemetryParent(this.env);
    const includePayloads = this.config?.includePayloads ?? false;

    return cleanObject({
      serviceName: this.config?.serviceName,
      serviceVersion: this.config?.serviceVersion,
      integration: WORKFLOW_TRACING_INTEGRATION,
      packageName: this.config?.harness.packageName,
      packageVersion: this.config?.harness.packageVersion,
      packageGitSha: this.config?.harness.packageGitSha,
      harness: cleanObject({
        ...this.config?.harness,
        serviceName: this.config?.serviceName,
        serviceVersion: this.config?.serviceVersion,
        integration: WORKFLOW_TRACING_INTEGRATION,
      }),
      modelTiers: loadModelTierConfig()?.tiers,
      workflowRunId: run?.runId ?? state.runId,
      workflowName: run?.snapshot.name,
      workflowDescription: run?.snapshot.description,
      phases: run?.snapshot.phases,
      background: run?.background,
      runPolicy: run
        ? cleanObject({
            agentMaxContextTokens: run.agentMaxContextTokens,
            agentContextReserveTokens: run.agentContextReserveTokens,
            workflowTimeoutMs:
              run.workflowTimeoutMs === undefined ? DEFAULT_WORKFLOW_TIMEOUT_MS : run.workflowTimeoutMs,
            workflowTimeoutMsSource:
              run.workflowTimeoutMs === undefined
                ? "runtime-default"
                : run.workflowTimeoutMs === null
                  ? "disabled"
                  : "captured",
          })
        : undefined,
      sessionId: state.sessionId,
      parentPiTraceId: state.parentTraceId,
      traceParentStatus: telemetry.traceParentStatus,
      traceParentReason: telemetry.reason,
      transcriptDir: includePayloads ? run?.transcriptDir : undefined,
      runStatePath: includePayloads ? run?.runStatePath : undefined,
      telemetryProcessRole: telemetry.telemetryProcessRole,
      ownerPid: telemetry.ownerPid,
      processPid: telemetry.processPid,
      parentPid: telemetry.parentPid,
      leanCtx: run ? summarizeLeanCtxFromAgents(run.snapshot.agents) : undefined,
    });
  }

  private payload(value: unknown): unknown {
    if (this.config?.includePayloads) return value;
    return { redacted: true };
  }
}

function findOpenAgent(state: RunTraceState, label: string, callId: string | undefined): AgentObservation | undefined {
  if (callId !== undefined) {
    const byCallId = state.agents.find((candidate) => candidate.callId === callId && !candidate.ended);
    if (byCallId) return byCallId;
  }
  for (let index = state.agents.length - 1; index >= 0; index--) {
    const candidate = state.agents[index];
    if (candidate.label === label && !candidate.ended) return candidate;
  }
  return undefined;
}

function compactionMetadata(event: CompactionTelemetryEvent, includePayloads = false): Record<string, unknown> {
  return cleanObject({
    telemetryKind: "compaction",
    compactionType: event.type,
    compactionTimestamp: event.timestamp,
    compactionSessionId: event.sessionId,
    compactionWorkflowRunId: event.workflowRunId,
    phase: event.phase,
    trigger: event.trigger,
    contextTokens: event.contextTokens,
    effectiveWindow: event.effectiveWindow,
    configuredWindow: event.configuredWindow,
    runtimeContextWindow: event.runtimeContextWindow,
    reserve: event.reserve,
    windowSource: event.windowSource,
    occupancy: event.occupancy,
    staleFrac: event.staleFrac,
    signals: event.signals,
    estReclaim: event.estReclaim,
    estReclaimFloor: event.estReclaimFloor,
    estReclaimInventory: event.estReclaimInventory,
    estReclaimSource: event.estReclaimSource,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    cacheReadPct: event.cacheReadPct,
    cacheHot: event.cacheHot,
    recommended: event.recommended,
    suppressedByCooldown: event.suppressedByCooldown,
    suppressedByCacheHot: event.suppressedByCacheHot,
    beforeTokens: event.beforeTokens,
    afterTokens: event.afterTokens,
    currentTokens: event.currentTokens,
    digestTokens: event.digestTokens,
    compactor: event.compactor,
    compactionPolicy: event.compactionPolicy,
    compactionPolicyReason: event.compactionPolicyReason,
    compactionCacheValue: event.compactionCacheValue,
    compactionKeepRecentTokens: event.compactionKeepRecentTokens,
    error: event.error,
    source: compactionSource(event.source, includePayloads),
  });
}

function compactionSource(source: string | undefined, includePayloads: boolean): string | undefined {
  if (!source) return undefined;
  if (includePayloads) return source;
  if (isProviderModelSource(source)) return source;
  return source.includes("/") || source.includes("\\") ? "jsonl_bridge" : source;
}

function isProviderModelSource(source: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(source);
}

function compactionLevel(event: CompactionTelemetryEvent): "DEFAULT" | "WARNING" | "ERROR" {
  if (event.error) return "ERROR";
  if ((event.occupancy ?? 0) >= 1 || event.recommended || event.suppressedByCacheHot) return "WARNING";
  return "DEFAULT";
}

function compactionStatusMessage(event: CompactionTelemetryEvent): string | undefined {
  if (event.error) return event.error;
  if ((event.occupancy ?? 0) >= 1) return "context occupancy exceeded effective window";
  if (event.suppressedByCacheHot) return "compaction suppressed by cache-hot policy";
  if (event.recommended) return "compaction recommended";
  return undefined;
}

interface UsageSummary {
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  source:
    | "provider"
    | "workflow_estimate"
    | "workflow_estimate_provider_zero_usage"
    | "provider_zero_usage"
    | "unavailable";
  cacheSource?: string;
  cacheReadPct?: number;
}

function usageSummaryFromAgent(
  usage: AgentUsage | undefined,
  tokens: number | undefined,
  model: string | undefined,
): UsageSummary {
  const providerTotal = usage?.total ?? 0;
  const cacheSource = cacheUsageSource(usage, model);
  const cacheReadPct = usage && usage.input > 0 ? usage.cacheRead / usage.input : undefined;
  if (usage && providerTotal > 0) {
    return {
      source: "provider",
      cacheSource,
      cacheReadPct,
      usageDetails: {
        input: usage.input,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        total: usage.total,
      },
      costDetails: usage.cost > 0 ? { total: usage.cost } : undefined,
    };
  }

  const estimatedTotal = typeof tokens === "number" && tokens > 0 ? tokens : undefined;
  if (estimatedTotal !== undefined) {
    return {
      source: usage ? "workflow_estimate_provider_zero_usage" : "workflow_estimate",
      cacheSource,
      cacheReadPct,
      usageDetails: { total: estimatedTotal },
    };
  }

  return {
    source: usage ? "provider_zero_usage" : "unavailable",
    cacheSource,
    cacheReadPct,
  };
}

function cacheUsageSource(usage: AgentUsage | undefined, model: string | undefined): string | undefined {
  if (!usage) return undefined;
  if (usage.cacheRead > 0 || usage.cacheWrite > 0) return "provider_cache_fields";
  return isGoogleModel(model) ? "google_usage_metadata_no_cache_fields_or_zero" : "provider_no_cache_fields_or_zero";
}

function isGoogleModel(model: string | undefined): boolean {
  return /^(google|google-ai-studio|google-vertex)\//.test(model ?? "") || /\bgemini\b/i.test(model ?? "");
}

type TraceParentStatus = "valid" | "missing" | "stale" | "none";

function summarizeTelemetryParent(env: Record<string, string | undefined>): PiTelemetryEnvDecision & {
  traceParentStatus: TraceParentStatus;
} {
  const decision = classifyPiTelemetryEnv(env);
  const hasSession = Boolean(env.PI_TELEMETRY_SESSION_ID?.trim());
  const hasTrace = Boolean(env.PI_TELEMETRY_TRACE_ID?.trim());
  const traceParentStatus: TraceParentStatus = !decision.hasTelemetryEnv
    ? "none"
    : !hasSession || !hasTrace || decision.reason === "invalid-owner-pid"
      ? "missing"
      : decision.preserve
        ? "valid"
        : "stale";
  return { ...decision, traceParentStatus };
}

function resolveHarnessMetadata(cwd: string | undefined): HarnessMetadata {
  const moduleRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const cwdRoot = cwd ? findPackageRoot(cwd) : undefined;
  const root = moduleRoot ?? cwdRoot;
  const pkg = root ? readPackageMetadata(root) : undefined;
  return cleanObject({
    packageName: pkg?.name,
    packageVersion: pkg?.version,
    packageGitSha: root ? gitSha(root) : undefined,
  }) as HarnessMetadata;
}

function findPackageRoot(start: string): string | undefined {
  let current = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function readPackageMetadata(root: string): { name?: string; version?: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    };
  } catch {
    return undefined;
  }
}

function gitSha(root: string): string | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const value = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function workflowLangfuseDisabledReason(
  rawConfig: TelemetryConfig | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const explicitConfigDisable = rawConfig?.langfuse?.enabled === false;
  const explicitEnvDisable = envBoolean(env.LANGFUSE_ENABLED) === false;
  const shouldDiagnose =
    explicitConfigDisable || explicitEnvDisable || rawConfig?.langfuse?.enabled === true || hasLangfuseEnv(env);
  if (!shouldDiagnose) return undefined;
  if (explicitConfigDisable || explicitEnvDisable) return "disabled explicitly by Langfuse configuration";

  const missing: string[] = [];
  if (!firstNonEmpty(rawConfig?.langfuse?.publicKey, env.LANGFUSE_PUBLIC_KEY)) missing.push("public key");
  if (!firstNonEmpty(rawConfig?.langfuse?.secretKey, env.LANGFUSE_SECRET_KEY)) missing.push("secret key");
  if (missing.length) return `missing ${missing.join(" and ")}`;
  return "resolved disabled after applying config and environment";
}

function hasLangfuseEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(
    firstNonEmpty(
      env.LANGFUSE_PUBLIC_KEY,
      env.LANGFUSE_SECRET_KEY,
      env.LANGFUSE_BASE_URL,
      env.LANGFUSE_BASEURL,
      env.LANGFUSE_HOST,
      env.LANGFUSE_ENABLED,
      env.LANGFUSE_INCLUDE_PAYLOADS,
      env.LANGFUSE_FLUSH_INTERVAL,
    ),
  );
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function envBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function envNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function envSecondsToMs(value: string | undefined): number | undefined {
  const seconds = envNumber(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function workflowLangfuseTraceId(runId: string): string {
  return langfuseTraceId(`workflow:${runId}`);
}

function langfuseTraceId(rawTraceId: string): string {
  return stableHex(`trace:${rawTraceId}`, 32);
}

function observationId(traceId: string, key: string): string {
  return stableHex(`span:${traceId}:${key}`, 16);
}

function stableHex(input: string, length: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

function cleanObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined));
}

function cleanArray(input: Array<string | undefined>): string[] {
  return input.filter((value): value is string => Boolean(value));
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  return error instanceof Error ? error.message : String(error);
}
