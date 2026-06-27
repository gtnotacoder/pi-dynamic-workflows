import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinWorkflows } from "../src/builtin-commands.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

test("registerBuiltinWorkflows registers deep-research, adversarial-review, code-review, and fugu commands", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.equal(commands.length, 5);
  const names = commands.map((c) => c.name).sort();
  assert.deepEqual(names, ["adversarial-review", "closed_loop_issue_delivery", "code-review", "deep-research", "fugu"]);
});

test("registerBuiltinWorkflows is idempotent — skips already registered commands", () => {
  const { pi, commands } = makeCommandRegistryPi([
    "deep-research",
    "adversarial-review",
    "code-review",
    "closed_loop_issue_delivery",
    "fugu",
  ]);
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.equal(commands.length, 0, "should not re-register when already present");
});

test("registerBuiltinWorkflows registers only missing commands", () => {
  const { pi, commands } = makeCommandRegistryPi(["deep-research"]);
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.deepEqual(
    commands.map((c) => c.name).sort(),
    ["adversarial-review", "closed_loop_issue_delivery", "code-review", "fugu"],
    "should only register the missing commands",
  );
});

test("registerBuiltinWorkflows deep-research handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const deepResearchHandler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(deepResearchHandler, "deep-research handler should exist");

  // Calling with empty args should warn and return early (before running any workflow)
  const { ctx, notified } = makeNotifyCtx();
  await deepResearchHandler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("registerBuiltinWorkflows adversarial-review handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const advHandler = commands.find((c) => c.name === "adversarial-review")?.handler;
  assert.ok(advHandler, "adversarial-review handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await advHandler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("registerBuiltinWorkflows fugu handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const fuguHandler = commands.find((c) => c.name === "fugu")?.handler;
  assert.ok(fuguHandler, "fugu handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await fuguHandler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("/fugu uses WorkflowManager background path when provided", async () => {
  let started = false;
  const manager = {
    startInBackground: (script: string, args: unknown, exec: { contextMode?: string }) => {
      started = true;
      assert.match(script, /name: 'fugu'/);
      assert.deepEqual(args, { task: "solve #12" });
      assert.deepEqual(exec, { contextMode: "scoped" });
      return { runId: "fugu-run", promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/fugu-run/subagents" }),
  };
  const { pi, commands, sent } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const fuguHandler = commands.find((c) => c.name === "fugu")?.handler;
  assert.ok(fuguHandler, "fugu handler should exist");

  const { ctx } = makeNotifyCtx();
  await fuguHandler("--mode scoped solve #12", ctx);

  assert.equal(started, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "fugu:started");
  assert.match(sent[0].content ?? "", /Run ID: fugu-run/);
});

test("/adversarial-review uses WorkflowManager background path when provided", async () => {
  let started = false;
  const manager = {
    startInBackground: (_script: string, args: unknown, exec: unknown) => {
      started = true;
      assert.deepEqual(args, {
        task: "check this",
        reviewers: 2,
        threshold: 0.5,
        evidence: false,
        evidenceComponents: [],
      });
      assert.deepEqual(exec, { contextMode: undefined });
      return { runId: "adv-run", promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/adv-run/subagents" }),
  };
  const { pi, commands, sent } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const advHandler = commands.find((c) => c.name === "adversarial-review")?.handler;
  assert.ok(advHandler, "adversarial-review handler should exist");

  const { ctx } = makeNotifyCtx();
  await advHandler("check this", ctx);

  assert.equal(started, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "adversarial-review:started");
  assert.match(sent[0].content ?? "", /Run ID: adv-run/);
});

test("/adversarial-review evidence flag enables no-key evidence tools", async () => {
  const manager = {
    startInBackground: (_script: string, args: unknown, exec: { contextMode?: string; tools?: unknown[] }) => {
      assert.deepEqual(args, {
        task: "check https://github.com/example/repo/blob/main/README.md",
        reviewers: 3,
        threshold: 0.75,
        evidence: true,
        evidenceComponents: ["github", "web_fetch"],
      });
      assert.equal(exec.contextMode, undefined);
      assert.ok(Array.isArray(exec.tools), "evidence mode should inject tools into the managed run");
      assert.ok(exec.tools.length >= 1, "tool set should not be empty");
      return { runId: "adv-evidence-run", promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/adv-evidence-run/subagents" }),
  };
  const { pi, commands, sent } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const advHandler = commands.find((c) => c.name === "adversarial-review")?.handler;
  assert.ok(advHandler, "adversarial-review handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await advHandler(
    "--evidence=github --reviewers=3 --threshold=0.75 check https://github.com/example/repo/blob/main/README.md",
    ctx,
  );

  assert.equal(sent.length, 1);
  assert.match(notified.at(-1)?.message ?? "", /Reviewing with evidence/);
});

test("registerBuiltinWorkflows creates handlers with expected structure", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });

  const deepResearchCmd = commands.find((c) => c.name === "deep-research");
  assert.ok(deepResearchCmd, "deep-research should be registered");
  assert.ok(deepResearchCmd.description?.includes("Research"), "should have research description");
  assert.equal(typeof deepResearchCmd.handler, "function");

  const advReviewCmd = commands.find((c) => c.name === "adversarial-review");
  assert.ok(advReviewCmd, "adversarial-review should be registered");
  assert.ok(
    advReviewCmd.description?.includes("Investigate") || advReviewCmd.description?.includes("Review"),
    "should contain Investigate",
  );
  assert.equal(typeof advReviewCmd.handler, "function");

  const closedLoopCmd = commands.find((c) => c.name === "closed_loop_issue_delivery");
  assert.ok(closedLoopCmd, "closed_loop_issue_delivery should be registered");
  assert.ok(closedLoopCmd.description?.includes("closed-loop issue-to-PR"), "should contain issue-to-PR description");
  assert.equal(typeof closedLoopCmd.handler, "function");

  const fuguCmd = commands.find((c) => c.name === "fugu");
  assert.ok(fuguCmd, "fugu should be registered");
  assert.ok(fuguCmd.description?.includes("[Deprecated alias]"), "should contain deprecated alias description");
  assert.equal(typeof fuguCmd.handler, "function");
});
