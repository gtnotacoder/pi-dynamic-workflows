import assert from "node:assert/strict";
import test from "node:test";
import { generateAdversarialReviewWorkflow, parseAdversarialReviewArgs } from "../src/adversarial-review.js";
import { parseWorkflowScript } from "../src/workflow.js";

test("parseAdversarialReviewArgs keeps baseline mode evidence-free", () => {
  assert.deepEqual(parseAdversarialReviewArgs("check this"), {
    task: "check this",
    reviewers: 2,
    threshold: 0.5,
    evidence: false,
    evidenceComponents: [],
    unknownEvidenceComponents: [],
  });
});

test("parseAdversarialReviewArgs enables default no-key evidence components", () => {
  assert.deepEqual(parseAdversarialReviewArgs("--evidence check URLs"), {
    task: "check URLs",
    reviewers: 2,
    threshold: 0.5,
    evidence: true,
    evidenceComponents: ["web_fetch", "github"],
    unknownEvidenceComponents: [],
  });
});

test("parseAdversarialReviewArgs normalizes component aliases and numeric options", () => {
  assert.deepEqual(parseAdversarialReviewArgs("--evidence=gh,search --reviewers 4 --threshold=0.8 task"), {
    task: "task",
    reviewers: 4,
    threshold: 0.8,
    evidence: true,
    evidenceComponents: ["github", "web_fetch", "web_search"],
    unknownEvidenceComponents: [],
  });
});

test("parseAdversarialReviewArgs can explicitly disable evidence", () => {
  assert.deepEqual(parseAdversarialReviewArgs("--evidence --no-evidence task"), {
    task: "task",
    reviewers: 2,
    threshold: 0.5,
    evidence: false,
    evidenceComponents: [],
    unknownEvidenceComponents: [],
  });
});

test("parseAdversarialReviewArgs reports unsupported evidence components", () => {
  assert.deepEqual(parseAdversarialReviewArgs("--evidence=exa,web_fetch task"), {
    task: "task",
    reviewers: 2,
    threshold: 0.5,
    evidence: true,
    evidenceComponents: ["web_fetch"],
    unknownEvidenceComponents: ["exa"],
  });
});

test("generateAdversarialReviewWorkflow remains a valid static workflow script", () => {
  const parsed = parseWorkflowScript(generateAdversarialReviewWorkflow());
  assert.equal(parsed.meta.name, "adversarial_review");
  assert.deepEqual(
    parsed.meta.phases?.map((p) => p.title),
    ["Investigate", "Evidence", "Refute", "Consensus"],
  );
});
