import assert from "node:assert/strict";
import test from "node:test";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "../src/adversarial-review.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "../src/deep-research.js";
import { generateFuguWorkflow } from "../src/fugu.js";
import { generateIssueDeliveryWorkflow } from "../src/issue-delivery.js";
import { createWebTools } from "../src/web-tools.js";
import { parseWorkflowScript } from "../src/workflow.js";

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
  assert.match(body, /fastcontext-scout/);
  assert.match(body, /stageCheck\(/);
  assert.match(body, /compactFeedback\(/);
  assert.match(body, /PROTOTYPE_LANE/);
  assert.match(body, /WORKER_ATTEMPTS/);
  assert.doesNotMatch(body, /fugu-checks:/, "host-side stageCheck replaces the old LocalChecks LLM agent");
});

test("generateFuguWorkflow remains a compatibility alias for issue delivery", () => {
  assert.equal(generateFuguWorkflow(), generateIssueDeliveryWorkflow());
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
