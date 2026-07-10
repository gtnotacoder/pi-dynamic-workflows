import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerBuiltinWorkflows } from "../src/builtin-commands.js";
import {
  deliverDeepResearchResult,
  MAX_RESEARCH_QUESTION_CHARS,
  MAX_RESEARCH_SUMMARY_CHARS,
  MAX_RESEARCH_URL_CHARS,
  MAX_SUPPORTED_CLAIMS,
  renderResearchReport,
} from "../src/deep-research.js";
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

test("/deep-research rejects an overlong question before the workflow runs", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const deepResearchHandler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(deepResearchHandler, "deep-research handler should exist");

  // A question one char over the limit must be rejected before any workflow
  // is launched. The mock ctx has no modelRegistry/runWorkflow injection, so
  // reaching the workflow would throw and surface an error notification; we
  // assert the only notification is the length warning, with no error.
  const overlong = "x".repeat(MAX_RESEARCH_QUESTION_CHARS + 1);
  assert.ok(overlong.length > MAX_RESEARCH_QUESTION_CHARS, "question must exceed the limit");
  const { ctx, notified } = makeNotifyCtx();
  await deepResearchHandler(overlong, ctx);
  assert.equal(notified.length, 1, "should notify exactly once with the length warning");
  assert.equal(notified[0].type, "warning", "should be a warning, not an error");
  assert.match(notified[0].message, /too long/i, "should explain the question is too long");
  assert.match(notified[0].message, new RegExp(String(MAX_RESEARCH_QUESTION_CHARS)), "should state the limit");
  assert.doesNotMatch(notified[0].message, /failed/i, "must not reach the workflow run path");
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsSource = readFileSync(join(__dirname, "../src/builtin-commands.ts"), "utf8");

/** Extract just the `/deep-research` handler body from the source. */
function deepResearchHandlerBody(): string {
  const start = commandsSource.indexOf('pi.registerCommand("deep-research"');
  assert.ok(start > -1, "deep-research command must be registered");
  // Stop at the next command registration after deep-research.
  const next = commandsSource.indexOf("if (!alreadyRegistered(pi,", start + 1);
  assert.ok(next > start, "a following command registration must exist");
  return commandsSource.slice(start, next);
}

// ── /deep-research read-only + web handler tools ────────────────────────────
// The handler must build the run-level tool pool from createReadOnlyTools(cwd)
// + createWebTools() only — no createCodingTools, no host-defined path-fenced
// write. The security boundary is the tool pool, not the prompt text: no
// research agent can write, run shell, or edit tracked files.

test("deep-research handler uses createReadOnlyTools(cwd) + createWebTools() and no write/coding tools", () => {
  const handler = deepResearchHandlerBody();
  // No createCodingTools(cwd) in the deep-research handler body (issue-delivery
  // legitimately uses it elsewhere — scope the assertion to this handler).
  assert.doesNotMatch(
    handler,
    /createCodingTools\(cwd\)/,
    "deep-research handler must not use createCodingTools (no unrestricted write)",
  );
  // No host-defined path-fenced write tool.
  assert.doesNotMatch(
    handler,
    /createFencedWriteTool/,
    "deep-research handler must not build a path-fenced write tool",
  );
  // No stamp/artifact-path helpers.
  assert.doesNotMatch(
    handler,
    /sanitizeResearchStamp|evidenceArtifactPath|reportArtifactPath|RESEARCH_ARTIFACT_DIR/,
    "deep-research handler must not thread model-controlled artifact paths",
  );
  // The run-level tool pool is read-only repo tools + web tools only.
  assert.match(
    handler,
    /createReadOnlyTools\(cwd\), \.\.\.createWebTools\(\)/,
    "deep-research run-level tools must be createReadOnlyTools(cwd) + createWebTools()",
  );
  assert.ok(
    handler.includes("createWebTools()"),
    "deep-research run-level tools should include createWebTools() for Gather",
  );
  // Delivery uses the host renderer + injectable writer, threading the
  // already-validated handler question in (the workflow result no longer
  // carries it).
  assert.match(
    handler,
    /deliverDeepResearchResult\(question, result, defaultResearchReportWriter\)/,
    "delivery must call deliverDeepResearchResult with the validated question and the default writer",
  );
  // The handler must reject overlong questions before the workflow runs.
  assert.match(
    handler,
    /MAX_RESEARCH_QUESTION_CHARS/,
    "handler must gate the question against MAX_RESEARCH_QUESTION_CHARS",
  );
});

// ── /deep-research delivery (host-rendered report from bounded claims) ──────
// These exercise the safety contract without running the engine: the host
// renders cited Markdown from the bounded supported claims via an injectable
// writer, clamps an overlong summary to the UTF-8-safe limit, rejects invalid/uncited/missing
// claims, surfaces writer failure, and never reports success when there are
// no cited claims or the writer fails. No model-controlled path.

/** An injectable writer that records the report it received and returns a path. */
function recordingWriter(): { writer: (report: string) => string; report: string } {
  let report = "";
  return {
    writer: (r: string) => {
      report = r;
      return "/tmp/pi-deep-research-test/report.md";
    },
    get report() {
      return report;
    },
  };
}

const acceptCitation = async (_url: string): Promise<boolean> => true;

test("deliverDeepResearchResult: valid supported claims → ack with path + counts + clamped summary, no report body in message", async () => {
  const rec = recordingWriter();
  const result = {
    ok: true,
    question: "Is X fast?",
    supported: [
      { claim: "X is fast per primary docs.", sources: ["https://a.example", "https://b.example"] },
      { claim: "X supports Y.", sources: ["https://a.example"] },
    ],
    summary: "X is fast and supports Y.",
  };
  const outcome = await deliverDeepResearchResult("Is X fast?", { runId: "r", result }, rec.writer, acceptCitation);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.count, 2);
  // Two distinct cited source URLs across the claims.
  assert.equal(outcome.sources, 2);
  assert.equal(outcome.summary, "X is fast per primary docs.");
  assert.match(outcome.message, /2 cited claims across 2 sources/);
  assert.match(outcome.message, /\/tmp\/pi-deep-research-test\/report\.md/);
  // The rendered report is cited Markdown with the question and the claims.
  assert.match(rec.report, /# Deep Research Report/);
  assert.match(rec.report, /\*\*Question:\*\* Is X fast\?/);
  assert.match(rec.report, /## Supported claims/);
  assert.match(rec.report, /- X is fast per primary docs\./);
  // No full report body in the delivered message.
  assert.doesNotMatch(
    outcome.message,
    /# Deep Research Report/,
    "the full report must not be in the delivered message",
  );
});

test("deliverDeepResearchResult: ok=false / missing supported → rejected, no success", async () => {
  const rec = recordingWriter();
  const outcome = await deliverDeepResearchResult(
    "q",
    { runId: "r", result: { ok: false, supported: [], summary: "" } },
    rec.writer,
    acceptCitation,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.warning, /did not return a valid result/);
});

test("deliverDeepResearchResult: no cited claims → rejected, no success", async () => {
  const rec = recordingWriter();
  const outcome = await deliverDeepResearchResult(
    "q",
    { runId: "r", result: { ok: true, supported: [], summary: "s" } },
    rec.writer,
    acceptCitation,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.warning, /no cited claims/);
});

test("deliverDeepResearchResult: uncited/missing claims are rejected by the host renderer", async () => {
  // A claim with no sources is uncited and must be dropped; if ALL claims are
  // uncited/missing, delivery must not report success.
  const rec = recordingWriter();
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [
          { claim: "uncited claim", sources: [] },
          { claim: "", sources: ["https://a.example"] },
          { claim: "ok", sources: ["https://b.example"] },
        ],
        summary: "s",
      },
    },
    rec.writer,
    acceptCitation,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // Only the one valid cited claim survives.
  assert.equal(outcome.count, 1);
  assert.equal(outcome.sources, 1);
  // The uncited and empty claims are NOT in the rendered report.
  assert.doesNotMatch(rec.report, /uncited claim/);
  assert.match(rec.report, /- ok/);
});

test("deliverDeepResearchResult: invalid citation schemes/text cannot produce success", async () => {
  const rec = recordingWriter();
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [
          { claim: "not actually cited", sources: ["not a URL", "file:///etc/passwd", "javascript:alert(1)"] },
        ],
        summary: "s",
      },
    },
    rec.writer,
    acceptCitation,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.warning, /no cited claims/);
  assert.equal(rec.report, "", "invalid citations must not reach the writer");
});

test("deliverDeepResearchResult: mixed citations retain only bounded HTTP(S) URLs", async () => {
  const rec = recordingWriter();
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [
          { claim: "valid claim", sources: ["not a URL", "https://docs.example/path", "file:///tmp/x"] },
          { claim: "dropped uncited claim", sources: ["not a URL"] },
        ],
        summary: "dropped uncited claim",
      },
    },
    rec.writer,
    acceptCitation,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.count, 1);
  assert.equal(outcome.sources, 1);
  assert.match(rec.report, /https:\/\/docs\.example\/path/);
  assert.doesNotMatch(rec.report, /not a URL|file:\/\/|dropped uncited claim/);
  assert.equal(outcome.summary, "valid claim", "summary must derive from retained cited evidence");
  assert.doesNotMatch(outcome.message, /dropped uncited claim/);
});

test("deliverDeepResearchResult: all claims uncited → rejected, no success", async () => {
  const rec = recordingWriter();
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [{ claim: "uncited", sources: [] }],
        summary: "s",
      },
    },
    rec.writer,
    acceptCitation,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.warning, /no cited claims/);
});

test("deliverDeepResearchResult: writer failure → rejected, no success", async () => {
  const failingWriter = () => {
    throw new Error("disk full");
  };
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [{ claim: "c1", sources: ["https://a.example"] }],
        summary: "s",
      },
    },
    failingWriter,
    acceptCitation,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.warning, /report writer failed/);
  assert.match(outcome.warning, /disk full/);
});

test("deliverDeepResearchResult: writer returns empty path → rejected, no success", async () => {
  const emptyWriter = () => "";
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [{ claim: "c1", sources: ["https://a.example"] }],
        summary: "s",
      },
    },
    emptyWriter,
    acceptCitation,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.warning, /returned no path/);
});

test("deliverDeepResearchResult: acknowledgement summary derives from retained cited evidence", async () => {
  const rec = recordingWriter();
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [{ claim: "x".repeat(250), sources: ["https://a.example"] }],
        summary: "model summary that is not independently citation-bound",
      },
    },
    rec.writer,
    acceptCitation,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.summary.length, MAX_RESEARCH_SUMMARY_CHARS);
  assert.equal(outcome.summary, "x".repeat(MAX_RESEARCH_SUMMARY_CHARS));
  assert.doesNotMatch(outcome.message, /model summary/);
});

test("deliverDeepResearchResult: host re-fetch drops unavailable citations", async () => {
  const rec = recordingWriter();
  const checked: string[] = [];
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [
          { claim: "unverified", sources: ["https://unavailable.example/source"] },
          { claim: "verified", sources: ["https://verified.example/source"] },
        ],
        summary: "unverified",
      },
    },
    rec.writer,
    async (url) => {
      checked.push(url);
      return url.includes("verified.example");
    },
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(checked, ["https://unavailable.example/source", "https://verified.example/source"]);
  assert.equal(outcome.count, 1);
  assert.equal(outcome.summary, "verified");
  assert.doesNotMatch(rec.report, /unverified/);
});

test("deliverDeepResearchResult: overlong URLs are rejected, never truncated", async () => {
  const rec = recordingWriter();
  const longUrl = `https://example.com/${"x".repeat(MAX_RESEARCH_URL_CHARS)}`;
  const checked: string[] = [];
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [
          { claim: "broken if truncated", sources: [longUrl] },
          { claim: "valid", sources: ["https://valid.example/source"] },
        ],
        summary: "valid",
      },
    },
    rec.writer,
    async (url) => {
      checked.push(url);
      return true;
    },
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(checked, ["https://valid.example/source"]);
  assert.doesNotMatch(rec.report, /broken if truncated/);
  assert.match(rec.report, /https:\/\/valid\.example\/source/);
});

test("deliverDeepResearchResult: invalid early entries cannot starve later cited evidence", async () => {
  const rec = recordingWriter();
  const outcome = await deliverDeepResearchResult(
    "q",
    {
      runId: "r",
      result: {
        ok: true,
        supported: [
          { claim: "invalid 1", sources: [] },
          { claim: "invalid 2", sources: ["not a URL"] },
          { claim: "invalid 3", sources: ["file:///tmp/no"] },
          { claim: "later valid", sources: ["https://valid.example/source"] },
        ],
        summary: "later valid",
      },
    },
    rec.writer,
    acceptCitation,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.count, 1);
  assert.equal(outcome.summary, "later valid");
  assert.match(rec.report, /later valid/);
});

test("deliverDeepResearchResult: supported array is re-clamped to the UTF-8-safe limit", async () => {
  const rec = recordingWriter();
  const many = Array.from({ length: 12 }, (_, i) => ({
    claim: `claim ${i}`,
    sources: ["https://a.example"],
  }));
  const outcome = await deliverDeepResearchResult(
    "q",
    { runId: "r", result: { ok: true, supported: many, summary: "s" } },
    rec.writer,
    acceptCitation,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.count, MAX_SUPPORTED_CLAIMS);
});

test("renderResearchReport: cited Markdown is deterministic and rejects uncited content", () => {
  const md = renderResearchReport("q", [
    { claim: "c1", sources: ["https://a.example", "https://b.example"] },
    { claim: "", sources: ["https://c.example"] },
    { claim: "uncited", sources: [] },
  ]);
  assert.match(md, /# Deep Research Report/);
  assert.match(md, /\*\*Question:\*\* q/);
  assert.match(md, /## Supported claims/);
  // Only c1 (with both URLs) survives.
  assert.match(md, /- c1/);
  assert.match(md, / {2}- https:\/\/a\.example/);
  assert.match(md, / {2}- https:\/\/b\.example/);
  assert.doesNotMatch(md, /uncited/, "uncited claims must be rejected");
  assert.doesNotMatch(md, /https:\/\/c\.example/, "claims missing content must be rejected");
});

test("renderResearchReport: multiline Markdown cannot create uncited bullets", () => {
  const md = renderResearchReport("Question\n# injected heading", [
    {
      claim: "Supported fact\n- Unsupported extra\n  - https://uncited.example/*bold*",
      sources: ["https://cited.example"],
    },
  ]);

  assert.equal(md.split("\n").filter((line) => line.startsWith("- ")).length, 1, "one claim renders one bullet");
  assert.doesNotMatch(md, /\n- Unsupported extra|\n {2}- https:\/\/uncited\.example/);
  assert.match(md, /Supported fact \\- Unsupported extra/);
  assert.match(md, /https:\/\/cited\.example/);
  assert.doesNotMatch(md, /\n# injected heading/);
});
