import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { emitCompactionTelemetry } from "../src/compaction-telemetry.js";
import { installWorkflowLangfuseTracing, workflowLangfuseTraceId } from "../src/langfuse-tracing.js";
import { WorkflowManager } from "../src/workflow-manager.js";

class FakeGeneration {
  updates: Record<string, unknown>[] = [];
  ends: Record<string, unknown>[] = [];

  constructor(readonly body: Record<string, unknown>) {}

  update(body: Record<string, unknown>): void {
    this.updates.push(body);
  }

  end(body: Record<string, unknown> = {}): void {
    this.ends.push(body);
  }
}

class FakeSpan {
  spans: FakeSpan[] = [];
  generations: FakeGeneration[] = [];
  updates: Record<string, unknown>[] = [];
  ends: Record<string, unknown>[] = [];

  constructor(readonly body: Record<string, unknown>) {}

  span(body: Record<string, unknown>): FakeSpan {
    const span = new FakeSpan(body);
    this.spans.push(span);
    return span;
  }

  generation(body: Record<string, unknown>): FakeGeneration {
    const generation = new FakeGeneration(body);
    this.generations.push(generation);
    return generation;
  }

  update(body: Record<string, unknown>): void {
    this.updates.push(body);
  }

  end(body: Record<string, unknown> = {}): void {
    this.ends.push(body);
  }
}

class FakeTrace extends FakeSpan {}

class FakeLangfuseClient {
  traces: FakeTrace[] = [];
  flushes = 0;
  shutdowns = 0;

  trace(body: Record<string, unknown> = {}): FakeTrace {
    const trace = new FakeTrace(body);
    this.traces.push(trace);
    return trace;
  }

  async flushAsync(): Promise<void> {
    this.flushes++;
  }

  async shutdownAsync(): Promise<void> {
    this.shutdowns++;
  }
}

function metadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = body.metadata;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

test("installWorkflowLangfuseTracing enables workflow traces from LANGFUSE env credentials", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          return "agent-output";
        },
      } as never,
    });
    const errors: string[] = [];
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {
        includePayloads: false,
      },
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
        PI_TELEMETRY_SESSION_ID: "session-env",
      },
      client: client as never,
      onError: (message) => errors.push(message),
      compactionEventsPath: false,
    });

    assert.equal(handle.enabled, true);
    await manager.runSync(
      `export const meta = { name: 'lf_env', description: 'Langfuse env test' }
       await agent('hello', { label: 'reviewer' })
       return 'done'`,
      { pr: 28 },
      { workflowTimeoutMs: null },
    );
    await handle.close();

    assert.deepEqual(errors, []);
    assert.equal(client.traces.length, 1);
    assert.equal(client.traces[0].body.name, "pi workflow: lf_env");
    assert.equal(client.traces[0].body.sessionId, "session-env");
    assert.equal(client.traces[0].spans[0].body.name, "workflow run: lf_env");
    assert.equal(client.traces[0].spans[0].generations[0].body.name, "workflow agent: reviewer");
    assert.equal(client.shutdowns, 1);

    // Assert that the trace link ID is exactly the one derived by workflowLangfuseTraceId
    const runs = manager.listRuns();
    assert.equal(runs.length, 1);
    const runId = runs[0].runId;
    const expectedTraceId = workflowLangfuseTraceId(runId);
    assert.equal(client.traces[0].body.id, expectedTraceId);

    const traceMetadata = metadata(client.traces[0].body);
    // Assert that by default includePayloads=false, and absolute paths are redacted (omitted)
    assert.equal(traceMetadata?.transcriptDir, undefined);
    assert.equal(traceMetadata?.runStatePath, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing sends Gemini provider usage details to Langfuse", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-gemini-usage-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(
          _prompt: string,
          options: { onModelResolved?: (model: string) => void; onUsage?: (usage: AgentUsage) => void },
        ) {
          options.onModelResolved?.("google-ai-studio/gemini-3.5-flash");
          options.onUsage?.({ input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, total: 1500, cost: 0 });
          return "gemini-output";
        },
      } as never,
    });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" },
      client: client as never,
      compactionEventsPath: false,
    });

    await manager.runSync(
      `export const meta = { name: 'lf_gemini_usage', description: 'Gemini usage details test' }
       await agent('hello', { label: 'gemini-worker' })
       return 'done'`,
      undefined,
      { workflowTimeoutMs: null },
    );
    await handle.close();

    const end = client.traces[0].spans[0].generations[0].ends[0];
    assert.deepEqual(end.usageDetails, {
      input: 1200,
      output: 300,
      cache_read: 0,
      cache_write: 0,
      total: 1500,
    });
    const generationMetadata = metadata(end);
    assert.equal(generationMetadata?.usageSource, "provider");
    assert.equal(generationMetadata?.cacheUsageSource, "google_usage_metadata_no_cache_fields_or_zero");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing includes transcriptDir and runStatePath when includePayloads is true", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-payloads-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          return "agent-output";
        },
      } as never,
    });
    const errors: string[] = [];
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {
        includePayloads: true,
      },
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
      },
      client: client as never,
      onError: (message) => errors.push(message),
      compactionEventsPath: false,
    });

    assert.equal(handle.enabled, true);
    await manager.runSync(
      `export const meta = { name: 'lf_payloads', description: 'Langfuse payloads test' }
       return 'done'`,
      { pr: 28 },
      { workflowTimeoutMs: null },
    );
    await handle.close();

    assert.equal(client.traces.length, 1);
    const traceMetadata = metadata(client.traces[0].body);
    assert.ok(traceMetadata?.transcriptDir, "transcriptDir should be defined when includePayloads is true");
    assert.ok(traceMetadata?.runStatePath, "runStatePath should be defined when includePayloads is true");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing redacts transcriptDir and runStatePath by default when includePayloads is unset", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-default-redact-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          return "agent-output";
        },
      } as never,
    });
    const errors: string[] = [];
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
      },
      client: client as never,
      onError: (message) => errors.push(message),
      compactionEventsPath: false,
    });

    assert.equal(handle.enabled, true);
    await manager.runSync(
      `export const meta = { name: 'lf_default_redact', description: 'Langfuse redact test' }
       return 'done'`,
      { pr: 28 },
      { workflowTimeoutMs: null },
    );
    await handle.close();

    assert.equal(client.traces.length, 1);
    const traceMetadata = metadata(client.traces[0].body);
    assert.equal(traceMetadata?.transcriptDir, undefined, "transcriptDir should be redacted/undefined by default");
    assert.equal(traceMetadata?.runStatePath, undefined, "runStatePath should be redacted/undefined by default");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing includes transcriptDir and runStatePath when LANGFUSE_INCLUDE_PAYLOADS env is true", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-env-payloads-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          return "agent-output";
        },
      } as never,
    });
    const errors: string[] = [];
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
        LANGFUSE_INCLUDE_PAYLOADS: "true",
      },
      client: client as never,
      onError: (message) => errors.push(message),
      compactionEventsPath: false,
    });

    assert.equal(handle.enabled, true);
    await manager.runSync(
      `export const meta = { name: 'lf_env_payloads', description: 'Langfuse env payloads test' }
       return 'done'`,
      { pr: 28 },
      { workflowTimeoutMs: null },
    );
    await handle.close();

    assert.equal(client.traces.length, 1);
    const traceMetadata = metadata(client.traces[0].body);
    assert.ok(
      traceMetadata?.transcriptDir,
      "transcriptDir should be defined when LANGFUSE_INCLUDE_PAYLOADS env is true",
    );
    assert.ok(traceMetadata?.runStatePath, "runStatePath should be defined when LANGFUSE_INCLUDE_PAYLOADS env is true");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("close waits for an active background workflow before detaching tracing listeners", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-close-"));
  try {
    const client = new FakeLangfuseClient();
    let finishAgent!: () => void;
    const agentFinished = new Promise<void>((resolve) => {
      finishAgent = resolve;
    });
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          await agentFinished;
          return "agent-output";
        },
      } as never,
    });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" },
      client: client as never,
      compactionEventsPath: false,
      shutdownGraceMs: 1_000,
    });

    const { promise } = manager.startInBackground(`export const meta = { name: 'lf_close', description: 'close wait' }
await agent('hello', { label: 'slow-agent' })
return 'done'`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const closePromise = handle.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(client.shutdowns, 0, "close should not detach/shutdown while the run is still active");

    finishAgent();
    await promise;
    await closePromise;

    assert.equal(client.shutdowns, 1);
    assert.equal(client.traces[0].spans[0].generations[0].ends.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("close force-stops active runs if they do not complete within the grace period", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-force-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          await new Promise(() => {}); // never finishes
          return "agent-output";
        },
      } as never,
    });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" },
      client: client as never,
      compactionEventsPath: false,
      shutdownGraceMs: 50,
    });

    manager.startInBackground(`export const meta = { name: 'lf_force', description: 'force stop' }
await agent('hello', { label: 'infinite-agent' })
return 'done'`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await handle.close();

    assert.equal(client.shutdowns, 1, "should shutdown");
    const run = manager.listRuns()[0];
    assert.equal(run.status, "aborted", "the run should have been force-stopped (aborted)");
    const generation = client.traces[0].spans[0].generations[0];
    assert.equal(generation.ends.length, 1, "the in-flight generation should be ended on abort");
    assert.equal(generation.ends[0].level, "ERROR");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("close does not abort paused runs during tracing shutdown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-paused-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          await new Promise(() => {}); // never finishes until paused/stopped
          return "agent-output";
        },
      } as never,
    });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" },
      client: client as never,
      compactionEventsPath: false,
      shutdownGraceMs: 20,
    });

    const { runId } = manager.startInBackground(`export const meta = { name: 'lf_paused', description: 'paused' }
await agent('hello', { label: 'paused-agent' })
return 'done'`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.pause(runId), true);
    await handle.close();

    const run = manager.listRuns().find((candidate) => candidate.runId === runId);
    assert.equal(run?.status, "paused", "paused runs should remain resumable after tracing shutdown");
    const generation = client.traces[0].spans[0].generations[0];
    assert.equal(generation.ends.length, 1, "pausing should close the in-flight generation");
    assert.equal(generation.ends[0].level, "WARNING");
    assert.equal(metadata(generation.ends[0])?.status, "paused");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing keeps duplicate-label generations matched by call id", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-duplicate-labels-"));
  try {
    const client = new FakeLangfuseClient();
    let releaseSecond!: () => void;
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          if (prompt === "second") await secondCanFinish;
          return prompt;
        },
      } as never,
    });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: { includePayloads: true },
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" },
      client: client as never,
      compactionEventsPath: false,
    });

    const run = manager.runSync(
      `export const meta = { name: 'lf_duplicate_labels', description: 'duplicate labels' }
const xs = await parallel([
  () => agent('first', { label: 'worker' }),
  () => agent('second', { label: 'worker' }),
])
return xs`,
      undefined,
      { workflowTimeoutMs: null, concurrency: 2 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseSecond();
    await run;
    await handle.close();

    const generations = client.traces[0].spans[0].generations;
    assert.equal(generations.length, 2);
    assert.deepEqual(generations[0].ends[0].output, { result: "first" });
    assert.deepEqual(generations[1].ends[0].output, { result: "second" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing exports standalone compaction telemetry events", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-compaction-standalone-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({ cwd, defaultWorkflowTimeoutMs: null });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test", PI_TELEMETRY_SESSION_ID: "session-1" },
      client: client as never,
      compactionEventsPath: false,
    });

    emitCompactionTelemetry({
      type: "monitor_eval",
      session_id: "session-1",
      ts: "2026-06-27T07:00:00Z",
      context_tokens: 230_017,
      effective_window: 232_000,
      occupancy: 0.9915,
      stale_frac: 0.9,
      cache_hot: true,
      suppressed_by_cache_hot: true,
    });
    await handle.close();

    assert.equal(client.traces.length, 1);
    assert.equal(client.traces[0].body.name, "pi compaction: monitor_eval");
    assert.equal(client.traces[0].body.sessionId, "session-1");
    assert.equal(client.traces[0].spans[0].body.name, "pi compaction: monitor_eval");
    assert.equal(client.traces[0].spans[0].body.level, "WARNING");
    const spanMetadata = metadata(client.traces[0].spans[0].body);
    assert.equal(spanMetadata?.contextTokens, 230_017);
    assert.equal(spanMetadata?.suppressedByCacheHot, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing gives repeated timestamp-less compaction events unique traces", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-compaction-unique-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({ cwd, defaultWorkflowTimeoutMs: null });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test", PI_TELEMETRY_SESSION_ID: "session-1" },
      client: client as never,
      compactionEventsPath: false,
    });

    emitCompactionTelemetry({ type: "monitor_eval", session_id: "session-1", recommended: true });
    emitCompactionTelemetry({ type: "monitor_eval", session_id: "session-1", recommended: true });
    await handle.close();

    assert.equal(client.traces.length, 2);
    assert.notEqual(client.traces[0].body.id, client.traces[1].body.id);
    assert.notEqual(client.traces[0].spans[0].body.id, client.traces[1].spans[0].body.id);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing redacts JSONL bridge source paths by default", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-compaction-redact-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({ cwd, defaultWorkflowTimeoutMs: null });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" },
      client: client as never,
      compactionEventsPath: false,
    });

    emitCompactionTelemetry({ type: "monitor_eval", session_id: "session-redacted" }, join(cwd, "events.jsonl"));
    await handle.close();

    const spanMetadata = metadata(client.traces[0].spans[0].body);
    assert.equal(spanMetadata?.source, "jsonl_bridge");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing keeps unscoped JSONL events standalone", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-compaction-unscoped-"));
  try {
    const eventsPath = join(cwd, "events.jsonl");
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          return "agent-output";
        },
      } as never,
    });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" },
      client: client as never,
      compactionEventsPath: eventsPath,
      compactionPollIntervalMs: false,
    });

    appendFileSync(eventsPath, `${JSON.stringify({ type: "monitor_eval", session_id: "session-file" })}\n`);
    await manager.runSync(
      `export const meta = { name: 'lf_unscoped_jsonl', description: 'unscoped jsonl' }
       await agent('hello', { label: 'worker' })
       return 'done'`,
      undefined,
      { workflowTimeoutMs: null },
    );
    await handle.close();

    const workflowTrace = client.traces.find((trace) => trace.body.name === "pi workflow: lf_unscoped_jsonl");
    const compactionTrace = client.traces.find((trace) => trace.body.name === "pi compaction: monitor_eval");
    assert.ok(workflowTrace, "workflow trace should exist");
    assert.ok(compactionTrace, "unscoped JSONL event should be a standalone compaction trace");
    assert.equal(
      workflowTrace.spans[0].spans.some((span) => span.body.name === "pi compaction: monitor_eval"),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing polls the autocompactor JSONL bridge", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-compaction-poll-"));
  try {
    const eventsPath = join(cwd, "events.jsonl");
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({ cwd, defaultWorkflowTimeoutMs: null });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" },
      client: client as never,
      compactionEventsPath: eventsPath,
      compactionPollIntervalMs: 10,
    });

    appendFileSync(
      eventsPath,
      `${JSON.stringify({
        type: "monitor_eval",
        session_id: "session-file",
        ts: "2026-06-27T08:00:00Z",
        recommended: true,
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    await handle.close();

    assert.equal(client.traces.length, 1);
    assert.equal(client.traces[0].body.name, "pi compaction: monitor_eval");
    assert.equal(client.traces[0].body.sessionId, "session-file");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing attaches compaction events to matching workflow runs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-compaction-run-"));
  try {
    const client = new FakeLangfuseClient();
    const manager = new WorkflowManager({
      cwd,
      defaultAgentTimeoutMs: null,
      defaultWorkflowTimeoutMs: null,
      agent: {
        async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
          options.onModelResolved?.("test/model");
          return "agent-output";
        },
      } as never,
    });
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" },
      client: client as never,
      compactionEventsPath: false,
    });

    await manager.runSync(
      `export const meta = { name: 'lf_compaction_run', description: 'compaction run test' }
       await agent('hello', { label: 'worker' })
       return 'done'`,
      undefined,
      { workflowTimeoutMs: null },
    );
    const runId = manager.listRuns()[0].runId;
    emitCompactionTelemetry({ type: "precompact", workflowRunId: runId, recommended: true, occupancy: 1.1 });
    await handle.close();

    assert.equal(client.traces.length, 1);
    const root = client.traces[0].spans[0];
    const compactionSpan = root.spans.find((span) => span.body.name === "pi compaction: precompact");
    assert.ok(compactionSpan, "compaction span should be nested under the workflow root span");
    assert.equal(compactionSpan.body.level, "WARNING");
    const spanMetadata = metadata(compactionSpan.body);
    assert.equal(spanMetadata?.workflowRunId, runId);
    assert.equal(spanMetadata?.recommended, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("installWorkflowLangfuseTracing reports incomplete LANGFUSE env instead of silently disabling", () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-langfuse-missing-"));
  try {
    const manager = new WorkflowManager({ cwd, defaultWorkflowTimeoutMs: null });
    const errors: string[] = [];
    const handle = installWorkflowLangfuseTracing(manager, {
      config: {},
      env: { LANGFUSE_PUBLIC_KEY: "pk-test" },
      onError: (message) => errors.push(message),
      compactionEventsPath: false,
    });

    assert.equal(handle.enabled, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /missing secret key/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
