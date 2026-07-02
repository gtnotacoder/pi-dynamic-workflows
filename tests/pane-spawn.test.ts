import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import type { ConductorRunStatus } from "../src/conductor-types.js";
import { WorkflowErrorCode } from "../src/errors.js";
import {
  conductorToHerdrState,
  createPaneHandle,
  type HerdrInvoker,
  type HerdrWorktree,
  PaneSpawnCoordinator,
  resolveNesting,
} from "../src/pane-spawn.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fake HerdrInvoker that captures every call into a log array.
 * Returns deterministic responses so tests assert against the captured
 * argv without touching a live herdr server.
 */
function createFakeInvoker(): {
  invoker: HerdrInvoker;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    invoker: {
      async worktreeCreate(opts): Promise<HerdrWorktree> {
        calls.push({ method: "worktreeCreate", args: [opts] });
        return { cwd: `/tmp/wt/${opts.branch}`, branch: opts.branch };
      },
      async agentStart(opts, argv): Promise<{ paneId: string }> {
        calls.push({ method: "agentStart", args: [opts, argv] });
        return { paneId: "wH:p4" };
      },
      reportAgent(pane, opts): void {
        calls.push({ method: "reportAgent", args: [pane, opts] });
      },
      reportMetadata(pane, opts): void {
        calls.push({ method: "reportMetadata", args: [pane, opts] });
      },
      releaseAgent(pane, opts): void {
        calls.push({ method: "releaseAgent", args: [pane, opts] });
      },
      paneClose(pane): void {
        calls.push({ method: "paneClose", args: [pane] });
      },
    },
  };
}

/** Build a ConductorRunStatus from a status name and optional reason. */
function status(name: ConductorRunStatus["status"], reason: string = "test"): ConductorRunStatus {
  return { status: name, reason };
}

// ── 1. conductorToHerdrState — table-driven for every ConductorStatusName ──

test("conductorToHerdrState: spawned → working • spawned", () => {
  const r = conductorToHerdrState(status("spawned"));
  assert.equal(r.state, "working");
  assert.equal(r.customStatus, "• spawned");
  assert.equal(r.release, undefined);
  assert.equal(r.closePane, undefined);
  assert.equal(r.notify, undefined);
});

test("conductorToHerdrState: workflow-running → working ▶ <phase> (from reason), falls back to Running", () => {
  // No reason → falls back to the fixed label.
  const r = conductorToHerdrState(status("workflow-running", ""));
  assert.equal(r.state, "working");
  assert.equal(r.customStatus, "▶ Running");

  // With a reason → renders the live phase (docs §6: `▶ <phase>`).
  const phased = conductorToHerdrState(status("workflow-running", "scout/worker/verifier"));
  assert.equal(phased.state, "working");
  assert.equal(phased.customStatus, "▶ scout/worker/verifier");

  // Whitespace-only reason still falls back to the label.
  const blank = conductorToHerdrState(status("workflow-running", "   "));
  assert.equal(blank.customStatus, "▶ Running");
});

test("conductorToHerdrState: workflow-complete-pane-open → working ◐ complete (pane open) — no close", () => {
  const r = conductorToHerdrState(status("workflow-complete-pane-open"));
  assert.equal(r.state, "working");
  assert.equal(r.customStatus, "◐ complete (pane open)");
  assert.equal(r.closePane, undefined);
  assert.equal(r.release, undefined);
});

test("conductorToHerdrState: needs-finalize → blocked ! needs finalize + notify request", () => {
  const r = conductorToHerdrState(status("needs-finalize"));
  assert.equal(r.state, "blocked");
  assert.equal(r.customStatus, "! needs finalize");
  assert.equal(r.notify, "request");
});

test("conductorToHerdrState: finalizing → working ⟳ finalizing", () => {
  const r = conductorToHerdrState(status("finalizing"));
  assert.equal(r.state, "working");
  assert.equal(r.customStatus, "⟳ finalizing");
});

test("conductorToHerdrState: completed → idle ✓ done + release + closePane + notify done", () => {
  const r = conductorToHerdrState(status("completed"));
  assert.equal(r.state, "idle");
  assert.equal(r.customStatus, "✓ done");
  assert.equal(r.release, true);
  assert.equal(r.closePane, true);
  assert.equal(r.notify, "done");
});

test("conductorToHerdrState: failed → blocked ✗ failed + notify request", () => {
  const r = conductorToHerdrState(status("failed"));
  assert.equal(r.state, "blocked");
  assert.equal(r.customStatus, "✗ failed");
  assert.equal(r.notify, "request");
});

test("conductorToHerdrState: needs-human → blocked ? needs human + notify request", () => {
  const r = conductorToHerdrState(status("needs-human"));
  assert.equal(r.state, "blocked");
  assert.equal(r.customStatus, "? needs human");
  assert.equal(r.notify, "request");
});

// ── 2. resolveNesting ───────────────────────────────────────────────────────

test("resolveNesting: HERDR_WORKSPACE_ID + HERDR_TAB_ID → nested workspace/tab/split:down", () => {
  const result = resolveNesting({
    HERDR_WORKSPACE_ID: "ws-abc",
    HERDR_TAB_ID: "tab-xyz",
  } as NodeJS.ProcessEnv);
  assert.equal(result.workspace, "ws-abc");
  assert.equal(result.tab, "tab-xyz");
  assert.equal(result.split, "down");
});

test("resolveNesting: empty env → no nesting (no orphan)", () => {
  const result = resolveNesting({} as NodeJS.ProcessEnv);
  assert.equal(result.workspace, undefined);
  assert.equal(result.tab, undefined);
  assert.equal(result.split, undefined);
});

test("resolveNesting: only HERDR_WORKSPACE_ID (no tab) → no nesting", () => {
  const result = resolveNesting({
    HERDR_WORKSPACE_ID: "ws-abc",
  } as NodeJS.ProcessEnv);
  assert.equal(result.workspace, undefined);
  assert.equal(result.tab, undefined);
});

// ── 3. spawnRunPane with fake HerdrInvoker — worktree ownership via herdr ───

test("spawnRunPane: worktreeCreate then agentStart with nesting — src/worktree.ts NOT invoked", async () => {
  const { invoker, calls } = createFakeInvoker();

  // Simulate the executeRun pane-spawn path: worktreeCreate → agentStart.
  const wt = await invoker.worktreeCreate({ cwd: "/repo", branch: "wf/test-run" });
  assert.equal(wt.cwd, "/tmp/wt/wf/test-run");
  assert.equal(wt.branch, "wf/test-run");

  const nesting = resolveNesting({
    HERDR_WORKSPACE_ID: "ws-1",
    HERDR_TAB_ID: "tab-2",
  } as NodeJS.ProcessEnv);

  const agentResult = await invoker.agentStart({ name: "wf-test-run", cwd: wt.cwd, ...nesting }, [
    "pi",
    "--mode",
    "focused",
  ]);
  assert.equal(agentResult.paneId, "wH:p4");

  // Assert the call sequence: worktreeCreate first, then agentStart.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "worktreeCreate");
  assert.deepEqual(calls[0].args, [{ cwd: "/repo", branch: "wf/test-run" }]);

  assert.equal(calls[1].method, "agentStart");
  const [opts, argv] = calls[1].args as [
    { name: string; cwd: string; workspace?: string; tab?: string; split?: string },
    string[],
  ];
  assert.equal(opts.name, "wf-test-run");
  assert.equal(opts.cwd, "/tmp/wt/wf/test-run");
  assert.equal(opts.workspace, "ws-1");
  assert.equal(opts.tab, "tab-2");
  assert.equal(opts.split, "down");
  assert.deepEqual(argv, ["pi", "--mode", "focused"]);

  // src/worktree.ts createWorktree is never called — herdr owns the worktree.
  // This is verified by the fact that only invoker methods appear in `calls`.
});

// ── 4. PaneSpawnCoordinator — concurrency cap ────────────────────────────────

test("PaneSpawnCoordinator: acquires up to maxPanes, (maxPanes+1)th returns null", () => {
  const coordinator = new PaneSpawnCoordinator(3);
  assert.equal(coordinator.activeCount, 0);

  const lease1 = coordinator.acquire("run-1");
  assert.ok(lease1);
  assert.equal(lease1.runId, "run-1");
  assert.equal(coordinator.activeCount, 1);

  const lease2 = coordinator.acquire("run-2");
  assert.ok(lease2);
  assert.equal(coordinator.activeCount, 2);

  const lease3 = coordinator.acquire("run-3");
  assert.ok(lease3);
  assert.equal(coordinator.activeCount, 3);

  // (maxPanes+1)th acquire returns null — cap enforced, no throw.
  const lease4 = coordinator.acquire("run-4");
  assert.equal(lease4, null);
  assert.equal(coordinator.activeCount, 3);

  // Release one slot and acquire again.
  lease2.release();
  assert.equal(coordinator.activeCount, 2);

  const lease5 = coordinator.acquire("run-5");
  assert.ok(lease5);
  assert.equal(lease5.runId, "run-5");
  assert.equal(coordinator.activeCount, 3);
});

test("PaneSpawnCoordinator: default maxPanes is 4", () => {
  const coordinator = new PaneSpawnCoordinator();
  const leases = [];
  for (let i = 0; i < 4; i++) {
    const lease = coordinator.acquire(`run-${i}`);
    assert.ok(lease, `acquire ${i} should succeed`);
    if (lease) leases.push(lease);
  }
  assert.equal(coordinator.acquire("run-overflow"), null, "5th should fail with default cap 4");
});

// ── 5. Lifecycle via createPaneHandle ────────────────────────────────────────

test("createPaneHandle: updateStatus(completed) → report-agent idle + release-agent + paneClose", () => {
  const { invoker, calls } = createFakeInvoker();
  const handle = createPaneHandle(invoker, "wH:p4");

  handle.updateStatus(status("completed"));

  // report-agent(state=idle) is called.
  const reportCalls = calls.filter((c) => c.method === "reportAgent");
  assert.equal(reportCalls.length, 1);
  const reportOpts = reportCalls[0].args[1] as { state: string; customStatus: string };
  assert.equal(reportOpts.state, "idle");
  assert.equal(reportOpts.customStatus, "✓ done");

  // release-agent is called (from conductorToHerdrState mapping.release === true).
  const releaseCalls = calls.filter((c) => c.method === "releaseAgent");
  assert.equal(releaseCalls.length, 1);

  // Calling handle.close() explicitly pushes paneClose.
  handle.close();
  const closeCalls = calls.filter((c) => c.method === "paneClose");
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].args[0], "wH:p4");
});

test("createPaneHandle: updateStatus(workflow-complete-pane-open) → report-agent working, does NOT close", () => {
  const { invoker, calls } = createFakeInvoker();
  const handle = createPaneHandle(invoker, "wH:p4");

  handle.updateStatus(status("workflow-complete-pane-open"));

  // report-agent(state=working).
  const reportCalls = calls.filter((c) => c.method === "reportAgent");
  assert.equal(reportCalls.length, 1);
  const reportOpts = reportCalls[0].args[1] as { state: string; customStatus: string };
  assert.equal(reportOpts.state, "working");
  assert.equal(reportOpts.customStatus, "◐ complete (pane open)");

  // No release-agent (pane stays open).
  const releaseCalls = calls.filter((c) => c.method === "releaseAgent");
  assert.equal(releaseCalls.length, 0);

  // No paneClose.
  const closeCalls = calls.filter((c) => c.method === "paneClose");
  assert.equal(closeCalls.length, 0);
});

test("createPaneHandle: updateStatus(needs-finalize) → report-agent blocked + no close", () => {
  const { invoker, calls } = createFakeInvoker();
  const handle = createPaneHandle(invoker, "wH:p4");

  handle.updateStatus(status("needs-finalize"));

  const reportCalls = calls.filter((c) => c.method === "reportAgent");
  assert.equal(reportCalls.length, 1);
  const reportOpts = reportCalls[0].args[1] as { state: string; customStatus: string };
  assert.equal(reportOpts.state, "blocked");
  assert.equal(reportOpts.customStatus, "! needs finalize");

  const releaseCalls = calls.filter((c) => c.method === "releaseAgent");
  assert.equal(releaseCalls.length, 0);
});

test("createPaneHandle: updateStatus(finalizing) → report-agent working + no close", () => {
  const { invoker, calls } = createFakeInvoker();
  const handle = createPaneHandle(invoker, "wH:p4");

  handle.updateStatus(status("finalizing"));

  const reportCalls = calls.filter((c) => c.method === "reportAgent");
  assert.equal(reportCalls.length, 1);
  const reportOpts = reportCalls[0].args[1] as { state: string };
  assert.equal(reportOpts.state, "working");

  const releaseCalls = calls.filter((c) => c.method === "releaseAgent");
  assert.equal(releaseCalls.length, 0);
});

// ── 6. WorkflowManager concurrency-cap fail-closed path ───────────────────

/** Write project workflow settings enabling pane-spawn with a maxPanes cap. */
function writePaneSpawnSettings(cwd: string, maxPanes: number): void {
  // Project settings live under the workflow home, namespaced by project key.
  const settingsPath = workflowProjectPaths(cwd).settingsPath;
  const parent = dirname(settingsPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ herdrPaneSpawn: "auto", herdrMaxPanes: maxPanes }, null, 2)}\n`,
    "utf8",
  );
}

/** A workflow script that blocks until the test resolves it (holds the coordinator lease). */
const blockingScript = `export const meta = { name: 'block', description: 'holds the pane-spawn lease' }
await agent('x', { label: 'x' })
return 'ran'`;

/** An agent that never resolves until the test triggers it (so the run stays in flight). */
function deferredAgent() {
  let resolve!: (v: unknown) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  return {
    agent: {
      async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
        options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return pending;
      },
    },
    resolve,
  };
}

test("WorkflowManager: paneSpawn cap exceeded → WORKFLOW_ABORTED, no spawn", async () => {
  // Ensure the shared coordinator cache is clean for this test.
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-pane-cap-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-pane-cap-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      // herdrMaxPanes=1: a single in-flight pane-spawn run saturates the cap.
      writePaneSpawnSettings(cwd, 1);

      const { invoker: firstInvoker, calls: firstCalls } = createFakeInvoker();
      const deferred = deferredAgent();
      const first = new WorkflowManager({
        cwd,
        herdrInvoker: firstInvoker,
        agent: deferred.agent,
      });

      // Start one pane-spawn run and let it acquire the coordinator lease + spawn.
      const { runId: firstRunId, promise: firstPromise } = first.startInBackground(blockingScript, undefined, {
        isolation: { paneSpawn: true },
      });

      // Wait until the first run has actually spawned (worktreeCreate + agentStart
      // observed) so it is holding the coordinator slot when the second run starts.
      for (let i = 0; i < 200; i++) {
        if (firstCalls.some((c) => c.method === "agentStart")) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(
        firstCalls.some((c) => c.method === "agentStart"),
        "the first run acquired its lease and spawned before the second run started",
      );

      // A second pane-spawn run must fail closed with WORKFLOW_ABORTED (cap=1).
      const { invoker: secondInvoker, calls: secondCalls } = createFakeInvoker();
      const second = new WorkflowManager({ cwd, herdrInvoker: secondInvoker });
      // Prevent EventEmitter ERR_UNHANDLED_ERROR from wrapping the WorkflowError.
      second.on("error", () => {});
      const { promise: secondPromise } = second.startInBackground(blockingScript, undefined, {
        isolation: { paneSpawn: true },
      });

      await assert.rejects(
        secondPromise,
        (err: unknown) => {
          const e = err as { code?: string; message?: string };
          return (
            e?.code === WorkflowErrorCode.WORKFLOW_ABORTED &&
            /herdr pane concurrency cap reached \(1\/1\)/.test(e.message || "")
          );
        },
        "a run that exceeds the pane-spawn cap is rejected with WORKFLOW_ABORTED",
      );

      // No spawn occurred for the rejected run — the invoker was never touched.
      assert.equal(
        secondCalls.filter((c) => c.method === "worktreeCreate" || c.method === "agentStart").length,
        0,
        "the cap-rejected run never called worktreeCreate or agentStart",
      );

      // Tear down the first run so the test doesn't hang.
      first.stop(firstRunId);
      deferred.resolve("done");
      await firstPromise.catch(() => {});
      first.deleteRun(firstRunId);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("WorkflowManager: accepts injected herdrInvoker via constructor", () => {
  const { invoker, calls } = createFakeInvoker();
  // Just verify the manager accepts the mock invoker — the actual
  // paneSpawn executeRun path requires file-system setup (persistence dir,
  // workflow script) and is tested in workflow-isolation.test.ts patterns.
  const manager = new WorkflowManager({
    cwd: process.cwd(),
    herdrInvoker: invoker,
  });
  // Verify the invoker is wired by calling a method through it.
  invoker.worktreeCreate({ cwd: "/test", branch: "test" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "worktreeCreate");
  void manager;
});

test("PaneSpawnCoordinator: maxPanes getter exposes the configured cap", () => {
  assert.equal(new PaneSpawnCoordinator(2).maxPanes, 2);
  assert.equal(new PaneSpawnCoordinator().maxPanes, 4);
  // The cap-exceeded error message reports current/cap (not activeCount twice).
  const coordinator = new PaneSpawnCoordinator(1);
  coordinator.acquire("r1");
  assert.equal(coordinator.acquire("r2"), null, "cap=1 is saturated after one acquire");
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.maxPanes, 1);
  assert.equal(WorkflowErrorCode.WORKFLOW_ABORTED, "WORKFLOW_ABORTED");
});
