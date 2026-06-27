import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(report.byModel["openai-codex/gpt-5.5"].cacheReadPct, 0.8);
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

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });

  assert.equal(report.byAgentLabel["agent A"].input, 10);
  assert.equal(report.byAgentLabel["agent B"].input, 20);
  assert.equal(report.byModel["m/b"].cacheRead, 5);
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

  const report = buildWorkflowTelemetryReport({ runs: [run], compactionEvents: [], lowCacheInputThreshold: 1_000 });

  assert.equal(report.byAgentLabel["failed A"], undefined);
  assert.equal(report.byAgentLabel["agent B"].input, 20);
  assert.ok(report.anomalies.some((a) => a.kind === "missing_usage" && a.agentLabel === "failed A"));
});

test("renderWorkflowTelemetryReport returns a compact human-readable report", () => {
  const report = buildWorkflowTelemetryReport({ runs: [sampleRun()], compactionEvents: [] });
  const rendered = renderWorkflowTelemetryReport(report);
  assert.match(rendered, /Workflow telemetry self-optimization report/);
  assert.match(rendered, /By model/);
  assert.match(rendered, /Trace\/run references/);
  assert.match(rendered, /state=\/tmp\/pi-runs\/run-abc\.json/);
});
