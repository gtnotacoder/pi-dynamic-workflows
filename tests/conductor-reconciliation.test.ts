import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConductorStateEnv, reconcileStaleWorkflowRun } from "../src/conductor-reconciliation.js";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHome } from "./helpers/fake-home.js";

function staleRun(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    runId: "stale-run-1",
    workflowName: "issue_delivery",
    script: "export const meta = { name: 'issue_delivery', description: 'test' }\nreturn 'stale'",
    status: "running",
    phases: ["Scout", "Thinker", "Worker", "LocalChecks", "Verifier", "Telemetry"],
    currentPhase: "Worker",
    agents: [],
    logs: [],
    startedAt: new Date("2026-06-29T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-06-29T00:01:00Z").toISOString(),
    ...overrides,
  };
}

test("parseConductorStateEnv reads simple KEY=value status files", () => {
  assert.deepEqual(
    parseConductorStateEnv(`\n# pane state\nCONDUCTOR_STATUS=needs-finalize\nBAD LINE\nQUOTED="done"\n`),
    { CONDUCTOR_STATUS: "needs-finalize", QUOTED: "done" },
  );
});

test("reconcileStaleWorkflowRun surfaces needs-finalize after local checks", () => {
  const decision = reconcileStaleWorkflowRun(
    staleRun({ currentPhase: "Telemetry", logs: ["[IssueDelivery:finalization] Running finalization gate..."] }),
  );

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-finalize");
  assert.match(decision?.semanticStatus.nextAction ?? "", /workflows status stale-run-1/);
});

test("reconcileStaleWorkflowRun maps failed local checks to needs-human", () => {
  const decision = reconcileStaleWorkflowRun(staleRun(), {
    issueDeliveryStatus: { runId: "stale-run-1", localChecks: { ok: false, summary: "type-check failed" } },
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-human");
  assert.match(decision?.semanticStatus.reason ?? "", /failed local checks/);
});

test("reconcileStaleWorkflowRun preserves finalization needs-human from status.json", () => {
  const decision = reconcileStaleWorkflowRun(staleRun(), {
    issueDeliveryStatus: {
      runId: "stale-run-1",
      finalization: {
        status: "needs-human",
        reason: "GitHub checks state could not be verified.",
        nextAction: "Authenticate gh and inspect checks.",
      },
    },
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-human");
  assert.match(decision?.semanticStatus.nextAction ?? "", /Authenticate gh/);
});

test("reconcileStaleWorkflowRun downgrades stale finalizing finalization sidecar", () => {
  const decision = reconcileStaleWorkflowRun(staleRun(), {
    issueDeliveryStatus: {
      runId: "stale-run-1",
      finalization: {
        status: "finalizing",
        reason: "GitHub checks are pending.",
        nextAction: "Monitor checks.",
      },
    },
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-finalize");
  assert.match(decision?.semanticStatus.details ?? "", /status\.json/);
});

test("reconcileStaleWorkflowRun does not treat bare successful local checks as finalizable", () => {
  const decision = reconcileStaleWorkflowRun(staleRun(), {
    issueDeliveryStatus: { runId: "stale-run-1", localChecks: { ok: true, summary: "passed" } },
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-human");
  assert.match(decision?.semanticStatus.reason ?? "", /no live owner process/);
});

test("reconcileStaleWorkflowRun does not treat LocalChecks or Verifier as finalizable", () => {
  for (const currentPhase of ["LocalChecks", "Verifier"]) {
    const decision = reconcileStaleWorkflowRun(staleRun({ currentPhase }));
    assert.equal(decision?.status, "paused");
    assert.equal(decision?.semanticStatus.status, "needs-human", currentPhase);
    assert.match(decision?.semanticStatus.reason ?? "", /no live owner process/, currentPhase);
  }
});

test("reconcileStaleWorkflowRun preserves prototype complete-pane-open semantic status", () => {
  const decision = reconcileStaleWorkflowRun(
    staleRun({
      currentPhase: "Telemetry",
      semanticStatus: {
        status: "workflow-complete-pane-open",
        reason: "Prototype execution stopped before git push and PR creation.",
      },
    }),
  );

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "workflow-complete-pane-open");
  assert.match(decision?.semanticStatus.reason ?? "", /Prototype/);
});

test("reconcileStaleWorkflowRun preserves completed prototype sidecar without finalization", () => {
  const decision = reconcileStaleWorkflowRun(staleRun(), {
    issueDeliveryStatus: {
      runId: "stale-run-1",
      prototype: true,
      plannedStepCount: 1,
      allStepsComplete: true,
      completedSteps: [{ id: "step-1" }],
      localChecks: { ok: true },
    },
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "workflow-complete-pane-open");
  assert.match(decision?.semanticStatus.nextAction ?? "", /do not run PR finalization/);
});

test("reconcileStaleWorkflowRun lets PR delivery evidence override pane-open semantic status", () => {
  const decision = reconcileStaleWorkflowRun(
    staleRun({
      semanticStatus: { status: "workflow-complete-pane-open", reason: "Opening PR delivery pane." },
      logs: ["[IssueDelivery] Pull Request creation complete! Result: https://github.example/pr/1"],
    }),
  );

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-finalize");
});

test("reconcileStaleWorkflowRun uses journaled PR delivery evidence before preserving pane-open", () => {
  const decision = reconcileStaleWorkflowRun(
    staleRun({
      semanticStatus: { status: "workflow-complete-pane-open", reason: "Opening PR delivery pane." },
      journal: [{ index: 7, hash: "hash", label: "issue-pr-delivery", result: "PR https://github.example/pr/1" }],
    }),
  );

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-finalize");
});

test("reconcileStaleWorkflowRun lets delivery evidence override stale failed checks", () => {
  const decision = reconcileStaleWorkflowRun(
    staleRun({ logs: ["[IssueDelivery:finalization] Running finalization gate..."] }),
    { issueDeliveryStatus: { runId: "stale-run-1", localChecks: { ok: false, summary: "old failure" } } },
  );

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-finalize");
});

test("reconcileStaleWorkflowRun preserves completed conductor state from state.env", () => {
  const decision = reconcileStaleWorkflowRun(staleRun(), {
    stateEnv: { CONDUCTOR_RUN_ID: "stale-run-1", CONDUCTOR_STATUS: "completed" },
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "completed");
  assert.match(decision?.semanticStatus.reason ?? "", /reported completed/);
});

test("reconcileStaleWorkflowRun continues past unmapped state env statuses", () => {
  const decision = reconcileStaleWorkflowRun(staleRun(), {
    stateEnvs: [
      { path: "state.env", env: { CONDUCTOR_RUN_ID: "stale-run-1", WORKFLOW_STATUS: "workflow-running" } },
      {
        path: ".issue-delivery/state.env",
        env: { CONDUCTOR_RUN_ID: "stale-run-1", CONDUCTOR_STATUS: "needs-finalize" },
      },
    ],
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-finalize");
  assert.match(decision?.semanticStatus.details ?? "", /\.issue-delivery\/state\.env/);
});

test("reconcileStaleWorkflowRun prioritizes finalization env over generic workflow completion", () => {
  const decision = reconcileStaleWorkflowRun(staleRun(), {
    stateEnvs: [
      {
        path: "state.env",
        env: {
          CONDUCTOR_RUN_ID: "stale-run-1",
          WORKFLOW_STATUS: "completed",
          FINALIZATION_STATUS: "needs-human",
        },
      },
    ],
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-human");
});

test("reconcileStaleWorkflowRun ignores uncorrelated sidecars", () => {
  const decision = reconcileStaleWorkflowRun(staleRun(), {
    stateEnv: { CONDUCTOR_RUN_ID: "old-run", CONDUCTOR_STATUS: "completed" },
    issueDeliveryStatus: { runId: "old-run", localChecks: { ok: true } },
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-human");
  assert.match(decision?.semanticStatus.reason ?? "", /no live owner process/);
});

test("reconcileStaleWorkflowRun ignores Issue Delivery sidecars and generic STATUS for unrelated workflows", () => {
  const decision = reconcileStaleWorkflowRun(staleRun({ workflowName: "research_topic", currentPhase: "Worker" }), {
    stateEnv: { CONDUCTOR_RUN_ID: "stale-run-1", STATUS: "success" },
    issueDeliveryStatus: { runId: "stale-run-1", completedSteps: [{ id: "step-1" }], localChecks: { ok: true } },
  });

  assert.equal(decision?.status, "paused");
  assert.equal(decision?.semanticStatus.status, "needs-human");
  assert.match(decision?.semanticStatus.reason ?? "", /no live owner process/);
});

test("WorkflowManager startup reconciles stale running issue-delivery state from sidecars", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-reconcile-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-reconcile-home-"));
  try {
    withFakeHome(fakeHome, () => {
      mkdirSync(join(cwd, ".issue-delivery"), { recursive: true });
      writeFileSync(join(cwd, "state.env"), "APP_MODE=test\n");
      writeFileSync(
        join(cwd, ".issue-delivery", "state.env"),
        "CONDUCTOR_RUN_ID=stale-sidecar\nCONDUCTOR_STATUS=needs-finalize\n",
      );
      writeFileSync(
        join(cwd, ".issue-delivery", "status.json"),
        JSON.stringify({
          runId: "stale-sidecar",
          completedSteps: [{ id: "step-1", file: "src/x.ts" }],
          localChecks: { ok: true },
        }),
      );
      const persistence = createRunPersistence(cwd);
      persistence.save(staleRun({ runId: "stale-sidecar" }));

      new WorkflowManager({ cwd });

      const recovered = persistence.load("stale-sidecar");
      assert.equal(recovered?.status, "paused");
      assert.equal(recovered?.semanticStatus?.status, "needs-finalize");
      assert.match(recovered?.semanticStatus?.details ?? "", /state\.env/);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
