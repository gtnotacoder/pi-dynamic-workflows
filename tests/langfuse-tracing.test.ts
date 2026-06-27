import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installWorkflowLangfuseTracing } from "../src/langfuse-tracing.js";
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
      config: {},
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
