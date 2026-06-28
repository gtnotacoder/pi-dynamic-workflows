import assert from "node:assert/strict";
import test from "node:test";
import {
  compactFeedback,
  FeedbackCompactionError,
  renderCorrectionDelta,
  validateCorrectionDelta,
} from "../src/context-compaction.js";

test("compactFeedback emits a bounded, schema-valid CorrectionDelta", () => {
  const delta = compactFeedback({
    maxTokens: 128,
    rounds: [
      {
        index: 1,
        verdict: "fail",
        findings: [
          {
            rule: "tsc:assignability",
            location: { path: "src/foo.ts", startLine: 12 },
            message: "Type 'string' is not assignable to type 'number'",
            severity: "error",
          },
        ],
      },
    ],
  });

  assert.equal(delta.attempt, 2);
  assert.equal(delta.lastVerdict, "fail");
  assert.equal(delta.openRootCauses.length, 1);
  assert.equal(delta.openRootCauses[0].rule, "tsc:assignability");
  assert.equal(validateCorrectionDelta(delta).ok, true);
  assert.ok(renderCorrectionDelta(delta).length <= 128 * 4);
});

test("compactFeedback deduplicates root causes and prefers current failures", () => {
  const delta = compactFeedback({
    rounds: [
      {
        index: 1,
        verdict: "fail",
        findings: [
          { id: "same", rule: "biome", message: "unused import", severity: "warning", status: "open" },
          { id: "old", rule: "test", message: "old expectation failed", severity: "error", status: "open" },
        ],
      },
      {
        index: 2,
        verdict: "fail",
        findings: [
          { id: "same", rule: "biome", message: "unused import", severity: "warning", status: "open" },
          { id: "old", rule: "test", message: "old expectation failed", severity: "error", status: "resolved" },
          { id: "new", rule: "tsc", message: "new blocker", severity: "error", status: "open" },
        ],
      },
    ],
  });

  assert.deepEqual(
    delta.openRootCauses.map((cause) => cause.findingId),
    ["new", "same"],
  );
  assert.match(delta.resolvedSummary ?? "", /1 prior finding/);
  assert.ok(delta.constraints.some((constraint) => constraint.includes("old")));
});

test("compactFeedback redacts secret-looking values before validation", () => {
  const delta = compactFeedback({
    rounds: [
      {
        verdict: "blocked",
        feedback: "token=ghp_abcdefghijklmnopqrstuvwxyz123456 leaked in stderr for user@example.com",
      },
    ],
  });
  const rendered = renderCorrectionDelta(delta);
  assert.doesNotMatch(rendered, /ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(rendered, /user@example\.com/);
  assert.match(rendered, /redacted/);
  assert.equal(validateCorrectionDelta(delta).ok, true);
});

test("compactFeedback rejects empty round lists", () => {
  assert.throws(() => compactFeedback({ rounds: [] }), FeedbackCompactionError);
});
