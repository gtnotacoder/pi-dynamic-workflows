import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { type HerdrInvoker, type HerdrWorktree, PaneSpawnCoordinator } from "../src/pane-spawn.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// ── Helpers (mirrors pane-spawn.test.ts) ─────────────────────────────────────

function createFakeInvoker(
  overrides: Partial<{
    agentStartPaneId: string;
  }> = {},
): {
  invoker: HerdrInvoker;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const agentStartPaneId = overrides.agentStartPaneId ?? "wH:p4";
  return {
    calls,
    invoker: {
      async worktreeCreate(opts): Promise<HerdrWorktree> {
        calls.push({ method: "worktreeCreate", args: [opts] });
        return { cwd: `/tmp/wt/${opts.branch}`, branch: opts.branch };
      },
      async worktreeRemove(opts): Promise<void> {
        calls.push({ method: "worktreeRemove", args: [opts] });
      },
      async agentStart(): Promise<{ paneId: string }> {
        calls.push({ method: "agentStart", args: [] });
        return { paneId: agentStartPaneId };
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
      notify(pane, opts): void {
        calls.push({ method: "notify", args: [pane, opts] });
      },
    },
  };
}

function writePaneSpawnSettings(cwd: string, maxPanes: number): void {
  const settingsPath = workflowProjectPaths(cwd).settingsPath;
  const parent = dirname(settingsPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ herdrPaneSpawn: "auto", herdrMaxPanes: maxPanes }, null, 2)}\n`,
    "utf8",
  );
}

/** A trivial agent that resolves immediately with a string result. */
function instantAgent() {
  return {
    agent: {
      async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
        options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      },
    },
  };
}

const paneSpawnScript = `export const meta = { name: 'ps', description: 'pane spawn' }
await agent('x', { label: 'x' })
return 'ran'`;

const keptOpenThenReturnScript = `export const meta = { name: 'ko', description: 'kept open then return' }
await agent('x', { label: 'x' })
setSemanticStatus({ status: 'workflow-complete-pane-open', reason: 'handoff', nextAction: 'finalize' })
return 'done'`;

const needsHumanThenReturnScript = `export const meta = { name: 'nh', description: 'needs human then return' }
await agent('x', { label: 'x' })
setSemanticStatus({ status: 'needs-human', reason: 'blocked', nextAction: 'repair' })
return 'done'`;

function setupPaneEnv(): string | undefined {
  const prev = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = "wH:test-pane";
  return prev;
}

function restorePaneEnv(prev: string | undefined): void {
  if (prev === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = prev;
}

// ── Finding #1: kept-open semantic status preserved on engine completion ──

test("applyEngineTerminalPaneStatus: workflow-complete-pane-open is not overwritten by engine completed (pane stays open)", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r3-keep1-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r3-keep1-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 4);
      const { invoker, calls } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(keptOpenThenReturnScript, undefined, {
        isolation: { paneSpawn: true },
      });

      const result = await promise;
      assert.equal(result.result, "done");

      // The workflow published workflow-complete-pane-open then returned normally.
      // The engine synthesized `completed`, but the kept-open status must be
      // preserved — the pane must NOT be closed (no paneClose call).
      const closeCalls = calls.filter((c) => c.method === "paneClose");
      assert.equal(closeCalls.length, 0, "kept-open pane must not be closed on engine completion");

      // The semantic status remains the conductor's kept-open state.
      const run = manager.getRun(runId);
      assert.equal(run?.semanticStatus?.status, "workflow-complete-pane-open");
      // And the pane handle is retained (not cleared by a synthesized completed).
      assert.ok(run?.paneHandle, "pane handle retained for kept-open status");

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("applyEngineTerminalPaneStatus: needs-human is not overwritten by engine completed (pane stays open)", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r3-keep2-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r3-keep2-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 4);
      const { invoker, calls } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(needsHumanThenReturnScript, undefined, {
        isolation: { paneSpawn: true },
      });

      await promise;

      const closeCalls = calls.filter((c) => c.method === "paneClose");
      assert.equal(closeCalls.length, 0, "needs-human pane must not be closed on engine completion");

      const run = manager.getRun(runId);
      assert.equal(run?.semanticStatus?.status, "needs-human");
      assert.ok(run?.paneHandle, "pane handle retained for needs-human status");

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Finding #2: fail closed when agentStart returns empty paneId ─────────────

test("pane-spawn: agentStart returns empty paneId → WORKFLOW_ABORTED, worktree cleaned up, lease released", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r3-empty-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r3-empty-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 4);
      // Invoker whose agentStart returns an empty paneId (simulates herdr failure).
      const { invoker, calls } = createFakeInvoker({ agentStartPaneId: "" });
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(paneSpawnScript, undefined, {
        isolation: { paneSpawn: true },
      });

      await assert.rejects(
        promise,
        (err: unknown) => {
          const e = err as { code?: string; message?: string };
          return (
            e?.code === WorkflowErrorCode.WORKFLOW_ABORTED &&
            /herdr agent start returned no pane id/.test(e.message || "")
          );
        },
        "a pane-spawn run with no paneId is rejected with WORKFLOW_ABORTED",
      );

      // agentStart was called (worktreeCreate then agentStart), but no pane handle
      // was stored and the run failed.
      assert.ok(
        calls.some((c) => c.method === "agentStart"),
        "agentStart was attempted",
      );
      const run = manager.getRun(runId);
      assert.equal(run?.paneHandle, undefined, "no pane handle stored on empty paneId");
      assert.equal(run?.paneId, undefined, "no paneId persisted on empty paneId");
      assert.equal(run?.status, "failed");

      // The coordinator lease was released (cap not consumed by the failed spawn).
      assert.equal(manager.paneCoordinator.activeCount, 0, "lease released after failed spawn");

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Finding #3: reuse retained _spawnLease on resume (idempotent acquire) ───

test("PaneSpawnCoordinator.acquire: idempotent for the same runId (resume reuses retained slot)", () => {
  const coordinator = new PaneSpawnCoordinator(1);
  // A failed/paused run retains its lease (active has runId).
  const first = coordinator.acquire("run-a");
  assert.ok(first);
  assert.equal(coordinator.activeCount, 1);

  // resume() builds a fresh ManagedRun for the same runId and re-acquires. With
  // cap=1 and the run's own pane already counting, a non-idempotent acquire would
  // return null and block resume. The idempotent path returns a lease instead.
  const resumed = coordinator.acquire("run-a");
  assert.ok(resumed, "idempotent acquire for same runId returns a lease, not null");
  assert.equal(coordinator.activeCount, 1, "membership not double-counted");

  // A different runId still enforces the cap (cap=1 is saturated).
  assert.equal(coordinator.acquire("run-b"), null, "cap still enforced for a different runId");

  // Releasing the resumed lease removes the run from active.
  resumed?.release();
  assert.equal(coordinator.activeCount, 0);
});

// ── Finding #4: explicit isolation.paneSpawn with setting off / not inside herdr fails closed ──

test("pane-spawn: explicit isolation.paneSpawn with setting 'off' → fail closed (no silent primary-checkout fallback)", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r3-off-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r3-off-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      // Settings explicitly 'off' (default), so pane-spawn cannot be honored even
      // though we are inside herdr.
      const settingsPath = workflowProjectPaths(cwd).settingsPath;
      const parent = dirname(settingsPath);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify({ herdrPaneSpawn: "off" }, null, 2)}\n`, "utf8");

      const { invoker, calls } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const { promise } = manager.startInBackground(paneSpawnScript, undefined, {
        isolation: { paneSpawn: true },
      });

      await assert.rejects(
        promise,
        (err: unknown) => {
          const e = err as { code?: string; message?: string };
          return (
            e?.code === WorkflowErrorCode.WORKFLOW_ABORTED &&
            /Pane-spawn isolation requested but cannot be honored/.test(e.message || "") &&
            /herdrPaneSpawn setting is 'off'/.test(e.message || "")
          );
        },
        "explicit paneSpawn with setting off is rejected with WORKFLOW_ABORTED",
      );

      // No spawn and no worktree fallback — the run did not execute in the primary
      // checkout silently.
      assert.equal(
        calls.filter((c) => c.method === "worktreeCreate" || c.method === "agentStart").length,
        0,
        "no herdr calls made when paneSpawn cannot be honored",
      );
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("pane-spawn: explicit isolation.paneSpawn outside herdr → fail closed", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r3-noherdr-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r3-noherdr-home-"));
  const prevPaneId = process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PANE_ID; // NOT inside herdr
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 4); // setting auto, but no HERDR_PANE_ID
      const { invoker, calls } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const { promise } = manager.startInBackground(paneSpawnScript, undefined, {
        isolation: { paneSpawn: true },
      });

      await assert.rejects(
        promise,
        (err: unknown) => {
          const e = err as { code?: string; message?: string };
          return (
            e?.code === WorkflowErrorCode.WORKFLOW_ABORTED &&
            /not inside a herdr pane \(HERDR_PANE_ID absent\)/.test(e.message || "")
          );
        },
        "explicit paneSpawn outside herdr is rejected with WORKFLOW_ABORTED",
      );

      assert.equal(
        calls.filter((c) => c.method === "worktreeCreate" || c.method === "agentStart").length,
        0,
        "no herdr calls made outside herdr",
      );
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Finding #6: count persisted panes when rebuilding the cap after restart ──

test("WorkflowManager constructor: seeds coordinator cap from persisted paneId runs on restart", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r3-restart-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r3-restart-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 2);

      // Start a pane-spawn run that keeps its pane open (workflow-complete-pane-open),
      // then drop the in-memory manager to simulate a process restart. The persisted
      // run keeps its paneId on disk.
      const { invoker } = createFakeInvoker();
      const first = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      first.on("error", () => {});
      const { runId, promise } = first.startInBackground(keptOpenThenReturnScript, undefined, {
        isolation: { paneSpawn: true },
      });
      await promise;
      const persistedPaneId = first.getRun(runId)?.paneId;
      assert.ok(persistedPaneId, "run persisted a paneId");
      // Drop the in-memory manager (simulate restart): the coordinator cache is
      // process-global, so reset it to force the new manager to rebuild the cap.
      PaneSpawnCoordinator.reset();

      // A fresh manager should seed its coordinator from the persisted paneId run,
      // so activeCount reflects the still-open pane.
      const second = new WorkflowManager({ cwd, herdrInvoker: createFakeInvoker().invoker });
      assert.equal(
        second.paneCoordinator.activeCount,
        1,
        "persisted paneId run is counted against the cap after restart",
      );

      // Cleanup: delete the persisted run (cold-delete path also tested below).
      second.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Finding #5: close persisted panes on cold deleteRun ───────────────────────

test("deleteRun (cold): persisted paneId run with no in-memory handle closes the pane and releases the cap", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r3-colddelete-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r3-colddelete-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 2);

      // Start a kept-open pane-spawn run, persisting paneId.
      const { invoker, calls } = createFakeInvoker();
      const first = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      first.on("error", () => {});
      const { runId, promise } = first.startInBackground(keptOpenThenReturnScript, undefined, {
        isolation: { paneSpawn: true },
      });
      await promise;
      const paneId = first.getRun(runId)?.paneId;
      assert.ok(paneId);
      // Reset the coordinator cache + drop the manager to simulate a cold restart
      // where the run has paneId on disk but no in-memory handle.
      // No paneClose should have happened yet (kept-open run keeps its pane).
      assert.equal(calls.filter((c) => c.method === "paneClose").length, 0, "kept-open pane not closed before restart");
      PaneSpawnCoordinator.reset();

      const { invoker: coldInvoker, calls: coldCalls } = createFakeInvoker();
      const cold = new WorkflowManager({ cwd, herdrInvoker: coldInvoker });
      assert.equal(cold.paneCoordinator.activeCount, 1, "cap seeded from persisted paneId");

      // Cold delete: no in-memory ManagedRun for runId. The persisted pane must be
      // closed and the cap membership released.
      const ok = cold.deleteRun(runId);
      assert.ok(ok, "deleteRun returned true for the persisted pane run");

      // A paneClose was issued for the persisted paneId.
      const closeCalls = coldCalls.filter((c) => c.method === "paneClose");
      assert.equal(closeCalls.length, 1, "cold delete closed the persisted pane");
      assert.equal(closeCalls[0].args[0], paneId, "closed the correct persisted paneId");

      // The cap membership was released.
      assert.equal(cold.paneCoordinator.activeCount, 0, "cap slot released by cold delete");
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Finding #7: preserve subdirectory cwd for auto pane-spawn runs ───────────

/** Resolve settings for the manager rooted at `managerCwd`: write the pane-spawn
 *  settings into that manager's project settings path. */
function writePaneSpawnSettingsAt(managerCwd: string, maxPanes: number): void {
  const settingsPath = workflowProjectPaths(managerCwd).settingsPath;
  const parent = dirname(settingsPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ herdrPaneSpawn: "auto", herdrMaxPanes: maxPanes }, null, 2)}\n`,
    "utf8",
  );
}

test("pane-spawn subdir: explicit isolation.base + manager at subdir derives runCwd under herdr worktree", async () => {
  PaneSpawnCoordinator.reset();
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-dw-r3-subdir-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r3-subdir-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    // Manager is rooted at a repo subdirectory (packages/foo); isolation.base names
    // the repo root, so spawnBase = repoRoot and relative(repoRoot, sub) =
    // 'packages/foo'. The fix derives the subpath from spawnBase (not just
    // isolation.base) so the herdr worktree runCwd becomes herdrWt.cwd/packages/foo.
    const sub = join(repoRoot, "packages", "foo");
    mkdirSync(sub, { recursive: true });

    await withFakeHomeAsync(fakeHome, async () => {
      // Write settings for the manager rooted at `sub` (inside fake home so the
      // manager reads the same project settings path).
      writePaneSpawnSettingsAt(sub, 4);
      const { invoker, calls } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd: sub, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      // The script returns the run's cwd (exposed as `cwd`/process.cwd() to the
      // workflow), so the test can assert the subdir derivation landed the run at
      // herdrWt.cwd + packages/foo instead of the herdr worktree root.
      const subDirScript = `export const meta = { name: 'sd', description: 'subdir cwd' }
await agent('x', { label: 'x' })
return process.cwd()`;

      const { runId, promise } = manager.startInBackground(subDirScript, undefined, {
        isolation: { paneSpawn: true, base: repoRoot },
      });

      const result = await promise;

      // worktreeCreate used the explicit base (repoRoot) as cwd — the herdr worktree
      // is rooted at the repo, and the subdir mapping appends packages/foo for runCwd.
      const wtCalls = calls.filter((c) => c.method === "worktreeCreate");
      assert.equal(wtCalls.length, 1, "herdr worktreeCreate called once");
      assert.equal(
        (wtCalls[0].args[0] as { cwd: string }).cwd,
        repoRoot,
        "worktreeCreate cwd is the explicit repo root",
      );
      assert.ok(
        calls.some((c) => c.method === "agentStart"),
        "pane spawned",
      );

      // The run's cwd is the herdr worktree cwd + the relative subdir (packages/foo),
      // proving the subdir derivation runs on the pane-spawn path (finding #7).
      const expectedRunCwd = join(`/tmp/wt/wf/${runId}`, "packages", "foo");
      assert.equal(result.result, expectedRunCwd, "runCwd is herdr worktree cwd + packages/foo (subdir preserved)");

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("pane-spawn subdir: auto pane-spawn (worktreeRequired, no isolation.base) appends manager subdir to herdr worktree cwd", async () => {
  // This tests finding #7 directly: when pane-spawn is triggered by the auto path
  // (herdrPaneSpawn:'auto' + worktreeRequired, no isolation.base), the subdir
  // derivation must use spawnBase (this.cwd) — but spawnBase IS this.cwd so the
  // relative is "" and runCwd = herdrWt.cwd, which is correct. The bug was that the
  // derivation only ran when isolation.base was set. With the fix, derivation runs
  // from spawnBase unconditionally, so behavior is consistent. We assert the run
  // completes and the pane is created (no crash from the derivation change).
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r3-autosub-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r3-autosub-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 4);
      const { invoker, calls } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      // Auto pane-spawn: worktreeRequired + setting auto + inside herdr (env set).
      const { runId, promise } = manager.startInBackground(paneSpawnScript, undefined, {
        worktreeRequired: true,
      });

      await promise;
      assert.ok(
        calls.some((c) => c.method === "agentStart"),
        "auto pane-spawn ran via herdr",
      );
      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Round-4 fixes ────────────────────────────────────────────────────────────

// Fix #2: kept-open guard must NOT suppress the `failed` synthesis when the
// engine has already driven managed.status to `failed` (a workflow that published
// a kept-open status then threw leaves a stale complete/attention pane).
const keptOpenThenFailScript = `export const meta = { name: 'kof', description: 'kept open then fail' }
await agent('x', { label: 'x' })
setSemanticStatus({ status: 'workflow-complete-pane-open', reason: 'handoff', nextAction: 'finalize' })
throw new Error('boom')`;

test("applyEngineTerminalPaneStatus: kept-open status is NOT preserved when the engine failed (failed pane status wins)", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r4-fail-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r4-fail-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 4);
      const { invoker, calls } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(keptOpenThenFailScript, undefined, {
        isolation: { paneSpawn: true },
      });

      await assert.rejects(promise, /boom/);

      // The workflow published workflow-complete-pane-open then threw, so the
      // engine synthesized `failed` (not preserved as the stale kept-open state).
      const run = manager.getRun(runId);
      assert.equal(run?.semanticStatus?.status, "failed", "failed semantic status synthesized after engine failure");
      assert.equal(run?.status, "failed");

      // The herdr cell was driven to the failed state (report-agent blocked + the
      // failed custom-status), proving the stale kept-open status was overridden.
      const reportCalls = calls.filter(
        (c) => c.method === "reportAgent" && (c.args[1] as { customStatus?: string }).customStatus === "✗ failed",
      );
      assert.ok(reportCalls.length >= 1, "herdr cell driven to failed status after engine failure");

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// Fix #3: agentStart failure cleanup must use the Herdr worktree API
// (herdrInvoker.worktreeRemove), not the local git removeWorktree() helper,
// so Herdr's workspace bookkeeping stays consistent.
test("pane-spawn: agentStart returns empty paneId → worktreeRemove (herdr API) called, not local git removeWorktree", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r4-wtremove-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r4-wtremove-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 4);
      const { invoker, calls } = createFakeInvoker({ agentStartPaneId: "" });
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(paneSpawnScript, undefined, {
        isolation: { paneSpawn: true },
      });

      await assert.rejects(promise, /herdr agent start returned no pane id/);

      // The Herdr worktree API was used to remove the worktree (the branch created
      // by worktreeCreate), not the local git helper — the recorded call args carry
      // the branch used at create time.
      const removeCalls = calls.filter((c) => c.method === "worktreeRemove");
      assert.equal(removeCalls.length, 1, "herdrInvoker.worktreeRemove called once on agentStart failure");
      const createCalls = calls.filter((c) => c.method === "worktreeCreate");
      assert.equal(createCalls.length, 1);
      assert.equal(
        (removeCalls[0].args[0] as { branch: string }).branch,
        (createCalls[0].args[0] as { branch: string }).branch,
        "worktreeRemove targets the same branch that worktreeCreate produced",
      );

      // No worktree leaked onto the managed run.
      const run = manager.getRun(runId);
      assert.equal(run?.worktree, undefined, "herdr worktree cleared after failed spawn");
      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// Fix #4: abort path must clear managed.paneId and persist the cleared state so a
// later process restart does not treat the stale paneId as a live pane and
// permanently consume a herdrMaxPanes slot.
test("abort: stop() clears paneId and persists — restart does not count the aborted pane against the cap", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r4-abort-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r4-abort-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 2);

      // Use a deferred agent so the run stays in flight long enough to stop().
      let resolveAgent!: (v: unknown) => void;
      const deferred = {
        agent: {
          async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
            options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
            return new Promise((r) => {
              resolveAgent = r;
            });
          },
        },
      };

      const { invoker, calls } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: deferred.agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(paneSpawnScript, undefined, {
        isolation: { paneSpawn: true },
      });

      // Wait for the pane to actually spawn before stopping.
      for (let i = 0; i < 200; i++) {
        if (calls.some((c) => c.method === "agentStart")) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(
        calls.some((c) => c.method === "agentStart"),
        "pane spawned before abort",
      );
      assert.ok(manager.getRun(runId)?.paneId, "paneId persisted while running");

      manager.stop(runId);
      resolveAgent("done");
      await promise.catch(() => {});

      // The abort finally cleared the in-memory paneId and persisted the cleared state.
      const run = manager.getRun(runId);
      assert.equal(run?.paneId, undefined, "in-memory paneId cleared after abort");

      // A fresh manager (simulating restart) must NOT count the aborted pane against
      // the cap — the persisted paneId is gone, so reconcilePaneCap() seeds nothing.
      PaneSpawnCoordinator.reset();
      const restarted = new WorkflowManager({ cwd, herdrInvoker: createFakeInvoker().invoker });
      assert.equal(
        restarted.paneCoordinator.activeCount,
        0,
        "aborted pane is not counted against the cap after restart",
      );

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// Fix #5: explicit isolation.paneSpawn (without worktreeRequired/harness_config)
// must load the primary harness configs (needsRegistry true) so runWorkflow does
// not reload descriptors from the herdr checkout cwd and silently change
// harness selection/tool policy for pane-spawn-only launches.
test("pane-spawn: explicit isolation.paneSpawn loads the primary harness registry (needsRegistry true)", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r4-registry-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r4-registry-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 4);

      // Drop a local untracked harness descriptor in the primary checkout so the
      // registry is non-empty when loaded from this.cwd. A plain isolated run
      // (worktree) preserves these descriptors; the fix makes explicit paneSpawn
      // do the same.
      const harnessDir = join(cwd, ".pi", "workflows", "harnesses");
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(
        join(harnessDir, "custom.json"),
        JSON.stringify({
          id: "custom",
          harness_type: "pi",
          worktreeRequired: false,
        }),
        "utf8",
      );

      // Spy on loadHarnessConfigRegistry via the harness_config path: when the
      // registry is loaded, requesting `custom` resolves the descriptor. The test
      // asserts the descriptor is visible to the manager (proving needsRegistry
      // was true) by launching with harness_config: 'custom' — if needsRegistry
      // were false, harnessRegistry would be undefined and the descriptor would
      // not resolve, hitting the invalid-runtime fail-closed path instead.
      const { invoker } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(paneSpawnScript, undefined, {
        isolation: { paneSpawn: true },
        harness_config: "custom",
      });

      await promise;

      // The run completed (engine completed), proving the registry was loaded
      // from the primary cwd and the descriptor resolved (otherwise the manager
      // would have failed closed on an invalid runtime before any spawn).
      const run = manager.getRun(runId);
      assert.equal(run?.status, "completed", "explicit paneSpawn loaded the primary harness registry and completed");
      assert.ok(run?.paneId === undefined, "pane lifecycle completed and paneId cleared");
      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// Fix #1: when pane-spawn is selected by the auto path (worktreeRequired/
// descriptor) with no isolation.base, spawnBase must resolve to the git repo root
// (not this.cwd) so relative(spawnBase, this.cwd) preserves the caller's
// subdirectory offset — mirroring the plain worktree path.
test("pane-spawn subdir: auto pane-spawn with no isolation.base derives repo root so manager subdir is preserved", async () => {
  PaneSpawnCoordinator.reset();
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-dw-r4-autoroot-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r4-autoroot-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    // Initialize a real git repo at repoRoot and create packages/foo so
    // resolveRepoRoot(this.cwd) returns repoRoot (not the subdirectory).
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["init", repoRoot], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git init exited ${code}`))));
    });
    const sub = join(repoRoot, "packages", "foo");
    mkdirSync(sub, { recursive: true });

    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettingsAt(sub, 4);
      const { invoker, calls } = createFakeInvoker();
      const manager = new WorkflowManager({ cwd: sub, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const subDirScript = `export const meta = { name: 'ar', description: 'auto root subdir' }
await agent('x', { label: 'x' })
return process.cwd()`;

      const { runId, promise } = manager.startInBackground(subDirScript, undefined, {
        worktreeRequired: true,
      });

      const result = await promise;

      // worktreeCreate was called with the resolved git repo root (not the
      // subdirectory), so the worktree is rooted at the repo and the subdir
      // mapping appends packages/foo for runCwd.
      const wtCalls = calls.filter((c) => c.method === "worktreeCreate");
      assert.equal(wtCalls.length, 1, "herdr worktreeCreate called once");
      assert.equal(
        (wtCalls[0].args[0] as { cwd: string }).cwd,
        repoRoot,
        "worktreeCreate cwd is the resolved git repo root (not the manager subdir)",
      );

      // runCwd is the herdr worktree cwd + packages/foo (subdir preserved), proving
      // spawnBase resolved to the repo root so relative(spawnBase, this.cwd) is
      // non-empty.
      const expectedRunCwd = join(`/tmp/wt/wf/${runId}`, "packages", "foo");
      assert.equal(result.result, expectedRunCwd, "runCwd preserves the manager subdir within the herdr worktree");

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Round-5 fixes (lifecycle consistency) ────────────────────────────────────

// A fake invoker that records the agentStart opts (so the derived pane cwd can be
// asserted). The round-3 helper drops agentStart args; this one keeps them.
function createCapturingInvoker(overrides: Partial<{ agentStartPaneId: string }> = {}): {
  invoker: HerdrInvoker;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const agentStartPaneId = overrides.agentStartPaneId ?? "wH:p4";
  return {
    calls,
    invoker: {
      async worktreeCreate(opts): Promise<HerdrWorktree> {
        calls.push({ method: "worktreeCreate", args: [opts] });
        return { cwd: `/tmp/wt/${opts.branch}`, branch: opts.branch };
      },
      async worktreeRemove(opts): Promise<void> {
        calls.push({ method: "worktreeRemove", args: [opts] });
      },
      async agentStart(opts, argv): Promise<{ paneId: string }> {
        calls.push({ method: "agentStart", args: [opts, argv] });
        return { paneId: agentStartPaneId };
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
      notify(pane, opts): void {
        calls.push({ method: "notify", args: [pane, opts] });
      },
    },
  };
}

// Fix #3 (round-5): when the manager is rooted in a repo subdirectory, the pane
// must start in the derived subdir cwd (herdrWt.cwd + relative offset), not the
// worktree root — so a kept-open handoff pane lands in the right directory.
test("pane-spawn subdir: agentStart cwd is the derived subdir cwd (not the worktree root)", async () => {
  PaneSpawnCoordinator.reset();
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-dw-r5-panecwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r5-panecwd-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    const sub = join(repoRoot, "packages", "foo");
    mkdirSync(sub, { recursive: true });

    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettingsAt(sub, 4);
      const { invoker, calls } = createCapturingInvoker();
      const manager = new WorkflowManager({ cwd: sub, herdrInvoker: invoker, agent: instantAgent().agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(paneSpawnScript, undefined, {
        isolation: { paneSpawn: true, base: repoRoot },
      });

      await promise.catch(() => {});

      const agentStartCalls = calls.filter((c) => c.method === "agentStart");
      assert.equal(agentStartCalls.length, 1, "agentStart called once");
      const startOpts = agentStartCalls[0].args[0] as { cwd: string };
      const expectedPaneCwd = join(`/tmp/wt/wf/${runId}`, "packages", "foo");
      assert.equal(
        startOpts.cwd,
        expectedPaneCwd,
        "agentStart cwd is the derived subdir cwd (herdr worktree cwd + packages/foo), not the worktree root",
      );

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// Fix #1 (round-5): pane-spawn abort cleanup must route the herdr-owned worktree
// through herdrInvoker.worktreeRemove, not the local git removeWorktree helper.
test("abort: pane-spawn worktree removed via herdrInvoker.worktreeRemove (not local git helper)", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r5-abortwt-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r5-abortwt-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 2);

      // Deferred agent so the run stays in flight long enough to stop().
      let resolveAgent!: (v: unknown) => void;
      const deferred = {
        agent: {
          async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
            options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
            return new Promise((r) => {
              resolveAgent = r;
            });
          },
        },
      };

      const { invoker, calls } = createCapturingInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: deferred.agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(paneSpawnScript, undefined, {
        isolation: { paneSpawn: true },
      });

      for (let i = 0; i < 200; i++) {
        if (calls.some((c) => c.method === "agentStart")) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(
        calls.some((c) => c.method === "agentStart"),
        "pane spawned before abort",
      );

      manager.stop(runId);
      resolveAgent("done");
      await promise.catch(() => {});

      // The herdr-owned worktree was removed through the Herdr API, targeting the
      // same branch that worktreeCreate produced — not the local git helper.
      const removeCalls = calls.filter((c) => c.method === "worktreeRemove");
      assert.equal(removeCalls.length, 1, "herdrInvoker.worktreeRemove called once on abort");
      const createCalls = calls.filter((c) => c.method === "worktreeCreate");
      assert.equal(createCalls.length, 1);
      assert.equal(
        (removeCalls[0].args[0] as { branch: string }).branch,
        (createCalls[0].args[0] as { branch: string }).branch,
        "worktreeRemove targets the same branch that worktreeCreate produced",
      );

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// Fix #2 (round-5): stop() of an already-paused pane-spawn run must close the
// pane, release the coordinator lease, clear paneId, and persist — no finally
// runs in that case, so without this the pane handle/lease/paneId leak and keep
// seeding the herdrMaxPanes cap on restart.
test("stop() of a paused pane-spawn run: closes pane, releases lease, clears paneId, persists (no restart cap leak)", async () => {
  PaneSpawnCoordinator.reset();
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-r5-stoppaused-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-r5-stoppaused-home-"));
  const prevPaneId = setupPaneEnv();
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      writePaneSpawnSettings(cwd, 2);

      // An agent that pauses itself via a pause() gate: the first call suspends
      // (the workflow runtime aborts on the controller signal), then we stop().
      // Simpler: use a deferred agent that never resolves while we pause() then
      // stop() — pause() aborts the controller, the run settles to paused, and
      // the deferred keeps executeRun's promise pending until we resolve it.
      let resolveAgent!: (v: unknown) => void;
      const deferred = {
        agent: {
          async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
            options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
            return new Promise((r) => {
              resolveAgent = r;
            });
          },
        },
      };

      const { invoker, calls } = createCapturingInvoker();
      const manager = new WorkflowManager({ cwd, herdrInvoker: invoker, agent: deferred.agent });
      manager.on("error", () => {});

      const { runId, promise } = manager.startInBackground(paneSpawnScript, undefined, {
        isolation: { paneSpawn: true },
      });

      // Wait for the pane to spawn, then pause the run (user pause).
      for (let i = 0; i < 200; i++) {
        if (calls.some((c) => c.method === "agentStart")) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(
        calls.some((c) => c.method === "agentStart"),
        "pane spawned before pause",
      );
      assert.ok(manager.getRun(runId)?.paneId, "paneId persisted while running");

      const paused = manager.pause(runId);
      assert.ok(paused, "pause() accepted the running pane-spawn run");
      assert.equal(manager.getRun(runId)?.status, "paused", "run is paused");

      // No paneClose yet — paused pane-spawn runs keep their pane open.
      assert.equal(
        calls.filter((c) => c.method === "paneClose").length,
        0,
        "paused pane-spawn pane not closed before stop()",
      );

      // Now stop() the already-paused pane-spawn run. executeRun has unwound (the
      // abort signal fired and the deferred agent's await rejected), so no finally
      // runs after stop() — the pane slot must be cleaned in stop() itself.
      const stopped = manager.stop(runId);
      assert.ok(stopped, "stop() accepted the paused pane-spawn run");
      assert.equal(manager.getRun(runId)?.status, "aborted", "run is aborted after stop()");

      // Resolve the deferred agent so executeRun's promise settles (the abort
      // already fired; resolveAgent may be unset if the abort rejected first —
      // guard it).
      try {
        resolveAgent("done");
      } catch {
        // already rejected
      }
      await promise.catch(() => {});

      // The pane was closed via stop()'s paused-pane cleanup.
      const closeCalls = calls.filter((c) => c.method === "paneClose");
      assert.equal(closeCalls.length, 1, "stop() closed the paused pane-spawn pane");

      // The in-memory paneId and lease are cleared.
      const run = manager.getRun(runId);
      assert.equal(run?.paneId, undefined, "in-memory paneId cleared by stop()");
      assert.equal(run?._spawnLease, undefined, "coordinator lease cleared by stop()");
      assert.equal(run?.paneHandle, undefined, "pane handle cleared by stop()");

      // The lease release dropped activeCount.
      assert.equal(manager.paneCoordinator.activeCount, 0, "coordinator lease released by stop()");

      // A fresh manager (simulating restart) must NOT count the stopped pane
      // against the cap — the persisted paneId is gone.
      PaneSpawnCoordinator.reset();
      const restarted = new WorkflowManager({ cwd, herdrInvoker: createCapturingInvoker().invoker });
      assert.equal(
        restarted.paneCoordinator.activeCount,
        0,
        "stopped paused pane is not counted against the cap after restart",
      );

      manager.deleteRun(runId);
    });
  } finally {
    restorePaneEnv(prevPaneId);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
