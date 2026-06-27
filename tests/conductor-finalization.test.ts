import assert from "node:assert/strict";
import test from "node:test";
import {
  checkFinalization,
  collectFinalizationState,
  evaluateFinalization,
  type FinalizationInput,
  type FinalizationShellRunner,
  runFinalizationLoop,
} from "../src/conductor-finalization.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** A clean input that, with checksState success, returns completed. */
function cleanInput(overrides: Partial<FinalizationInput> = {}): FinalizationInput {
  return {
    porcelain: "",
    currentBranch: "feat-30",
    expectedBranch: "feat-30",
    baseRef: "origin/main",
    commitsBeyondBase: 2,
    pushedUpstream: true,
    remoteHeadSha: "abcdef1234567890",
    headSha: "abcdef1234567890",
    checksState: "success",
    ...overrides,
  };
}

/** Build a fake runner whose git/gh commands return scripted output. */
function makeRunner(
  scripts: Record<string, () => string | (() => string)>,
): FinalizationShellRunner & { calls: string[] } {
  const calls: string[] = [];
  const runner: FinalizationShellRunner = async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    calls.push(key);
    const match = Object.keys(scripts).find((k) => key === k || key.startsWith(`${k} `));
    if (!match) {
      const err = new Error(`no script for: ${key}`) as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    }
    const val = scripts[match];
    if (val === undefined) {
      const err = new Error(`no script for: ${key}`) as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    }
    const out = typeof val === "function" ? (val as () => string)() : val;
    return { stdout: out, stderr: "" };
  };
  return Object.assign(runner, { calls });
}

// ─── evaluateFinalization: clean / completed ────────────────────────────────

test("evaluateFinalization: clean worktree + pushed + checks success → completed", () => {
  const r = evaluateFinalization(cleanInput());
  assert.equal(r.status, "completed");
  assert.equal(r.toRunStatus?.status, "completed");
  assert.ok(r.nextAction.length > 0);
});

// ─── evaluateFinalization: dirty worktree ───────────────────────────────────

test("evaluateFinalization: dirty worktree → needs-finalize", () => {
  const r = evaluateFinalization(cleanInput({ porcelain: " M src/a.ts\n?? src/b.ts\n" }));
  assert.equal(r.status, "needs-finalize");
  assert.match(r.reason, /uncommitted change/);
  assert.match(r.nextAction, /Commit or stash/);
});

test("evaluateFinalization: transient .fugu/ and .fastcontext/ paths are ignored", () => {
  const r = evaluateFinalization(
    cleanInput({ porcelain: "?? .fugu/run-30/state.json\n?? .fastcontext/trajectory.jsonl\n" }),
  );
  assert.equal(r.status, "completed");
});

test("evaluateFinalization: real file plus transient file → needs-finalize", () => {
  const r = evaluateFinalization(cleanInput({ porcelain: "?? .fugu/state.json\n M src/real.ts\n" }));
  assert.equal(r.status, "needs-finalize");
  assert.match(r.details ?? "", /src\/real\.ts/);
});

// ─── evaluateFinalization: rename handling ─────────────────────────────────

test("evaluateFinalization: rename into .fugu/ (real source) → blocks", () => {
  // R  src/important.ts -> .fugu/important.ts : source is a real file.
  const r = evaluateFinalization(cleanInput({ porcelain: "R  src/important.ts -> .fugu/important.ts\n" }));
  assert.equal(r.status, "needs-finalize");
  assert.match(r.details ?? "", /src\/important\.ts/);
});

test("evaluateFinalization: rename wholly within .fugu/ → ignored", () => {
  const r = evaluateFinalization(cleanInput({ porcelain: "R  .fugu/a.json -> .fugu/b.json\n" }));
  assert.equal(r.status, "completed");
});

test("evaluateFinalization: copy from real file to .fugu/ → blocks", () => {
  const r = evaluateFinalization(cleanInput({ porcelain: "C  src/real.ts -> .fugu/copy.ts\n" }));
  assert.equal(r.status, "needs-finalize");
});

// ─── evaluateFinalization: branch mismatch ─────────────────────────────────

test("evaluateFinalization: wrong branch → needs-human", () => {
  const r = evaluateFinalization(cleanInput({ currentBranch: "other", expectedBranch: "feat-30" }));
  assert.equal(r.status, "needs-human");
  assert.match(r.nextAction, /Switch to branch/);
});

test("evaluateFinalization: expectedBranch set but currentBranch unknown → needs-human", () => {
  const r = evaluateFinalization(cleanInput({ currentBranch: undefined }));
  assert.equal(r.status, "needs-human");
});

// ─── evaluateFinalization: commits beyond base ─────────────────────────────

test("evaluateFinalization: no commits beyond base → needs-finalize", () => {
  const r = evaluateFinalization(cleanInput({ commitsBeyondBase: 0 }));
  assert.equal(r.status, "needs-finalize");
  assert.match(r.reason, /No commits beyond base/);
});

// ─── evaluateFinalization: push verification ───────────────────────────────

test("evaluateFinalization: pushedUpstream false → needs-finalize with push command", () => {
  const r = evaluateFinalization(cleanInput({ pushedUpstream: false }));
  assert.equal(r.status, "needs-finalize");
  assert.match(r.nextAction, /git push -u origin/);
});

test("evaluateFinalization: pushedUpstream omitted → needs-human (no silent bypass)", () => {
  const r = evaluateFinalization(
    cleanInput({ pushedUpstream: undefined, remoteHeadSha: undefined, checksState: "success" }),
  );
  assert.notEqual(r.status, "completed");
  assert.match(r.reason, /Could not verify upstream/);
  assert.match(r.nextAction, /git push -u origin/);
});

test("evaluateFinalization: local HEAD differs from remote HEAD → needs-finalize", () => {
  const r = evaluateFinalization(cleanInput({ headSha: "aaaaaaa1111111111", remoteHeadSha: "bbbbbbb2222222222" }));
  assert.equal(r.status, "needs-finalize");
  assert.match(r.nextAction, /git push origin/);
});

// ─── evaluateFinalization: PR head SHA ─────────────────────────────────────

test("evaluateFinalization: prHeadSha mismatch → needs-human", () => {
  const r = evaluateFinalization(cleanInput({ prHeadSha: "deadbeefdeadbeefdead", headSha: "abcdef1234567890" }));
  assert.equal(r.status, "needs-human");
  assert.match(r.reason, /PR head SHA/);
});

test("evaluateFinalization: prHeadSha provided but headSha unknown → needs-human", () => {
  const r = evaluateFinalization(cleanInput({ prHeadSha: "deadbeefdeadbeefdead", headSha: undefined }));
  assert.equal(r.status, "needs-human");
});

test("evaluateFinalization: prHeadSha match passes that gate", () => {
  const r = evaluateFinalization(cleanInput({ prHeadSha: "abcdef1234567890", headSha: "abcdef1234567890" }));
  assert.equal(r.status, "completed");
});

// ─── evaluateFinalization: GitHub checks ───────────────────────────────────

test("evaluateFinalization: checks failure → needs-finalize with failing names", () => {
  const r = evaluateFinalization(cleanInput({ checksState: "failure", failingChecks: ["ci/build", "lint"] }));
  assert.equal(r.status, "needs-finalize");
  assert.match(r.reason, /ci\/build, lint/);
});

test("evaluateFinalization: checks pending → finalizing", () => {
  const r = evaluateFinalization(cleanInput({ checksState: "pending" }));
  assert.equal(r.status, "finalizing");
});

test("evaluateFinalization: checks neutral → finalizing", () => {
  const r = evaluateFinalization(cleanInput({ checksState: "neutral" }));
  assert.equal(r.status, "finalizing");
});

test("evaluateFinalization: checks unknown → needs-human (NOT finalizing/completed)", () => {
  const r = evaluateFinalization(cleanInput({ checksState: "unknown" }));
  assert.equal(r.status, "needs-human");
  assert.match(r.nextAction, /gh auth status|gh pr checks/);
});

test("evaluateFinalization: checks omitted defaults to unknown → needs-human", () => {
  const r = evaluateFinalization(cleanInput({ checksState: undefined }));
  assert.equal(r.status, "needs-human");
});

// ─── collectFinalizationState ──────────────────────────────────────────────

test("collectFinalizationState: collects porcelain, branch, head, commits, upstream, checks", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => " M src/x.ts\n",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-list --count origin/main..HEAD": () => "3\n",
    "git rev-parse --abbrev-ref @{upstream}": () => "origin/feat-30\n",
    "git rev-parse @{upstream}": () => "abcdef1234567890\n",
    "gh pr checks --json name,state": () => JSON.stringify([{ name: "ci", state: "success" }]),
  });
  const input = await collectFinalizationState(
    "/tmp/repo",
    { expectedBranch: "feat-30", baseRef: "origin/main" },
    runner,
  );
  assert.equal(input.currentBranch, "feat-30");
  assert.equal(input.headSha, "abcdef1234567890");
  assert.equal(input.commitsBeyondBase, 3);
  assert.equal(input.pushedUpstream, true);
  assert.equal(input.remoteHeadSha, "abcdef1234567890");
  assert.equal(input.checksState, "success");
});

test("collectFinalizationState: no upstream → pushedUpstream false", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => "",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-parse --abbrev-ref @{upstream}": () => {
      throw new Error("fatal: no upstream");
    },
    "gh pr checks --json name,state": () => "[]",
  });
  const input = await collectFinalizationState("/tmp/repo", { queryChecks: true }, runner);
  assert.equal(input.pushedUpstream, false);
});

test("collectFinalizationState: local != remote upstream → pushedUpstream false", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => "",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-parse --abbrev-ref @{upstream}": () => "origin/feat-30\n",
    "git rev-parse @{upstream}": () => "bbbbbbb2222222222\n",
    "gh pr checks --json name,state": () => "[]",
  });
  const input = await collectFinalizationState("/tmp/repo", {}, runner);
  assert.equal(input.pushedUpstream, false);
});

test("collectFinalizationState: gh failure → checksState unknown", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => "",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-parse --abbrev-ref @{upstream}": () => "origin/feat-30\n",
    "git rev-parse @{upstream}": () => "abcdef1234567890\n",
    "gh pr checks --json name,state": () => {
      throw new Error("gh: not authenticated");
    },
  });
  const input = await collectFinalizationState("/tmp/repo", {}, runner);
  assert.equal(input.checksState, "unknown");
});

test("collectFinalizationState: queryChecks=false skips gh", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => "",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-parse --abbrev-ref @{upstream}": () => "origin/feat-30\n",
    "git rev-parse @{upstream}": () => "abcdef1234567890\n",
  });
  const input = await collectFinalizationState("/tmp/repo", { queryChecks: false }, runner);
  assert.equal(input.checksState, "unknown");
  assert.ok(!runner.calls.some((c) => c.startsWith("gh ")));
});

test("aggregateChecks via collector: pending check → pending state", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => "",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-parse --abbrev-ref @{upstream}": () => "origin/feat-30\n",
    "git rev-parse @{upstream}": () => "abcdef1234567890\n",
    "gh pr checks --json name,state": () => JSON.stringify([{ name: "ci", state: "in_progress" }]),
  });
  const input = await collectFinalizationState("/tmp/repo", {}, runner);
  assert.equal(input.checksState, "pending");
});

test("collectFinalizationState: preserves leading whitespace in porcelain ( M .fugu/... ignored)", async () => {
  // gh pr checks pending returns JSON but exits 8 — stdout must still parse.
  const runner = makeRunner({
    "git status --porcelain": () => " M .fugu/state.json\n?? .fastcontext/traj.jsonl\n",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-parse --abbrev-ref @{upstream}": () => "origin/feat-30\n",
    "git rev-parse @{upstream}": () => "abcdef1234567890\n",
    "gh pr checks --json name,state": () => JSON.stringify([{ name: "ci", state: "success" }]),
  });
  const input = await collectFinalizationState("/tmp/repo", {}, runner);
  // Transient .fugu/.fastcontext entries must be ignored → completed.
  const r = evaluateFinalization(input);
  assert.equal(r.status, "completed");
  // Sanity: porcelain preserved leading space (slice(3) yields ".fugu/...").
  assert.match(input.porcelain, /^ M .fugu\//);
});

test("collectFinalizationState: gh pr checks pending (exit 8 with stdout JSON) → pending state", async () => {
  // Simulate execFile rejecting with stdout attached, as gh does on exit 8.
  const runner: FinalizationShellRunner = async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    if (key === "git status --porcelain") return { stdout: "", stderr: "" };
    if (key === "git rev-parse --abbrev-ref HEAD") return { stdout: "feat-30\n", stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: "abcdef1234567890\n", stderr: "" };
    if (key === "git rev-parse --abbrev-ref @{upstream}") return { stdout: "origin/feat-30\n", stderr: "" };
    if (key === "git rev-parse @{upstream}") return { stdout: "abcdef1234567890\n", stderr: "" };
    if (key === "gh pr checks --json name,state") {
      const e = new Error("gh: exit 8") as Error & { stdout?: string; code?: number };
      e.stdout = JSON.stringify([{ name: "ci", state: "pending" }]);
      e.code = 8;
      throw e;
    }
    throw new Error(`unexpected: ${key}`);
  };
  const input = await collectFinalizationState("/tmp/repo", {}, runner);
  assert.equal(input.checksState, "pending");
  assert.equal(input.failingChecks, undefined);
});

test("collectFinalizationState: gh pr checks failing (non-zero exit with stdout JSON) → failure state", async () => {
  const runner: FinalizationShellRunner = async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    if (key === "git status --porcelain") return { stdout: "", stderr: "" };
    if (key === "git rev-parse --abbrev-ref HEAD") return { stdout: "feat-30\n", stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: "abcdef1234567890\n", stderr: "" };
    if (key === "git rev-parse --abbrev-ref @{upstream}") return { stdout: "origin/feat-30\n", stderr: "" };
    if (key === "git rev-parse @{upstream}") return { stdout: "abcdef1234567890\n", stderr: "" };
    if (key === "gh pr checks --json name,state") {
      const e = new Error("gh: exit 7") as Error & { stdout?: string; code?: number };
      e.stdout = JSON.stringify([
        { name: "ci/build", state: "failure" },
        { name: "lint", state: "success" },
      ]);
      e.code = 7;
      throw e;
    }
    throw new Error(`unexpected: ${key}`);
  };
  const input = await collectFinalizationState("/tmp/repo", {}, runner);
  assert.equal(input.checksState, "failure");
  assert.deepEqual(input.failingChecks, ["ci/build"]);
});

test("collectFinalizationState: gh missing/unauthenticated (no stdout) → unknown state", async () => {
  const runner: FinalizationShellRunner = async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    if (key === "git status --porcelain") return { stdout: "", stderr: "" };
    if (key === "git rev-parse --abbrev-ref HEAD") return { stdout: "feat-30\n", stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: "abcdef1234567890\n", stderr: "" };
    if (key === "git rev-parse --abbrev-ref @{upstream}") return { stdout: "origin/feat-30\n", stderr: "" };
    if (key === "git rev-parse @{upstream}") return { stdout: "abcdef1234567890\n", stderr: "" };
    if (key === "gh pr checks --json name,state") {
      const e = new Error("ENOENT gh") as Error & { code?: string };
      e.code = "ENOENT";
      throw e;
    }
    throw new Error(`unexpected: ${key}`);
  };
  const input = await collectFinalizationState("/tmp/repo", {}, runner);
  assert.equal(input.checksState, "unknown");
});

// ─── checkFinalization ─────────────────────────────────────────────────────

test("checkFinalization: clean repo with success checks → completed", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => "",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-list --count origin/main..HEAD": () => "2\n",
    "git rev-parse --abbrev-ref @{upstream}": () => "origin/feat-30\n",
    "git rev-parse @{upstream}": () => "abcdef1234567890\n",
    "gh pr checks --json name,state": () => JSON.stringify([{ name: "ci", state: "success" }]),
  });
  const r = await checkFinalization("/tmp/repo", { expectedBranch: "feat-30", baseRef: "origin/main" }, runner);
  assert.equal(r.status, "completed");
});

test("checkFinalization: collector git failure → failed (not throw)", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => {
      throw new Error("fatal: not a git repository");
    },
  });
  const r = await checkFinalization("/tmp/repo", {}, runner);
  assert.equal(r.status, "failed");
  assert.match(r.reason, /not a git repository/);
  assert.match(r.nextAction, /git repository/);
});

test("checkFinalization: unpushed commit → needs-finalize", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => "",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-list --count origin/main..HEAD": () => "2\n",
    "git rev-parse --abbrev-ref @{upstream}": () => {
      throw new Error("fatal: no upstream");
    },
    "gh pr checks --json name,state": () => JSON.stringify([{ name: "ci", state: "success" }]),
  });
  const r = await checkFinalization("/tmp/repo", { expectedBranch: "feat-30", baseRef: "origin/main" }, runner);
  assert.equal(r.status, "needs-finalize");
  assert.match(r.nextAction, /git push -u origin/);
});

test("checkFinalization: PR head mismatch → needs-human", async () => {
  const runner = makeRunner({
    "git status --porcelain": () => "",
    "git rev-parse --abbrev-ref HEAD": () => "feat-30\n",
    "git rev-parse HEAD": () => "abcdef1234567890\n",
    "git rev-list --count origin/main..HEAD": () => "2\n",
    "git rev-parse --abbrev-ref @{upstream}": () => "origin/feat-30\n",
    "git rev-parse @{upstream}": () => "abcdef1234567890\n",
    "gh pr checks --json name,state": () => JSON.stringify([{ name: "ci", state: "success" }]),
  });
  const r = await checkFinalization(
    "/tmp/repo",
    { expectedBranch: "feat-30", baseRef: "origin/main", prHeadSha: "deadbeefdeadbeefdead" },
    runner,
  );
  assert.equal(r.status, "needs-human");
});

// ─── runFinalizationLoop ───────────────────────────────────────────────────

test("runFinalizationLoop: returns completed immediately when check passes", async () => {
  const r = await runFinalizationLoop({
    check: async () => evaluateFinalization(cleanInput()),
    maxNudges: 3,
  });
  assert.equal(r.status, "completed");
});

test("runFinalizationLoop: downgrades unresolved needs-finalize to needs-human after maxNudges", async () => {
  const r = await runFinalizationLoop({
    check: async () => evaluateFinalization(cleanInput({ porcelain: " M src/x.ts\n" })),
    nudge: async () => "tried to commit",
    maxNudges: 2,
  });
  assert.equal(r.status, "needs-human");
  assert.match(r.reason, /Unresolved 'needs-finalize' after 2 nudge/);
  assert.match(r.details ?? "", /nudge #1/);
  assert.match(r.details ?? "", /nudge #2/);
});

test("runFinalizationLoop: downgrades unresolved finalizing to needs-human", async () => {
  const r = await runFinalizationLoop({
    check: async () => evaluateFinalization(cleanInput({ checksState: "pending" })),
    nudge: async () => "waited for CI",
    maxNudges: 1,
  });
  assert.equal(r.status, "needs-human");
  assert.match(r.reason, /Unresolved 'finalizing'/);
});

test("runFinalizationLoop: stops nudging once check returns completed", async () => {
  let calls = 0;
  const r = await runFinalizationLoop({
    check: async () => {
      calls += 1;
      return calls >= 2
        ? evaluateFinalization(cleanInput())
        : evaluateFinalization(cleanInput({ checksState: "pending" }));
    },
    nudge: async () => "waited",
    maxNudges: 5,
  });
  assert.equal(r.status, "completed");
  assert.equal(calls, 2);
});

test("runFinalizationLoop: needs-human from check is returned immediately (no nudge)", async () => {
  let nudged = 0;
  const r = await runFinalizationLoop({
    check: async () => evaluateFinalization(cleanInput({ checksState: "unknown" })),
    nudge: async () => {
      nudged += 1;
      return "nudged";
    },
    maxNudges: 3,
  });
  assert.equal(r.status, "needs-human");
  assert.equal(nudged, 0);
});

test("runFinalizationLoop: failed from check is returned immediately", async () => {
  const r = await runFinalizationLoop({
    check: async () => ({
      status: "failed" as const,
      reason: "collector blew up",
      nextAction: "fix git",
    }),
    maxNudges: 3,
  });
  assert.equal(r.status, "failed");
});

test("runFinalizationLoop: maxNudges=0 never nudges and downgrades non-terminal", async () => {
  const r = await runFinalizationLoop({
    check: async () => evaluateFinalization(cleanInput({ porcelain: " M x.ts\n" })),
    nudge: async () => "should not happen",
    maxNudges: 0,
  });
  assert.equal(r.status, "needs-human");
  assert.doesNotMatch(r.details ?? "", /nudge/);
});

test("runFinalizationLoop: nudge that throws is logged, loop continues", async () => {
  const r = await runFinalizationLoop({
    check: async () => evaluateFinalization(cleanInput({ porcelain: " M x.ts\n" })),
    nudge: async () => {
      throw new Error("push rejected");
    },
    maxNudges: 1,
  });
  assert.equal(r.status, "needs-human");
  assert.match(r.details ?? "", /nudge #1 failed: push rejected/);
});
