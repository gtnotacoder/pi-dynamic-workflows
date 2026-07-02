import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function fakeAgent(result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      return result;
    },
  };
}

function throwingAgent(error: Error) {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      throw error;
    },
  };
}

/** Create a real git repo at `dir` with an initial commit so worktree add has a HEAD. */
function initGitRepo(dir: string) {
  // Seed HEAD on a throwaway branch, then rename to main: the dev VM's git hook
  // refuses commits directly on `main`, but a fresh repo needs a commit for
  // `git worktree add` to have a HEAD.
  execSync("git init -q -b __seed__", { cwd: dir });
  execSync('git config user.email "t@t"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n");
  // .pi/ is gitignored in real repos (worktrees live under .pi/worktrees/); mirror that
  // so a kept worktree doesn't show as untracked in the primary checkout's status.
  writeFileSync(join(dir, ".gitignore"), ".pi/\n");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  execSync("git branch -m main", { cwd: dir });
}

const cwdScript = `export const meta = { name: 'iso', description: 'isolation' }
return process.cwd()`;

async function withGitRepo(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-iso-"));
  initGitRepo(cwd);
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-iso-home-"));
  try {
    await withFakeHomeAsync(fakeHome, () => fn(cwd));
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("isolation: { worktree: true } runs the workflow in its own git worktree", async () => {
  await withGitRepo(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(cwdScript, undefined, {
      isolation: { worktree: true },
    });
    const result = await promise;
    const runCwd = (result.result as string).replaceAll("\\", "/");
    assert.match(runCwd, /\/\.pi\/worktrees\/run-/, "the run executed inside a .pi/worktrees/run-<id> path");
    // A completed isolated run KEEPS its worktree (outputs/edits preserved for inspection/PR):
    assert.ok(existsSync(runCwd), "a completed isolated run keeps its worktree");
    // Primary checkout's working branch is untouched (still on main, clean tree).
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    assert.equal(branch, "main", "the primary checkout stays on its working branch");
    const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
    assert.equal(status, "", "the primary checkout's tree is clean");
    // The worktree branch is kept until explicit delete:
    const branches = execSync("git branch --list", { cwd, encoding: "utf-8" });
    assert.ok(branches.includes(`pi/wf/run-${runId}`), "the run's worktree branch is kept on completion");
    // deleteRun tears down the worktree + branch (async, fire-and-forget — poll):
    manager.deleteRun(runId);
    for (let i = 0; i < 200 && existsSync(runCwd); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(!existsSync(runCwd), "deleteRun removed the completed run's worktree");
  });
});

test("isolation: worktreeRequired: true is the first-class alias for isolation: { worktree: true }", async () => {
  await withGitRepo(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(cwdScript, undefined, { worktreeRequired: true });
    const result = await promise;
    assert.match((result.result as string).replaceAll("\\", "/"), /\/\.pi\/worktrees\/run-/);
  });
});

test("isolation: without isolation the run uses the primary checkout (no worktree created)", async () => {
  await withGitRepo(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(cwdScript, undefined, {});
    const result = await promise;
    assert.equal(result.result, cwd, "no isolation → run uses the primary checkout cwd");
    assert.ok(!existsSync(join(cwd, ".pi", "worktrees")), "no worktree directory is created without isolation");
  });
});

test("isolation: the worktree is removed even when the run fails", async () => {
  await withGitRepo(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: throwingAgent(new Error("boom")) });
    const script = `export const meta = { name: 'iso_fail', description: 'fails' }
await agent('x', { label: 'x' })
return 'ran'`;
    const { runId, promise } = manager.startInBackground(script, undefined, { isolation: { worktree: true } });
    await promise.catch(() => {});
    // The run completed (agent error captured) → the worktree is KEPT (not auto-removed):
    const wtDir = join(cwd, ".pi", "worktrees");
    assert.ok(existsSync(wtDir), "a completed isolated run keeps its worktree (not auto-removed)");
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    assert.equal(branch, "main", "primary checkout untouched after an isolated run");
    // Explicit delete cleans it up:
    manager.deleteRun(runId);
    assert.ok(
      !existsSync(wtDir) || execSync(`ls -1 "${wtDir}"`, { encoding: "utf-8" }).trim() === "",
      "deleteRun cleaned up the worktree",
    );
  });
});

test("isolation: fail-closed when a required worktree is unavailable (non-git cwd)", async () => {
  // A non-git temp dir as the manager cwd: createWorktree returns non-isolated, and
  // a required isolation request must abort rather than run in the primary checkout.
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-iso-nogit-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-iso-nogit-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
      const { promise } = manager.startInBackground(cwdScript, undefined, { worktreeRequired: true });
      await assert.rejects(
        promise,
        (err: unknown) => err instanceof Error && /isolation required but worktree unavailable/i.test(err.message),
        "required isolation on a non-git cwd rejects instead of falling back",
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("isolation: preserves the caller's subdirectory inside the worktree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-iso-sub-"));
  // Seed the repo WITH the subdirectory in the initial commit (on __seed__, before
  // renaming to main — the dev VM refuses commits on main).
  execSync("git init -q -b __seed__", { cwd: repo });
  execSync('git config user.email "t@t"', { cwd: repo });
  execSync('git config user.name "t"', { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# test\n");
  execSync("mkdir -p packages/foo", { cwd: repo });
  writeFileSync(join(repo, "packages", "foo", "file.txt"), "x");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  execSync("git branch -m main", { cwd: repo });
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-iso-sub-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd: join(repo, "packages", "foo"), agent: fakeAgent() });
      const { promise } = manager.startInBackground(cwdScript, undefined, { isolation: { worktree: true } });
      const result = await promise;
      const runCwd = (result.result as string).replaceAll("\\", "/");
      assert.match(runCwd, /\/\.pi\/worktrees\/run-[^/]+\/packages\/foo$/, "run cwd is the subdir inside the worktree");
    });
  } finally {
    execSync("git worktree list", { cwd: repo, encoding: "utf-8" })
      .split("\n")
      .forEach((line) => {
        const m = line.match(/^(\S+)\s+/);
        if (m?.[1].includes(".pi/worktrees/")) execSync(`git worktree remove --force "${m[1]}"`, { cwd: repo });
      });
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("isolation: reuseWorktree reuses an existing worktree instead of creating a new one", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-iso-reuse-"));
  initGitRepo(repo);
  // Pre-create a worktree (simulating a paused run's persisted worktree).
  const reusedPath = join(repo, ".pi", "worktrees", "reused-existing");
  execSync(`git worktree add -b pi/wf/reused-existing "${reusedPath}" HEAD`, { cwd: repo });
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-iso-reuse-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd: repo, agent: fakeAgent() });
      const { promise } = manager.startInBackground(cwdScript, undefined, {
        reuseWorktree: { cwd: reusedPath, branch: "pi/wf/reused-existing", repoRoot: repo },
      });
      const result = await promise;
      // The run executed inside the REUSED worktree (not a new .pi/worktrees/run-<id>).
      assert.equal(result.result, reusedPath, "the run reuses the provided worktree cwd");
    });
  } finally {
    // executeRun's finally removes the reused worktree on terminal completion; just
    // tear down the repo (rmSync cleans any lingering git worktree metadata).
    try {
      execSync("git worktree prune", { cwd: repo });
    } catch {
      // ignore
    }
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("isolation: resume fails closed when the persisted worktree is gone (no primary-checkout fallback)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-iso-gone-"));
  initGitRepo(repo);
  const gonePath = join(repo, ".pi", "worktrees", "vanished");
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-iso-gone-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd: repo, agent: fakeAgent() });
      const { promise } = manager.startInBackground(cwdScript, undefined, {
        reuseWorktree: { cwd: gonePath, branch: "pi/wf/vanished", repoRoot: repo },
      });
      await assert.rejects(
        promise,
        (err: unknown) => err instanceof Error && /worktree no longer exists/i.test(err.message),
        "resume with a missing persisted worktree fails closed instead of running in the primary checkout",
      );
    });
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("isolation: the persisted worktree cwd is the ROOT, not the subdir-adjusted run cwd", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-iso-root-"));
  execSync("git init -q -b __seed__", { cwd: repo });
  execSync('git config user.email "t@t"', { cwd: repo });
  execSync('git config user.name "t"', { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# test\n");
  execSync("mkdir -p packages/foo", { cwd: repo });
  writeFileSync(join(repo, "packages", "foo", "file.txt"), "x");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  execSync("git branch -m main", { cwd: repo });
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-iso-root-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd: join(repo, "packages", "foo"), agent: fakeAgent() });
      const { runId, promise } = manager.startInBackground(cwdScript, undefined, { isolation: { worktree: true } });
      await promise;
      const managed = manager.getRun(runId);
      const wtCwd = (managed?.worktree?.cwd ?? "").replaceAll("\\", "/");
      assert.match(wtCwd, /\/\.pi\/worktrees\/run-[^/]+$/, "persisted worktree cwd is the worktree ROOT");
      assert.ok(!wtCwd.includes("/packages/foo"), "the subdir is NOT baked into the persisted worktree cwd");
    });
  } finally {
    execSync("git worktree prune", { cwd: repo });
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("isolation: stop() removes an isolated run's worktree on terminal abort", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-iso-stop-"));
  initGitRepo(repo);
  // Deferred agent: the run stays running until we stop it (so the worktree lingers).
  let deferredResolve: ((v: unknown) => void) | null = null;
  const pending = new Promise((resolve) => {
    deferredResolve = resolve;
  });
  const deferredAgent = {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      return pending;
    },
  };
  const script = `export const meta = { name: 'iso_stop', description: 'stop' }
await agent('x', { label: 'x' })
return 'ran'`;
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-iso-stop-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd: repo, agent: deferredAgent });
      const { runId, promise } = manager.startInBackground(script, undefined, { isolation: { worktree: true } });
      // executeRun creates the worktree as its first async step; poll until it's set.
      let wtCwd = "";
      for (let i = 0; i < 200; i++) {
        wtCwd = manager.getRun(runId)?.worktree?.cwd ?? "";
        if (wtCwd) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(wtCwd && existsSync(wtCwd), "the worktree exists while the run is in flight");
      manager.stop(runId);
      deferredResolve?.("done");
      await promise.catch(() => {});
      // After stop (terminal abort), the worktree is removed (stop + the run's finally).
      assert.ok(!existsSync(wtCwd), "stop() removed the isolated run's worktree on terminal abort");
    });
  } finally {
    execSync("git worktree prune", { cwd: repo });
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("isolation: a FAILED run keeps its worktree (resumable), only completed/aborted remove it", async () => {
  await withGitRepo(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    // A top-level throw makes runWorkflow reject → executeRun catch → status="failed".
    const script = `export const meta = { name: 'topfail', description: 'top throw' }
throw new Error('top-level boom')`;
    const { runId, promise } = manager.startInBackground(script, undefined, { isolation: { worktree: true } });
    await promise.catch(() => {});
    const managed = manager.getRun(runId);
    assert.equal(managed?.status, "failed", "the run failed (top-level throw)");
    const wtCwd = managed?.worktree?.cwd ?? "";
    assert.ok(wtCwd && existsSync(wtCwd), "a FAILED isolated run keeps its worktree for resume (not removed)");
    // Cleanup: stop/deleted would remove it; do so explicitly to avoid leaking the worktree.
    if (wtCwd)
      execSync(`git worktree remove --force "${wtCwd}" 2>/dev/null; git branch -D "pi/wf/run-${runId}" 2>/dev/null`, {
        cwd,
      });
  });
});

function writeHarnessDescriptor(dir: string, id: string, raw: Record<string, unknown>) {
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, harness_type: "pi", ...raw }));
}

test("isolation: a harness descriptor with worktreeRequired: true auto-isolates (no explicit isolation option)", async () => {
  await withGitRepo(async (cwd) => {
    writeHarnessDescriptor(cwd, "auto-iso", { worktreeRequired: true, tools: ["read"] });
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(cwdScript, undefined, { harness_config: "auto-iso" });
    const result = await promise;
    const runCwd = (result.result as string).replaceAll("\\", "/");
    assert.match(
      runCwd,
      /\/\.pi\/worktrees\/run-/,
      "auto-isolated into a worktree from the descriptor's worktreeRequired",
    );
    const managed = manager.getRun(runId);
    assert.equal(managed?.harnessSelection?.harness_config, "auto-iso", "the harness_config was honored");
    manager.deleteRun(runId);
  });
});

test("isolation: a harness descriptor WITHOUT worktreeRequired does NOT auto-isolate", async () => {
  await withGitRepo(async (cwd) => {
    writeHarnessDescriptor(cwd, "plain", { tools: ["read"] });
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(cwdScript, undefined, { harness_config: "plain" });
    const result = await promise;
    assert.equal(result.result, cwd, "a descriptor without worktreeRequired runs in the primary checkout");
  });
});

test("isolation: a SKIPPED harness (engine.min above engine) with worktreeRequired does NOT force isolation (reaches the clean-skip)", async () => {
  await withGitRepo(async (cwd) => {
    // engine.min 99.0.0 is above the running engine → loader retains it as `skipped`.
    writeHarnessDescriptor(cwd, "too-new", { engine: { min: "99.0.0" }, worktreeRequired: true, tools: ["read"] });
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(cwdScript, undefined, { harness_config: "too-new" });
    const result = await promise;
    // A skipped harness clean-skips (harness-not-wired), not an "isolation required" failure:
    assert.equal((result.result as { status?: string }).status, "harness-not-wired", "skipped harness clean-skips");
    assert.equal(result.agentCount, 0, "no agents spawned");
    assert.ok(!existsSync(join(cwd, ".pi", "worktrees")), "no worktree created for a skipped harness");
  });
});

test("isolation: descriptor worktreeRequired + an explicit tools policy FAILS CLOSED (no silent fence drop)", async () => {
  await withGitRepo(async (cwd) => {
    writeHarnessDescriptor(cwd, "auto-iso", { worktreeRequired: true, tools: ["read"] });
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(cwdScript, undefined, {
      harness_config: "auto-iso",
      tools: ["read"],
    });
    await assert.rejects(
      promise,
      (err: unknown) =>
        err instanceof Error &&
        /requires worktree isolation but an explicit tools policy cannot be preserved/i.test(err.message),
      "worktreeRequired + explicit tools fails closed",
    );
    assert.ok(!existsSync(join(cwd, ".pi", "worktrees")), "no worktree created on the fail-closed path");
  });
});

test("isolation: descriptor worktreeRequired is honored with a harness_type runtime override (opencode descriptor + --harness-type pi)", async () => {
  await withGitRepo(async (cwd) => {
    writeHarnessDescriptor(cwd, "oc-cfg", { harness_type: "opencode", worktreeRequired: true, tools: ["read"] });
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(cwdScript, undefined, {
      harness_config: "oc-cfg",
      harness_type: "pi",
    });
    const result = await promise;
    const runCwd = (result.result as string).replaceAll("\\", "/");
    assert.match(runCwd, /\/\.pi\/worktrees\/run-/, "worktreeRequired honored with the pi runtime override → isolated");
    const wtDir = join(cwd, ".pi", "worktrees");
    if (existsSync(wtDir)) {
      for (const d of execSync(`ls -1 "${wtDir}"`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean)) {
        execSync(`git worktree remove --force "${join(wtDir, d)}"`, { cwd });
        execSync(`git branch -D "pi/wf/${d}"`, { cwd });
      }
    }
  });
});

test("isolation: an invalid-runtime descriptor with worktreeRequired + a valid --harness-type override auto-isolates", async () => {
  await withGitRepo(async (cwd) => {
    // Invalid harness_type 'unknown' (descriptor.invalid), but a valid --harness-type pi
    // override redeems it: the effective runtime is pi (wired) → worktreeRequired honored.
    writeHarnessDescriptor(cwd, "badrt", { harness_type: "unknown", worktreeRequired: true, tools: ["read"] });
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(cwdScript, undefined, {
      harness_config: "badrt",
      harness_type: "pi",
    });
    const result = await promise;
    const runCwd = (result.result as string).replaceAll("\\", "/");
    assert.match(runCwd, /\/\.pi\/worktrees\/run-/, "valid override redeems the invalid descriptor runtime → isolated");
    const wtDir = join(cwd, ".pi", "worktrees");
    if (existsSync(wtDir))
      for (const d of execSync(`ls -1 "${wtDir}"`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean)) {
        execSync(`git worktree remove --force "${join(wtDir, d)}"`, { cwd });
        execSync(`git branch -D "pi/wf/${d}"`, { cwd });
      }
  });
});

test("isolation: a malformed (non-boolean) worktreeRequired is treated as not-required (no auto-isolation)", async () => {
  await withGitRepo(async (cwd) => {
    writeHarnessDescriptor(cwd, "malformed-wtr", { worktreeRequired: "yes", tools: ["read"] });
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(cwdScript, undefined, { harness_config: "malformed-wtr" });
    const result = await promise;
    assert.equal(result.result, cwd, "malformed worktreeRequired ignored → runs in primary (not auto-isolated)");
  });
});
