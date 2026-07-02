import assert from "node:assert/strict";
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
