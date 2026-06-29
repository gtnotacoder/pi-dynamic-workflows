import assert from "node:assert/strict";
import test from "node:test";
import type { PersistedRunState } from "../src/run-persistence.js";
import type { WorkflowManager } from "../src/workflow-manager.js";
import { registerWorkflowTelemetryReportCommand } from "../src/workflow-telemetry-command.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

const RUN: PersistedRunState = {
  runId: "run-report",
  workflowName: "report_workflow",
  script: "export const meta = { name: 'report', description: 'report' }",
  status: "completed",
  phases: [],
  agents: [],
  logs: [],
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function managerWithRuns(runs: PersistedRunState[]): WorkflowManager {
  return { listAllRuns: () => runs } as unknown as WorkflowManager;
}

test("registerWorkflowTelemetryReportCommand registers and renders text", async () => {
  const { pi, commands, sent } = makeCommandRegistryPi();
  registerWorkflowTelemetryReportCommand(pi, { cwd: "/tmp", manager: managerWithRuns([RUN]) });

  const command = commands.find((c) => c.name === "workflow-telemetry-report");
  assert.ok(command);
  await command.handler("window=48h", makeNotifyCtx().ctx);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "workflow-telemetry-report");
  assert.match(sent[0].content ?? "", /Workflow telemetry self-optimization report/);
});

test("registerWorkflowTelemetryReportCommand honors explicit runId outside the default window", async () => {
  const oldRun: PersistedRunState = {
    ...RUN,
    runId: "old-run",
    startedAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
  };
  const { pi, commands, sent } = makeCommandRegistryPi();
  registerWorkflowTelemetryReportCommand(pi, { cwd: "/tmp", manager: managerWithRuns([oldRun]) });

  const command = commands.find((c) => c.name === "workflow-telemetry-report");
  assert.ok(command);
  await command.handler("runId=old-run json=true", makeNotifyCtx().ctx);

  let parsed: { traceLinks?: Array<{ runId?: string }>; totals?: { runs?: number } } = {};
  try {
    parsed = JSON.parse(sent[0].content ?? "{}");
  } catch (error) {
    assert.fail(`expected valid JSON report: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.equal(parsed.traceLinks?.[0]?.runId, "old-run");
  assert.equal(parsed.totals?.runs, 1);
});

test("registerWorkflowTelemetryReportCommand anchors relative windows to until", async () => {
  const historicalRun: PersistedRunState = {
    ...RUN,
    runId: "historical-run",
    startedAt: "2026-06-20T00:15:00Z",
    updatedAt: "2026-06-20T00:30:00Z",
  };
  const { pi, commands, sent } = makeCommandRegistryPi();
  registerWorkflowTelemetryReportCommand(pi, { cwd: "/tmp", manager: managerWithRuns([historicalRun]) });

  const command = commands.find((c) => c.name === "workflow-telemetry-report");
  assert.ok(command);
  await command.handler("window=24h until=2026-06-20T01:00:00Z json=true", makeNotifyCtx().ctx);

  let parsed: { traceLinks?: Array<{ runId?: string }>; totals?: { runs?: number }; window?: { since?: string } } = {};
  try {
    parsed = JSON.parse(sent[0].content ?? "{}");
  } catch (error) {
    assert.fail(`expected valid JSON report: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.equal(parsed.traceLinks?.[0]?.runId, "historical-run");
  assert.equal(parsed.totals?.runs, 1);
  assert.equal(parsed.window?.since, "2026-06-19T01:00:00.000Z");
});

test("registerWorkflowTelemetryReportCommand supports json=true", async () => {
  const { pi, commands, sent } = makeCommandRegistryPi();
  registerWorkflowTelemetryReportCommand(pi, { cwd: "/tmp", manager: managerWithRuns([RUN]) });

  const command = commands.find((c) => c.name === "workflow-telemetry-report");
  assert.ok(command);
  await command.handler("json=true", makeNotifyCtx().ctx);

  let parsed: { traceLinks?: Array<{ runId?: string }> } = {};
  try {
    parsed = JSON.parse(sent[0].content ?? "{}");
  } catch (error) {
    assert.fail(`expected valid JSON report: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.equal(parsed.traceLinks?.[0]?.runId, "run-report");
});

test("registerWorkflowTelemetryReportCommand is idempotent", () => {
  const { pi, commands } = makeCommandRegistryPi(["workflow-telemetry-report"]);
  registerWorkflowTelemetryReportCommand(pi, { cwd: "/tmp", manager: managerWithRuns([]) });
  assert.equal(commands.length, 0);
});
