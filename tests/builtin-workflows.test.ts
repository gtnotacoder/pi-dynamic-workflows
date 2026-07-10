import assert from "node:assert/strict";
import test from "node:test";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "../src/adversarial-review.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "../src/deep-research.js";
import { generateFuguWorkflow } from "../src/fugu.js";
import { generateIssueDeliveryWorkflow } from "../src/issue-delivery.js";
import { createWebTools } from "../src/web-tools.js";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";

// ─── Issue Delivery / Fugu compatibility ──────────────────────────────────────

test("generateIssueDeliveryWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateIssueDeliveryWorkflow());
  assert.equal(meta.name, "issue_delivery");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Scout", "Thinker", "Worker", "LocalChecks", "Verifier", "Telemetry"],
  );
  assert.match(body, /Directed Acyclic Graph/);
  assert.match(body, /parallel\(/);
  assert.match(body, /issue-pr-delivery/);
  assert.match(body, /code-scout/);
  assert.match(body, /stageCheck\(/);
  assert.match(body, /compactFeedback\(/);
  assert.match(body, /stateWriteQueue/, "sidecar writes should be serialized");
  assert.match(body, /subagent was aborted/, "best-effort sidecar writes must rethrow subagent aborts");
  assert.match(body, /writeFailedRunHandoff/, "failed runs should write repair handoff artifacts");
  assert.match(body, /FINISH_ONLY/, "finish mode should skip full reruns after manual repair");
  assert.match(body, /PROTOTYPE_LANE/);
  assert.match(body, /PROTOTYPE_DRY_RUN/);
  assert.match(body, /prototypeSafetyCheck/);
  assert.match(body, /stoppedBeforeMutation/);
  assert.match(body, /WORKER_ATTEMPTS/);
  assert.doesNotMatch(body, /fugu-checks:/, "host-side stageCheck replaces the old LocalChecks LLM agent");
});

test("generateFuguWorkflow remains a compatibility alias for issue delivery", () => {
  assert.equal(generateFuguWorkflow(), generateIssueDeliveryWorkflow());
});

test("generateIssueDeliveryWorkflow prototype dry-run stops before Worker edits and PR delivery", async () => {
  const labels: string[] = [];
  const result = await runWorkflow(generateIssueDeliveryWorkflow(), {
    cwd: "/tmp/prototype-linked-worktree",
    args: { task: "prototype fix", issue: "#35", dryRun: true, maxReviewRounds: 2, maxSteps: 1 },
    persistLogs: false,
    agent: {
      async run(prompt: string, options: { label?: string; schema?: unknown; toolNames?: string[] }): Promise<unknown> {
        labels.push(options.label ?? "");
        if (options.label === "issue-scout" || options.label === "issue-thinker") {
          assert.ok(options.toolNames?.length, `${options.label} should use a read-only tool allowlist in dry-run`);
          assert.match(prompt, /Issue: #35/, `${options.label} prompt should preserve parsed issue context`);
        }
        if (options.label === "issue-thinker") {
          return {
            summary: "bounded prototype plan",
            steps: [
              {
                id: "step-2",
                file: "src/b.ts",
                instructions: "change b",
                expectedOutput: "b",
                dependencies: ["step-1"],
              },
              { id: "step-1", file: "src/a.ts", instructions: "change a", expectedOutput: "a", dependencies: [] },
            ],
          };
        }
        if (options.label?.startsWith("prototype-review:")) {
          assert.ok(options.toolNames?.length, "dry-run prototype review should use a read-only tool allowlist");
          return "plan is ready for execution";
        }
        return "code map";
      },
    },
    stageCheck: async () => ({ ok: true, checks: [], summary: "Stage checks passed (test)." }),
    prototypeSafetyCheck: async (cwd) => ({
      ok: true,
      cwd,
      gitRoot: cwd,
      primaryWorktree: "/repo/main",
      isLinkedWorktree: true,
      dirtyPaths: [],
      reason: "Running in an isolated linked worktree.",
      nextAction: "Proceed with bounded prototype execution.",
    }),
  });

  const payload = result.result as {
    prototype?: boolean;
    dryRun?: boolean;
    stoppedBeforeMutation?: boolean;
    report?: string;
    stepsPlanned?: Array<{ id: string }>;
  };
  assert.equal(payload.prototype, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.stoppedBeforeMutation, true);
  assert.match(payload.report ?? "", /stopped before Worker edits, git push, and PR creation/i);
  assert.deepEqual(
    Array.from(payload.stepsPlanned ?? [], (step) => step.id),
    ["step-1"],
  );
  assert.ok(labels.includes("issue-scout"));
  assert.ok(labels.includes("issue-thinker"));
  assert.equal(labels.filter((label) => label.startsWith("prototype-review:")).length, 2);
  assert.equal(
    labels.some((label) => label.startsWith("issue-worker:")),
    false,
    "dry-run must not run workers",
  );
  assert.equal(labels.includes("issue-pr-delivery"), false, "prototype dry-run must not run PR delivery");
});

test("generateIssueDeliveryWorkflow does not truncate normal delivery plans over 100 steps", async () => {
  const labels: string[] = [];
  const steps = Array.from({ length: 101 }, (_unused, index) => ({
    id: `step-${index + 1}`,
    file: `src/file-${index + 1}.ts`,
    instructions: `change ${index + 1}`,
    expectedOutput: `output ${index + 1}`,
    dependencies: [],
  }));

  const result = await runWorkflow(generateIssueDeliveryWorkflow(), {
    cwd: "/tmp/normal-delivery",
    args: { task: "normal issue #35" },
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { label?: string }): Promise<unknown> {
        labels.push(options.label ?? "");
        if (options.label === "issue-thinker") return { summary: "large normal plan", steps };
        if (options.label?.startsWith("issue-verifier:"))
          return { passed: true, feedback: "ok", tautologicalTestDetected: false };
        if (options.label === "issue-pr-delivery") return "https://github.com/example/repo/pull/1";
        return "ok";
      },
    },
    stageCheck: async () => ({ ok: true, checks: [], summary: "Stage checks passed (test)." }),
    finalizationCheck: async () => ({
      status: "completed",
      reason: "done",
      nextAction: "merge",
      toRunStatus: { status: "completed", reason: "done", nextAction: "merge" },
    }),
  });

  const payload = result.result as { stepsCompleted?: Array<{ id: string }>; finalization?: { status?: string } };
  assert.equal(payload.stepsCompleted?.length, 101);
  assert.equal(labels.filter((label) => label.startsWith("issue-worker:")).length, 101);
  assert.equal(labels.includes("issue-pr-delivery"), true);
});

test("generateIssueDeliveryWorkflow finish mode skips full rerun and delivers repaired work", async () => {
  const labels: string[] = [];
  const result = await runWorkflow(generateIssueDeliveryWorkflow(), {
    cwd: "/tmp/repaired-worktree",
    args: { task: "finish issue #46", finish: true },
    persistLogs: false,
    agent: {
      async run(prompt: string, options: { label?: string }): Promise<unknown> {
        labels.push(options.label ?? "");
        assert.match(prompt, /Do NOT rerun Scout, Thinker, Worker, or Verifier/);
        return "https://github.com/example/repo/pull/46";
      },
    },
    stageCheck: async () => ({ ok: true, checks: [], summary: "Stage checks passed (test)." }),
    finalizationCheck: async () => ({
      status: "completed",
      reason: "done",
      nextAction: "merge",
      toRunStatus: { status: "completed", reason: "done", nextAction: "merge" },
    }),
  });

  const payload = result.result as { finish?: boolean; pr?: string; success?: boolean };
  assert.equal(payload.finish, true);
  assert.equal(payload.success, true);
  assert.match(payload.pr ?? "", /pull\/46/);
  assert.deepEqual(labels, ["issue-finish-delivery"]);
});

test("generateIssueDeliveryWorkflow writes one aggregate handoff before failing unrepaired runs", async () => {
  const labels: string[] = [];
  const prompts: string[] = [];

  await assert.rejects(
    runWorkflow(generateIssueDeliveryWorkflow(), {
      cwd: "/tmp/failed-before-pr",
      args: { task: "issue #46 failing checks" },
      persistLogs: false,
      agent: {
        async run(prompt: string, options: { label?: string }): Promise<unknown> {
          labels.push(options.label ?? "");
          prompts.push(prompt);
          if (options.label === "issue-thinker") {
            return {
              summary: "two independent steps",
              steps: [
                { id: "step-1", file: "src/a.ts", instructions: "change a", expectedOutput: "a" },
                { id: "step-2", file: "src/b.ts", instructions: "change b", expectedOutput: "b" },
              ],
            };
          }
          return "ok";
        },
      },
      stageCheck: async () => ({ ok: false, checks: [], summary: "tsc failed" }),
    }),
    /handoff\.md/,
  );

  assert.equal(labels.filter((label) => label === "issue-handoff").length, 1, "handoff writer should run once");
  assert.ok(
    prompts.some(
      (prompt) =>
        prompt.includes("# Issue Delivery failed-run handoff") &&
        prompt.includes("step-1") &&
        prompt.includes("step-2") &&
        prompt.includes("tsc failed"),
    ),
    "handoff prompt should aggregate all failed steps and final local-check findings",
  );
});

test("generateIssueDeliveryWorkflow surfaces a failed handoff writer", async () => {
  await assert.rejects(
    runWorkflow(generateIssueDeliveryWorkflow(), {
      cwd: "/tmp/failed-handoff-writer",
      args: { task: "issue #46 failing handoff writer" },
      persistLogs: false,
      agent: {
        async run(_prompt: string, options: { label?: string }): Promise<unknown> {
          if (options.label === "issue-thinker") {
            return {
              summary: "one step",
              steps: [{ id: "step-1", file: "src/a.ts", instructions: "change a", expectedOutput: "a" }],
            };
          }
          if (options.label === "issue-handoff") return null;
          return "ok";
        },
      },
      stageCheck: async () => ({ ok: false, checks: [], summary: "tsc failed" }),
    }),
    /Handoff file write failed/,
  );
});

test("generateIssueDeliveryWorkflow prototype mode refuses unsafe shared checkout before agents run", async () => {
  const labels: string[] = [];
  const result = await runWorkflow(generateIssueDeliveryWorkflow(), {
    cwd: "/repo/main",
    args: { task: "prototype issue #35", prototype: true },
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { label?: string }): Promise<unknown> {
        labels.push(options.label ?? "");
        return "should not run";
      },
    },
    prototypeSafetyCheck: async (cwd) => ({
      ok: false,
      cwd,
      gitRoot: cwd,
      primaryWorktree: cwd,
      isLinkedWorktree: false,
      dirtyPaths: [],
      reason:
        "Prototype mode requires an isolated linked git worktree; this appears to be the primary/shared checkout.",
      nextAction: "Create a linked worktree and rerun.",
    }),
  });

  const payload = result.result as { success?: boolean; stoppedBy?: string; report?: string };
  assert.equal(payload.success, false);
  assert.equal(payload.stoppedBy, "prototype-safety");
  assert.match(payload.report ?? "", /requires an isolated linked git worktree/);
  assert.deepEqual(labels, [], "safety refusal must happen before scout/worker agents");
});

test("generateIssueDeliveryWorkflow rejects broad git staging and enforces scoped delivery safety", () => {
  const { body } = parseWorkflowScript(generateIssueDeliveryWorkflow());

  // Regression: the generated workflow must NOT prompt agents to stage
  // everything with broad commands like `git add -A` or `git add .`.
  assert.doesNotMatch(body, /git\s+add\s+-A/, "body must not contain 'git add -A'");
  assert.doesNotMatch(body, /git\s+add\s+\./, "body must not contain 'git add .'");

  // Scoped-delivery safety: the PR delivery prompt must instruct agents
  // to commit only the files explicitly listed in the Modified Files list.
  assert.match(
    body,
    /only\s+stage\s+and\s+commit\s+the\s+files\s+explicitly\s+listed/i,
    "body must instruct agents to stage and commit only explicitly listed files",
  );

  // Finalization: use the deterministic finalization helper and semantic
  // status lifecycle instead of a freeform finalization agent.
  assert.match(body, /setSemanticStatus/, "body must use setSemanticStatus");
  assert.match(body, /workflow-running/, "body must include workflow-running status");
  assert.match(body, /workflow-complete-pane-open/, "body must include workflow-complete-pane-open status");
  assert.match(body, /finalizing/, "body must include finalizing status");
  assert.match(body, /checkFinalization\(cwd,/, "body must call checkFinalization(cwd,");
  assert.doesNotMatch(body, /fugu-finalization/, "body must not reference fugu-finalization");
  assert.doesNotMatch(
    body,
    /You are the Fugu Finalization Agent/,
    "body must not contain Fugu Finalization Agent text",
  );
});

// ─── Issue Delivery Thinker & Verifier semantic checks ────────────────────────

test("generateIssueDeliveryWorkflow: Thinker prompt includes expand-contract planning exception", () => {
  const { meta, body } = parseWorkflowScript(generateIssueDeliveryWorkflow());
  assert.equal(meta.name, "issue_delivery");
  assert.match(body, /Planning exception — Expand-contract/i);
  assert.match(body, /EXPAND the new API\/form beside the old/);
  assert.match(body, /MIGRATE callers in independently green bounded batches/);
  assert.match(body, /CONTRACT\/delete the old form/);
  assert.match(body, /Ordinary feature\/bug work stays thin vertical steps/i);
  assert.match(body, /dependency ordering must keep CI green/i);
});

test("generateIssueDeliveryWorkflow: Verifier prompt includes tautological-test detection", () => {
  const { body } = parseWorkflowScript(generateIssueDeliveryWorkflow());
  assert.match(body, /Tautological-test detection/i);
  assert.match(body, /independent literal.*worked example.*task\/spec oracle/i);
  assert.match(body, /not recomputation by implementation logic/i);
  assert.match(body, /expect\(add\(a,b\)\)\.toBe\(a\+b\)/);
});

test("generateIssueDeliveryWorkflow: tautological-test verdict is fail-closed", () => {
  const { body } = parseWorkflowScript(generateIssueDeliveryWorkflow());
  assert.match(body, /tautologicalTestDetected=true and MUST return passed=false/);
  assert.match(body, /tautologicalTestDetected=false whenever no tautological oracle is detected/);
  assert.doesNotMatch(body, /false only when no such oracle exists/);
  assert.match(body, /verification\.passed && verification\.tautologicalTestDetected === false/);
});

test("generateIssueDeliveryWorkflow: a detected tautological oracle cannot enter the success path", async () => {
  const labels: string[] = [];
  await assert.rejects(
    runWorkflow(generateIssueDeliveryWorkflow(), {
      cwd: "/tmp/tautological-verifier",
      args: { task: "add with a regression test" },
      persistLogs: false,
      agent: {
        async run(_prompt: string, options: { label?: string }): Promise<unknown> {
          labels.push(options.label ?? "");
          if (options.label === "issue-thinker") {
            return {
              summary: "one step",
              steps: [{ id: "step-1", file: "src/add.ts", instructions: "add behavior", expectedOutput: "tested add" }],
            };
          }
          if (options.label?.startsWith("issue-verifier:")) {
            return { passed: true, feedback: "expected repeats implementation", tautologicalTestDetected: true };
          }
          return "ok";
        },
      },
      stageCheck: async () => ({ ok: true, checks: [], summary: "Stage checks passed (test)." }),
    }),
    /handoff\.md/,
  );

  assert.equal(labels.filter((label) => label.startsWith("issue-verifier:")).length, 3);
  assert.equal(labels.includes("issue-pr-delivery"), false);
});

// ─── Deep Research ──────────────────────────────────────────────────────────────

test("generateDeepResearchWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateDeepResearchWorkflow());
  assert.equal(meta.name, "deep_research");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Queries", "Gather", "Verify", "Report"],
  );
  assert.match(body, /args && args\.question/);
  assert.match(body, /web_search/);
  assert.match(body, /web_fetch/);
});

test("generateDeepResearchWorkflow uses configurable angles and minSupport", () => {
  const body = generateDeepResearchWorkflow();
  assert.match(body, /args\.angles/);
  assert.match(body, /args\.minSupport/);
});

// ─── Adversarial Review ─────────────────────────────────────────────────────────

test("generateAdversarialReviewWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateAdversarialReviewWorkflow());
  assert.equal(meta.name, "adversarial_review");
  assert.match(body, /args && args\.task/);
  assert.match(body, /threshold/);
  assert.match(body, /survives/);
});

test("generateAdversarialReviewWorkflow phases include optional Evidence before Refute", () => {
  const { meta } = parseWorkflowScript(generateAdversarialReviewWorkflow());
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Investigate", "Evidence", "Refute", "Consensus"],
  );
});

// ─── Codebase Audit ─────────────────────────────────────────────────────────────

test("generateCodebaseAuditWorkflow produces a valid, parseable script", () => {
  const { meta } = parseWorkflowScript(
    generateCodebaseAuditWorkflow("src/", ["check types", "find bugs", "review style"]),
  );
  assert.equal(meta.name, "codebase_audit");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Individual Checks", "Cross-Validation", "Report"],
  );
});

test("generateCodebaseAuditWorkflow creates an agent per check item", () => {
  const body = generateCodebaseAuditWorkflow("src/", ["check-a", "check-b", "check-c"]);
  assert.match(body, /check-a/);
  assert.match(body, /check-b/);
  assert.match(body, /check-c/);
});

test("generateCodebaseAuditWorkflow uses parallel for checks", () => {
  const body = generateCodebaseAuditWorkflow("src/", ["lint"]);
  assert.match(body, /parallel\(/);
});

test("generateCodebaseAuditWorkflow includes validator and report phases", () => {
  const body = generateCodebaseAuditWorkflow("src/", ["test"]);
  assert.match(body, /validator/);
  assert.match(body, /report-writer/);
});

test("generateCodebaseAuditWorkflow escapes single quotes in scope", () => {
  const body = generateCodebaseAuditWorkflow("it's a test", ["check"]);
  // Should not contain unescaped quotes that would break the script
  assert.ok(!body.includes("it's") || body.includes("it\\'s"), "should not contain it's");
});

test("generateCodebaseAuditWorkflow truncates long scope names", () => {
  const long = "x".repeat(100);
  const body = generateCodebaseAuditWorkflow(long, ["check"]);
  // The scope in the script is .slice(0, 60), so the full 100-char string should not appear
  const fullString = "x".repeat(100);
  assert.ok(!body.includes(fullString), "should not contain the full 100-char string verbatim");
  // But the truncated 60-char version should appear
  assert.ok(body.includes("x".repeat(60)), "should contain the truncated 60-char version");
});

// ─── Multi-Perspective ──────────────────────────────────────────────────────────

test("generateMultiPerspectiveWorkflow produces a valid, parseable script", () => {
  const { meta } = parseWorkflowScript(
    generateMultiPerspectiveWorkflow("climate change", ["economic", "environmental", "social"]),
  );
  assert.equal(meta.name, "multi_perspective_analysis");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Perspective Analysis", "Synthesis"],
  );
});

test("generateMultiPerspectiveWorkflow creates one agent per perspective", () => {
  const perspectives = ["technical", "business", "user"];
  const body = generateMultiPerspectiveWorkflow("new API", perspectives);
  assert.match(body, /technical/);
  assert.match(body, /business/);
  assert.match(body, /user/);
});

test("generateMultiPerspectiveWorkflow uses parallel for perspective analysis", () => {
  const body = generateMultiPerspectiveWorkflow("topic", ["p1", "p2"]);
  assert.match(body, /parallel\(/);
});

test("generateMultiPerspectiveWorkflow includes synthesis phase", () => {
  const body = generateMultiPerspectiveWorkflow("topic", ["p1"]);
  assert.match(body, /synthesizer/);
});

test("generateMultiPerspectiveWorkflow returns analyses and synthesis", () => {
  const body = generateMultiPerspectiveWorkflow("topic", ["p1"]);
  assert.match(body, /analyses/);
  assert.match(body, /synthesis/);
});

// ─── Web Tools ──────────────────────────────────────────────────────────────────

test("createWebTools exposes web_search and web_fetch", () => {
  const tools = createWebTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["web_fetch", "web_search"]);
});
