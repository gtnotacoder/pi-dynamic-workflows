import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinWorkflows } from "../src/builtin-commands.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

function toolNames(tools: unknown): string[] {
  return Array.isArray(tools)
    ? tools.map((tool) => String((tool as { name?: unknown }).name ?? "")).filter(Boolean)
    : [];
}

test("registerBuiltinWorkflows registers deep-research, adversarial-review, code-review, issue-delivery, and fugu commands", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  assert.equal(commands.length, 5);
  const names = commands.map((c) => c.name).sort();
  assert.deepEqual(names, ["adversarial-review", "code-review", "deep-research", "fugu", "issue-delivery"]);
});

test("registerBuiltinWorkflows is idempotent — skips already registered commands", () => {
  const { pi, commands } = makeCommandRegistryPi([
    "deep-research",
    "adversarial-review",
    "code-review",
    "issue-delivery",
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
    ["adversarial-review", "code-review", "fugu", "issue-delivery"],
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

test("registerBuiltinWorkflows issue-delivery handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const issueDeliveryHandler = commands.find((c) => c.name === "issue-delivery")?.handler;
  assert.ok(issueDeliveryHandler, "issue-delivery handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await issueDeliveryHandler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("/issue-delivery uses WorkflowManager background path and prototype flag when provided", async () => {
  let started = false;
  const manager = {
    startInBackground: (script: string, args: unknown, exec: { contextMode?: string }) => {
      started = true;
      assert.match(script, /name: 'issue_delivery'/);
      assert.deepEqual(args, { task: "solve #12", prototype: true });
      assert.deepEqual(exec, { contextMode: "scoped", harness_type: undefined, harness_config: undefined });
      return { runId: "issue-run", promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/issue-run/subagents" }),
  };
  const { pi, commands, sent } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const issueDeliveryHandler = commands.find((c) => c.name === "issue-delivery")?.handler;
  assert.ok(issueDeliveryHandler, "issue-delivery handler should exist");

  const { ctx } = makeNotifyCtx();
  await issueDeliveryHandler("--mode scoped --prototype solve #12", ctx);

  assert.equal(started, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "issue-delivery:started");
  assert.match(sent[0].content ?? "", /Run ID: issue-run/);
});

test("/issue-delivery parses prototype dry-run guardrail options", async () => {
  const manager = {
    startInBackground: (_script: string, args: Record<string, unknown>, exec: { contextMode?: string }) => {
      assert.deepEqual(args, {
        prototype: true,
        dryRun: false,
        maxSteps: 2,
        worktreeRequired: false,
        allowSharedCheckout: true,
        baseBranch: "main",
        task: "implement #35",
      });
      assert.deepEqual(exec, { contextMode: undefined, harness_type: undefined, harness_config: undefined });
      return { runId: "issue-run", promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/issue-run/subagents" }),
  };
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const issueDeliveryHandler = commands.find((c) => c.name === "issue-delivery")?.handler;
  assert.ok(issueDeliveryHandler, "issue-delivery handler should exist");

  const { ctx } = makeNotifyCtx();
  await issueDeliveryHandler(
    "--prototype --dry-run=false --max-steps=2 --worktree-required=false --allow-shared-checkout --base-branch main implement #35",
    ctx,
  );
});

test("/issue-delivery dry-run implies prototype lane and preserves repo option", async () => {
  const manager = {
    startInBackground: (_script: string, args: Record<string, unknown>) => {
      assert.deepEqual(args, {
        dryRun: true,
        repo: "gtnotacoder/pi-dynamic-workflows",
        issue: "#35",
        prototype: true,
        task: "#35",
      });
      return { runId: "issue-run", promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/issue-run/subagents" }),
  };
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const issueDeliveryHandler = commands.find((c) => c.name === "issue-delivery")?.handler;
  assert.ok(issueDeliveryHandler, "issue-delivery handler should exist");

  const { ctx } = makeNotifyCtx();
  await issueDeliveryHandler("--dry-run --repo gtnotacoder/pi-dynamic-workflows --issue #35", ctx);
});

test("/issue-delivery boolean flags do not consume task words and issue context survives task text", async () => {
  const seen: Record<string, unknown>[] = [];
  const manager = {
    startInBackground: (_script: string, args: Record<string, unknown>) => {
      seen.push(args);
      return { runId: `issue-run-${seen.length}`, promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/issue-run/subagents" }),
  };
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const issueDeliveryHandler = commands.find((c) => c.name === "issue-delivery")?.handler;
  assert.ok(issueDeliveryHandler, "issue-delivery handler should exist");

  const { ctx } = makeNotifyCtx();
  await issueDeliveryHandler("--dry-run fix parser", ctx);
  await issueDeliveryHandler("--issue #35 fix parser", ctx);
  await issueDeliveryHandler("--finish issue #46", ctx);

  assert.deepEqual(seen[0], { dryRun: true, prototype: true, task: "fix parser" });
  assert.deepEqual(seen[1], { issue: "#35", task: "fix parser" });
  assert.deepEqual(seen[2], { finish: true, task: "issue #46" });
});

test("/adversarial-review uses WorkflowManager background path with read-only tools when provided", async () => {
  let started = false;
  const manager = {
    startInBackground: (_script: string, args: unknown, exec: { contextMode?: string; tools?: unknown }) => {
      started = true;
      assert.deepEqual(args, {
        task: "check this",
        reviewers: 2,
        threshold: 0.5,
        evidence: false,
        evidenceComponents: [],
      });
      assert.equal(exec.contextMode, undefined);
      const names = toolNames(exec.tools);
      assert.ok(names.length > 0, "adversarial review should receive explicit read-only tools");
      assert.equal(names.includes("edit"), false, "adversarial review must not expose edit");
      assert.equal(names.includes("write"), false, "adversarial review must not expose write");
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
      const names = toolNames(exec.tools);
      assert.equal(names.includes("edit"), false, "evidence review must not expose edit");
      assert.equal(names.includes("write"), false, "evidence review must not expose write");
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

test("/issue-delivery strips harness flags (--mode, --harness-type, --harness-config) from task", async () => {
  const seen: Record<string, unknown>[] = [];
  const manager = {
    startInBackground: (_script: string, args: Record<string, unknown>, _exec: { contextMode?: string }) => {
      seen.push(args);
      return { runId: "issue-run", promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/issue-run/subagents" }),
  };
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const issueDeliveryHandler = commands.find((c) => c.name === "issue-delivery")?.handler;
  assert.ok(issueDeliveryHandler, "issue-delivery handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await issueDeliveryHandler("--mode isolated --harness-type pi --harness-config auto fix the parser", ctx);

  assert.equal(
    notified.some((n) => n.type === "error"),
    false,
    "handler should not error out (which would swallow assertion failures)",
  );
  assert.equal(seen.length, 1, "startInBackground should have been called exactly once");
  assert.equal(seen[0].task, "fix the parser", "all harness flags must be stripped from task");
});

test("/issue-delivery strips --harness-config=value form from task", async () => {
  const seen: Record<string, unknown>[] = [];
  const manager = {
    startInBackground: (_script: string, args: Record<string, unknown>, _exec: { contextMode?: string }) => {
      seen.push(args);
      return { runId: "issue-run", promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/issue-run/subagents" }),
  };
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const issueDeliveryHandler = commands.find((c) => c.name === "issue-delivery")?.handler;
  assert.ok(issueDeliveryHandler, "issue-delivery handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await issueDeliveryHandler("--harness-config=auto --mode isolated fix the parser", ctx);

  assert.equal(
    notified.some((n) => n.type === "error"),
    false,
    "handler should not error out (which would swallow assertion failures)",
  );
  assert.equal(seen.length, 1, "startInBackground should have been called exactly once");
  assert.equal(seen[0].task, "fix the parser", "key=value harness flag must be stripped from task");
});

test("/issue-delivery preserves key=value positional arg without leading --", async () => {
  const seen: Record<string, unknown>[] = [];
  const manager = {
    startInBackground: (_script: string, args: Record<string, unknown>, _exec: { contextMode?: string }) => {
      seen.push(args);
      return { runId: "issue-run", promise: new Promise(() => {}) };
    },
    getRun: (_runId: string) => ({ transcriptDir: "/tmp/issue-run/subagents" }),
  };
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: manager as never });
  const issueDeliveryHandler = commands.find((c) => c.name === "issue-delivery")?.handler;
  assert.ok(issueDeliveryHandler, "issue-delivery handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await issueDeliveryHandler("--dry-run harness_config=auto fix the parser", ctx);

  assert.equal(
    notified.some((n) => n.type === "error"),
    false,
    "handler should not error out (which would swallow assertion failures)",
  );
  assert.equal(seen.length, 1, "startInBackground should have been called exactly once");
  assert.equal(
    seen[0].task,
    "harness_config=auto fix the parser",
    "positional key=value without -- must remain in task",
  );
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

  const issueDeliveryCmd = commands.find((c) => c.name === "issue-delivery");
  assert.ok(issueDeliveryCmd, "issue-delivery should be registered");
  assert.ok(
    issueDeliveryCmd.description?.includes("Autonomous Issue Delivery"),
    "should contain canonical description",
  );
  assert.equal(typeof issueDeliveryCmd.handler, "function");

  const fuguCmd = commands.find((c) => c.name === "fugu");
  assert.ok(fuguCmd, "fugu alias should be registered");
  assert.ok(fuguCmd.description?.includes("Deprecated alias"), "should describe fugu as a deprecated alias");
  assert.equal(typeof fuguCmd.handler, "function");
});
