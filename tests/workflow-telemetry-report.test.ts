import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import {
  buildWorkflowTelemetryReport,
  parseTelemetryWindow,
  renderWorkflowTelemetryReport,
  workflowLangfuseTraceId,
} from "../src/workflow-telemetry-report.js";

function sampleRun(): PersistedRunState {
  return {
    runId: "run-abc",
    workflowName: "sample_workflow",
    script: "export const meta = { name: 'sample', description: 'sample' }",
    runStatePath: "/tmp/pi-runs/run-abc.json",
    status: "completed",
    phases: ["Review"],
    agents: [
      {
        id: 1,
        label: "cached reviewer",
        phase: "Review",
        prompt: "cached",
        status: "done",
        model: "openai-codex/gpt-5.5",
        tokens: 100_000,
      },
      {
        id: 2,
        label: "local finder",
        phase: "Review",
        prompt: "local",
        status: "done",
        model: "litellm-ny2/local-qwen27",
        tokens: 90_000,
      },
    ],
    logs: [],
    startedAt: "2026-06-27T00:00:00Z",
    updatedAt: "2026-06-27T01:00:00Z",
    completedAt: "2026-06-27T01:00:00Z",
    tokenUsage: { input: 180_000, output: 10_000, total: 190_000, cacheRead: 80_000, cacheWrite: 0, cost: 0.4 },
    journal: [
      {
        index: 0,
        hash: "a",
        result: "ok",
        model: "openai-codex/gpt-5.5",
        usage: { input: 100_000, output: 5_000, total: 105_000, cacheRead: 80_000, cacheWrite: 0, cost: 0.4 },
      },
      {
        index: 1,
        hash: "b",
        result: "ok",
        model: "litellm-ny2/local-qwen27",
        usage: { input: 90_000, output: 5_000, total: 95_000, cacheRead: 0, cacheWrite: 0, cost: 0 },
      },
    ],
  };
}

test("parseTelemetryWindow supports relative windows and ISO timestamps", () => {
  const now = new Date("2026-06-27T12:00:00Z");
  assert.equal(parseTelemetryWindow("2h", now)?.toISOString(), "2026-06-27T10:00:00.000Z");
  assert.equal(parseTelemetryWindow("2026-06-27T01:00:00Z")?.toISOString(), "2026-06-27T01:00:00.000Z");
});

test("buildWorkflowTelemetryReport aggregates usage and flags low-cache large generations", () => {
  const report = buildWorkflowTelemetryReport({
    runs: [sampleRun()],
    compactionEvents: [
      { type: "monitor_eval", recommended: true, occupancy: 1.2, estReclaim: 50_000, workflowRunId: "run-abc" },
    ],
    since: new Date("2026-06-26T00:00:00Z"),
  });

  assert.equal(report.totals.runs, 1);
  assert.equal(report.totals.agents, 2);
  assert.equal(report.byModel["openai-codex/gpt-5.5"].cacheReadPct, 80_000 / (100_000 + 80_000));
  assert.equal(report.byModel["litellm-ny2/local-qwen27"].cacheReadPct, 0);
  assert.ok(report.anomalies.some((a) => a.kind === "large_low_cache" && a.agentLabel === "local finder"));
  assert.ok(report.anomalies.some((a) => a.kind === "context_overrun"));
  assert.equal(report.compaction.recommended, 1);
  assert.equal(report.traceLinks[0].traceId, workflowLangfuseTraceId("run-abc"));
  assert.equal(report.traceLinks[0].runStatePath, "/tmp/pi-runs/run-abc.json");
  const lowCacheAnomaly = report.anomalies.find((a) => a.kind === "large_low_cache" && a.agentLabel === "local finder");
  assert.ok(lowCacheAnomaly);
  assert.equal(lowCacheAnomaly.runStatePath, "/tmp/pi-runs/run-abc.json");
});

test("buildWorkflowTelemetryReport includes lean-ctx cache and compression summary", () => {
  const run = sampleRun();
  run.agents = [
    {
      id: 1,
      label: "ctx agent",
      prompt: "a",
      status: "done",
      model: "m/a",
      history: [
        { role: "assistant", kind: "toolCall", toolName: "ctx_read", text: "{}" },
        {
          role: "tool",
          kind: "toolResult",
          toolName: "ctx_read",
          text: "source=lean-ctx-bridge\nCompressed 1,000 → 100 tok\nsecond_read_is_stub=true",
        },
      ],
    },
  ];
  run.journal = [];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.equal(report.leanCtx.ctxToolCalls, 1);
  assert.equal(report.leanCtx.savedTokens, 900);
  assert.equal(report.leanCtx.cacheStubHits, 1);
});

test("buildWorkflowTelemetryReport falls back to journal history for resumed cached agents", () => {
  const run = sampleRun();
  run.agents = [{ id: 1, label: "cached ctx", prompt: "a", status: "done", model: "m/a" }];
  run.journal = [
    {
      index: 0,
      hash: "cached-history",
      result: "ok",
      label: "cached ctx",
      model: "m/a",
      usage: { input: 10, output: 1, total: 11, cacheRead: 0, cacheWrite: 0, cost: 0 },
      history: [
        { role: "assistant", kind: "toolCall", toolName: "ctx_read", text: "{}" },
        { role: "tool", kind: "toolResult", toolName: "ctx_read", text: "Compressed 1,000 → 100 tok" },
      ],
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.equal(report.leanCtx.ctxToolCalls, 1);
  assert.equal(report.leanCtx.savedTokens, 900);
});

test("buildWorkflowTelemetryReport deduplicates active agent and journal history", () => {
  const run = sampleRun();
  const history = [
    { role: "assistant" as const, kind: "toolCall" as const, toolName: "ctx_read", text: "{}" },
    { role: "tool" as const, kind: "toolResult" as const, toolName: "ctx_read", text: "Compressed 1,000 → 100 tok" },
  ];
  run.status = "running";
  run.agents = [{ id: 1, label: "active ctx", prompt: "a", status: "running", model: "m/a", history }];
  run.journal = [
    {
      index: 0,
      hash: "active-history",
      result: "ok",
      label: "active ctx",
      model: "m/a",
      usage: { input: 10, output: 1, total: 11, cacheRead: 0, cacheWrite: 0, cost: 0 },
      history: [...history],
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.equal(report.leanCtx.ctxToolCalls, 1);
  assert.equal(report.leanCtx.savedTokens, 900);
});

test("buildWorkflowTelemetryReport keeps identical histories from distinct agents", () => {
  const run = sampleRun();
  const history = [
    { role: "assistant" as const, kind: "toolCall" as const, toolName: "ctx_read", text: "{}" },
    { role: "tool" as const, kind: "toolResult" as const, toolName: "ctx_read", text: "Compressed 1,000 → 100 tok" },
  ];
  run.agents = [
    { id: 1, label: "ctx one", prompt: "a", status: "done", model: "m/a", history },
    { id: 2, label: "ctx two", prompt: "b", status: "done", model: "m/a", history: [...history] },
  ];
  run.journal = [];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.equal(report.leanCtx.ctxToolCalls, 2);
  assert.equal(report.leanCtx.savedTokens, 1_800);
});

test("buildWorkflowTelemetryReport skips checkpoint journal entries when matching agent usage", () => {
  const run = sampleRun();
  run.agents = [
    { id: 1, label: "agent A", prompt: "a", status: "done", model: "m/a" },
    { id: 2, label: "agent B", prompt: "b", status: "done", model: "m/b" },
  ];
  run.journal = [
    {
      index: 0,
      hash: "agent-a",
      result: "a",
      label: "agent A",
      model: "m/a",
      usage: { input: 10, output: 1, total: 11, cacheRead: 0, cacheWrite: 0, cost: 0 },
    },
    { index: 1, hash: "checkpoint", result: "approved" },
    {
      index: 2,
      hash: "agent-b",
      result: "b",
      label: "agent B",
      model: "m/b",
      usage: { input: 20, output: 2, total: 22, cacheRead: 5, cacheWrite: 0, cost: 0 },
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });

  assert.equal(report.byAgentLabel["agent A"].input, 10);
  assert.equal(report.byAgentLabel["agent B"].input, 20);
  assert.equal(report.byModel["m/b"].cacheRead, 5);
  assert.equal(report.totals.input, 30);
});

test("buildWorkflowTelemetryReport preserves legacy agent usage after checkpoint journal entries", () => {
  const run = sampleRun();
  run.agents = [{ id: 1, label: "legacy after checkpoint", prompt: "a", status: "done", model: "m/a" }];
  run.journal = [
    { index: 0, hash: "checkpoint", result: true },
    {
      index: 1,
      hash: "legacy-a",
      result: "a",
      model: "m/a",
      usage: { input: 10, output: 1, total: 11, cacheRead: 0, cacheWrite: 0, cost: 0 },
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });

  assert.equal(report.byAgentLabel["legacy after checkpoint"].input, 10);
  assert.equal(
    report.anomalies.some((a) => a.kind === "missing_usage"),
    false,
  );
});

test("buildWorkflowTelemetryReport matches resumed journals after label-only edits", () => {
  const run = sampleRun();
  run.agents = [{ id: 1, label: "new label", prompt: "a", status: "done", model: "m/a" }];
  run.journal = [
    {
      index: 0,
      hash: "old-label-same-hash",
      result: "a",
      label: "old label",
      model: "m/a",
      usage: { input: 10, output: 1, total: 11, cacheRead: 0, cacheWrite: 0, cost: 0 },
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });

  assert.equal(report.byAgentLabel["new label"].input, 10);
  assert.equal(
    report.anomalies.some((a) => a.kind === "missing_usage"),
    false,
  );
});

test("buildWorkflowTelemetryReport preserves unlabeled legacy journal usage in mixed journals", () => {
  const run = sampleRun();
  run.agents = [
    { id: 1, label: "legacy A", prompt: "a", status: "done", model: "m/a" },
    { id: 2, label: "agent B", prompt: "b", status: "done", model: "m/b" },
  ];
  run.journal = [
    {
      index: 0,
      hash: "legacy-a",
      result: "a",
      model: "m/a",
      usage: { input: 10, output: 1, total: 11, cacheRead: 0, cacheWrite: 0, cost: 0 },
    },
    {
      index: 1,
      hash: "agent-b",
      result: "b",
      label: "agent B",
      model: "m/b",
      usage: { input: 20, output: 2, total: 22, cacheRead: 5, cacheWrite: 0, cost: 0 },
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });

  assert.equal(report.byAgentLabel["legacy A"].input, 10);
  assert.equal(report.byAgentLabel["agent B"].input, 20);
  assert.equal(report.totals.input, 30);
});

test("buildWorkflowTelemetryReport does not shift usage across a failed agent journal gap", () => {
  const run = sampleRun();
  run.agents = [
    { id: 1, label: "failed A", prompt: "a", status: "error", model: "m/a" },
    { id: 2, label: "agent B", prompt: "b", status: "done", model: "m/b" },
  ];
  run.journal = [
    {
      index: 1,
      hash: "agent-b",
      result: "b",
      label: "agent B",
      model: "m/b",
      usage: { input: 20, output: 2, total: 22, cacheRead: 5, cacheWrite: 0, cost: 0 },
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });

  assert.equal(report.byAgentLabel["failed A"], undefined);
  assert.equal(report.byAgentLabel["agent B"].input, 20);
  assert.ok(report.anomalies.some((a) => a.kind === "missing_usage" && a.agentLabel === "failed A"));
});

test("buildWorkflowTelemetryReport does not match reused labels to failed agents", () => {
  const run = sampleRun();
  run.agents = [
    { id: 1, label: "worker", prompt: "a", status: "error", model: "m/a" },
    { id: 2, label: "worker", prompt: "b", status: "done", model: "m/b" },
  ];
  run.journal = [
    {
      index: 1,
      hash: "worker-b",
      result: "b",
      label: "worker",
      model: "m/b",
      usage: { input: 20, output: 2, total: 22, cacheRead: 5, cacheWrite: 0, cost: 0 },
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });

  assert.equal(report.byAgentLabel.worker.input, 20);
  assert.equal(report.byModel["m/b"].input, 20);
  assert.equal(report.byModel["m/a"], undefined);
  assert.ok(report.anomalies.some((a) => a.kind === "missing_usage" && a.agentLabel === "worker"));
});

test("buildWorkflowTelemetryReport does not fill failed gaps with later unlabeled legacy journals", () => {
  const run = sampleRun();
  run.agents = [
    { id: 1, label: "failed A", prompt: "a", status: "error", model: "m/a" },
    { id: 2, label: "legacy B", prompt: "b", status: "done", model: "m/b" },
  ];
  run.journal = [
    {
      index: 1,
      hash: "legacy-b",
      result: "b",
      model: "m/b",
      usage: { input: 20, output: 2, total: 22, cacheRead: 5, cacheWrite: 0, cost: 0 },
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });

  assert.equal(report.byAgentLabel["failed A"], undefined);
  assert.equal(report.byAgentLabel["legacy B"].input, 20);
  assert.ok(report.anomalies.some((a) => a.kind === "missing_usage" && a.agentLabel === "failed A"));
});

test("buildWorkflowTelemetryReport does not flag in-progress agents as missing usage", () => {
  const run = sampleRun();
  run.status = "running";
  run.agents = [
    { id: 1, label: "running A", prompt: "a", status: "running", model: "m/a" },
    { id: 2, label: "queued B", prompt: "b", status: "queued", model: "m/b" },
    { id: 3, label: "skipped C", prompt: "c", status: "skipped", model: "m/c" },
  ];
  run.journal = [];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.equal(
    report.anomalies.some((a) => a.kind === "missing_usage"),
    false,
  );
});

test("buildWorkflowTelemetryReport safely rolls up prototype-key labels and models", () => {
  const run = sampleRun();
  run.agents = [
    { id: 1, label: "__proto__", prompt: "a", status: "done", model: "constructor" },
    { id: 2, label: "normal", prompt: "b", status: "done", model: "__proto__" },
  ];
  run.journal = [
    {
      index: 0,
      hash: "proto-label",
      result: "a",
      label: "__proto__",
      model: "constructor",
      usage: { input: 10, output: 1, total: 11, cacheRead: 0, cacheWrite: 0, cost: 0 },
    },
    {
      index: 1,
      hash: "proto-model",
      result: "b",
      label: "normal",
      model: "__proto__",
      usage: { input: 20, output: 2, total: 22, cacheRead: 0, cacheWrite: 0, cost: 0 },
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });
  const protoKey = "__proto__";
  const constructorKey = "constructor";

  assert.equal(report.byAgentLabel[protoKey].input, 10);
  assert.equal(report.byModel[constructorKey].input, 10);
  assert.equal(report.byModel[protoKey].input, 20);
  assert.equal(report.totals.input, 30);
});

test("buildWorkflowTelemetryReport uses agent estimates when provider usage is zero", () => {
  const run = sampleRun();
  run.agents = [{ id: 1, label: "zero provider", prompt: "a", status: "done", model: "m/zero", tokens: 123 }];
  run.journal = [
    {
      index: 0,
      hash: "zero",
      result: "ok",
      label: "zero provider",
      model: "m/zero",
      usage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    },
  ];
  run.tokenUsage = { input: 0, output: 0, total: 123, cacheRead: 0, cacheWrite: 0, cost: 0 };

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.equal(report.byAgentLabel["zero provider"].total, 123);
  assert.equal(report.byModel["m/zero"].total, 123);
  assert.equal(report.totals.total, 123);
});

test("buildWorkflowTelemetryReport reconciles run aggregate usage for retries and unattributed attempts", () => {
  const run = sampleRun();
  run.agents = [{ id: 1, label: "retrying", prompt: "a", status: "done", model: "m/retry" }];
  run.journal = [
    {
      index: 0,
      hash: "retrying",
      result: "ok",
      label: "retrying",
      model: "m/retry",
      usage: { input: 10, output: 1, total: 11, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    },
  ];
  run.tokenUsage = { input: 30, output: 3, total: 33, cacheRead: 4, cacheWrite: 0, cost: 0.03 };

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.equal(report.byAgentLabel.retrying.total, 11);
  assert.equal(report.byModel["unattributed run aggregate"].total, 22);
  assert.equal(report.totals.total, 33);
  assert.equal(report.totals.input, 30);
});

test("buildWorkflowTelemetryReport flags low-cache anomalies in unattributed aggregate usage", () => {
  const run = sampleRun();
  run.agents = [{ id: 1, label: "paused agent", prompt: "a", status: "error", model: "m/pause", tokens: 100 }];
  run.journal = [];
  run.tokenUsage = { input: 90_000, output: 10, total: 100, cacheRead: 0, cacheWrite: 0, cost: 0.25 };

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.ok(
    report.anomalies.some(
      (a) => a.kind === "large_low_cache" && a.agentLabel === "unattributed run aggregate" && a.input === 90_000,
    ),
  );
});

test("buildWorkflowTelemetryReport treats missing legacy cache fields as zero for low-cache checks", () => {
  const run = sampleRun();
  run.agents = [{ id: 1, label: "legacy cache", prompt: "a", status: "done", model: "m/legacy" }];
  run.journal = [
    {
      index: 0,
      hash: "legacy-cache",
      result: "ok",
      label: "legacy cache",
      model: "m/legacy",
      usage: { input: 90_000, output: 10, total: 90_010, cacheWrite: 0, cost: 0 } as AgentUsage,
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.ok(report.anomalies.some((a) => a.kind === "large_low_cache" && a.agentLabel === "legacy cache"));
});

test("buildWorkflowTelemetryReport reconciles aggregate input/cache/cost when totals already match", () => {
  const run = sampleRun();
  run.agents = [{ id: 1, label: "paused agent", prompt: "a", status: "error", model: "m/pause", tokens: 100 }];
  run.journal = [];
  run.tokenUsage = { input: 90, output: 10, total: 100, cacheRead: 30, cacheWrite: 5, cost: 0.25 };

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [] });

  assert.equal(report.byAgentLabel["paused agent"].total, 100);
  assert.equal(report.byAgentLabel["paused agent"].input, 0);
  assert.equal(report.byModel["unattributed run aggregate"].total, 0);
  assert.equal(report.byModel["unattributed run aggregate"].input, 90);
  assert.equal(report.totals.total, 100);
  assert.equal(report.totals.input, 90);
  assert.equal(report.totals.cacheRead, 30);
  assert.equal(report.totals.cost, 0.25);
});

test("buildWorkflowTelemetryReport filters compaction events to selected workflow runs", () => {
  const report = buildWorkflowTelemetryReport({
    runs: [sampleRun()],
    compactionEvents: [
      { type: "monitor_eval", recommended: true, occupancy: 1.2, workflowRunId: "run-abc" },
      { type: "monitor_eval", recommended: true, occupancy: 1.5, workflowRunId: "run-other" },
      { type: "monitor_eval", recommended: true, occupancy: 1.8 },
    ],
  });

  assert.equal(report.compaction.total, 1);
  assert.equal(report.compaction.maxOccupancy, 1.2);
  assert.equal(report.anomalies.filter((a) => a.kind === "context_overrun").length, 1);
});

test("buildWorkflowTelemetryReport filters supplied compaction events by report window and session", () => {
  const run = sampleRun();
  run.sessionId = "session-a";
  run.updatedAt = "2026-06-28T12:00:00Z";
  const report = buildWorkflowTelemetryReport({
    runs: [run],
    sessionId: "session-a",
    since: new Date("2026-06-28T00:00:00Z"),
    until: new Date("2026-06-29T00:00:00Z"),
    compactionEvents: [
      {
        type: "monitor_eval",
        recommended: true,
        occupancy: 1.1,
        workflowRunId: "run-abc",
        sessionId: "session-a",
        timestamp: "2026-06-28T12:00:00Z",
      },
      {
        type: "monitor_eval",
        recommended: true,
        occupancy: 1.2,
        workflowRunId: "run-abc",
        sessionId: "session-a",
        timestamp: "2026-06-27T12:00:00Z",
      },
      {
        type: "monitor_eval",
        recommended: true,
        occupancy: 1.3,
        workflowRunId: "run-abc",
        sessionId: "session-b",
        timestamp: "2026-06-28T12:00:00Z",
      },
    ],
  });

  assert.equal(report.compaction.total, 1);
  assert.equal(report.compaction.maxOccupancy, 1.1);
});

test("buildWorkflowTelemetryReport filters file compaction events before applying the tail limit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-telemetry-report-"));
  const eventsPath = join(cwd, "events.jsonl");
  try {
    const lines = [
      JSON.stringify({ type: "monitor_eval", recommended: true, occupancy: 1.2, workflow_run_id: "run-abc" }),
      ...Array.from({ length: 1001 }, (_, index) =>
        JSON.stringify({
          type: "monitor_eval",
          recommended: true,
          occupancy: 1.5,
          workflow_run_id: `run-other-${index}`,
          pad: "x".repeat(5_000),
        }),
      ),
    ];
    writeFileSync(eventsPath, `${lines.join("\n")}\n`);

    const report = buildWorkflowTelemetryReport({ runs: [sampleRun()], compactionEventsPath: eventsPath });

    assert.equal(report.compaction.total, 1);
    assert.equal(report.compaction.maxOccupancy, 1.2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildWorkflowTelemetryReport reports cache impact around compaction boundaries", () => {
  const run = sampleRun();
  run.agents = [
    {
      id: 1,
      label: "warm before compaction",
      prompt: "a",
      status: "done",
      model: "meridian/claude-opus-4-8:high",
      startedAt: "2026-06-27T00:00:00Z",
      endedAt: "2026-06-27T00:01:00Z",
    },
    {
      id: 2,
      label: "cold after compaction",
      prompt: "b",
      status: "done",
      model: "meridian/claude-opus-4-8:high",
      startedAt: "2026-06-27T00:02:00Z",
      endedAt: "2026-06-27T00:03:00Z",
    },
  ];
  run.journal = [
    {
      index: 0,
      hash: "before",
      result: "before",
      label: "warm before compaction",
      model: "meridian/claude-opus-4-8:high",
      usage: { input: 2, output: 10, total: 100_012, cacheRead: 100_000, cacheWrite: 0, cost: 0.1 },
      startedAt: "2026-06-27T00:00:00Z",
      endedAt: "2026-06-27T00:01:00Z",
    },
    {
      index: 1,
      hash: "after",
      result: "after",
      label: "cold after compaction",
      model: "meridian/claude-opus-4-8:high",
      usage: { input: 100_000, output: 10, total: 100_010, cacheRead: 0, cacheWrite: 40_000, cost: 0.1 },
      startedAt: "2026-06-27T00:02:00Z",
      endedAt: "2026-06-27T00:03:00Z",
    },
  ];
  run.tokenUsage = undefined;

  const report = buildWorkflowTelemetryReport({
    runs: [run],
    compactionEvents: [
      {
        type: "compaction_result",
        workflowRunId: "run-abc",
        timestamp: "2026-06-27T00:01:30Z",
        beforeTokens: 400_000,
        afterTokens: 220_000,
      },
    ],
  });

  assert.equal(report.compactionCacheImpact.compactionEvents, 1);
  assert.equal(report.compactionCacheImpact.boundariesAnalyzed, 1);
  assert.equal(report.compactionCacheImpact.coldStartsAfterCompaction, 1);
  assert.equal(report.compactionCacheImpact.cacheDropsAfterCompaction, 1);
  assert.ok((report.compactionCacheImpact.maxDropPct ?? 0) < -0.99);
  assert.equal(report.compactionCacheImpact.recent[0].afterAgentLabel, "cold after compaction");
  assert.ok(report.anomalies.some((a) => a.kind === "compaction_cache_disruption"));

  const rendered = renderWorkflowTelemetryReport(report);
  assert.match(rendered, /Cache impact around compaction/);
  assert.match(rendered, /cold starts after compaction: 1/);
  assert.match(rendered, /warm before compaction/);
});

test("buildWorkflowTelemetryReport leaves compaction cache impact empty without timestamped adjacent samples", () => {
  const report = buildWorkflowTelemetryReport({
    runs: [sampleRun()],
    compactionEvents: [{ type: "compaction_result", workflowRunId: "run-abc", beforeTokens: 10, afterTokens: 5 }],
  });

  assert.equal(report.compactionCacheImpact.compactionEvents, 1);
  assert.equal(report.compactionCacheImpact.boundariesAnalyzed, 0);
});

test("buildWorkflowTelemetryReport returns no compaction events for an empty run selection", () => {
  const report = buildWorkflowTelemetryReport({
    runs: [],
    compactionEvents: [
      { type: "monitor_eval", recommended: true, occupancy: 1.2, workflowRunId: "run-abc" },
      { type: "monitor_eval", recommended: true, occupancy: 1.8 },
    ],
  });

  assert.equal(report.compaction.total, 0);
  assert.equal(report.anomalies.filter((a) => a.kind === "context_overrun").length, 0);
});

test("renderWorkflowTelemetryReport returns a compact human-readable report", () => {
  const report = buildWorkflowTelemetryReport({ runs: [sampleRun()], compactionEvents: [] });
  const rendered = renderWorkflowTelemetryReport(report);
  assert.match(rendered, /Workflow telemetry self-optimization report/);
  assert.match(rendered, /By model/);
  assert.match(rendered, /By agent label/);
  assert.match(rendered, /Lean-ctx cache\/compression/);
  assert.match(rendered, /cached reviewer/);
  assert.match(rendered, /Trace\/run references/);
  assert.match(rendered, /state=\/tmp\/pi-runs\/run-abc\.json/);
});
