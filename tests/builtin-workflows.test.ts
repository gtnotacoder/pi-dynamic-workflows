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
  // Parse the script to confirm it is valid JS before checking content
  assert.equal(meta.name, "issue_delivery", "meta.name must be issue_delivery");
  // The Thinker prompt must contain the expand-contract planning exception
  assert.match(
    body,
    /Planning exception — Expand-contract/i,
    "Thinker prompt must have 'Planning exception — Expand-contract'",
  );
  // It must define the three phases: EXPAND, MIGRATE, CONTRACT
  assert.match(body, /EXPAND the new API\/form beside the old/, "must define EXPAND phase");
  assert.match(body, /MIGRATE callers in independently green bounded batches/, "must define MIGRATE phase");
  assert.match(body, /CONTRACT\/delete the old form/, "must define CONTRACT phase");
  // Must distinguish from ordinary work
  assert.match(body, /Ordinary feature\/bug work stays thin vertical steps/i, "must state ordinary work stays thin");
  // Must require dependency ordering for CI green
  assert.match(body, /dependency ordering must keep CI green/i, "must require CI green dependency ordering");
});

test("generateIssueDeliveryWorkflow: Verifier prompt includes tautological-test detection", () => {
  const { meta, body } = parseWorkflowScript(generateIssueDeliveryWorkflow());
  assert.equal(meta.name, "issue_delivery", "meta.name must be issue_delivery");
  // Verifier prompt must include tautological-test detection
  assert.match(body, /Tautological-test detection/i, "Verifier prompt must mention tautological-test detection");
  // Must require independent oracle, not recomputation
  assert.match(
    body,
    /independent literal.*worked example.*task\/spec oracle/i,
    "must require independent source of truth",
  );
  assert.match(
    body,
    /not recomputation by implementation logic/i,
    "must warn against recomputation by implementation logic",
  );
  // Must include a concrete example of tautological test
  assert.match(body, /expect\(add\(a,b\)\)\.toBe\(a\+b\)\)/, "must include add(a,b) tautology example");
});

test("generateIssueDeliveryWorkflow: tautological-test verdict is fail-closed", () => {
  const { body } = parseWorkflowScript(generateIssueDeliveryWorkflow());
  assert.match(body, /tautologicalTestDetected=true and MUST return passed=false/);
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
            return { passed: true, feedback: "expected value repeats implementation", tautologicalTestDetected: true };
          }
          return "ok";
        },
      },
      stageCheck: async () => ({ ok: true, checks: [], summary: "Stage checks passed (test)." }),
    }),
    /handoff\.md/,
  );

  assert.equal(labels.filter((label) => label.startsWith("issue-verifier:")).length, 3);
  assert.equal(labels.includes("issue-pr-delivery"), false, "blocking tautology must prevent PR delivery");
});

// ─── Deep Research ─────────────────────────────────────────────────────────

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
  // Read-only + web-only: no model-controlled workspace artifact paths.
  assert.doesNotMatch(body, /\.pi\/workflows\/research/, "must not write under .pi/workflows/research");
  assert.doesNotMatch(body, /evidencePath|reportPath/, "must not thread model-controlled artifact paths");
});

test("generateDeepResearchWorkflow uses configurable angles and minSupport", () => {
  const body = generateDeepResearchWorkflow();
  assert.match(body, /args\.angles/);
  assert.match(body, /args\.minSupport/);
});

test("generateDeepResearchWorkflow: Gather and Verify prompts require primary sources", () => {
  const body = generateDeepResearchWorkflow();
  // Gather prompt: primary source first
  assert.match(body, /primary source/i, "Gather prompt should mention primary source");
  // Verify prompt: discard secondary-only claims
  assert.match(body, /owning.*source/i, "Verify prompt should require owning source URL");
});

test("generateDeepResearchWorkflow: every agent is read-only+web only — no write/bash/edit", () => {
  const body = generateDeepResearchWorkflow();
  // Queries: empty tool fence (no tools).
  assert.match(body, /label: 'plan queries',[\s\S]*?tools: \[\]/, "Queries agent must be fenced with tools: []");
  // Gather: web_search + web_fetch only.
  assert.match(
    body,
    /label: 'research ' \+ \(i \+ 1\),[\s\S]*?tools: \['web_search', 'web_fetch'\]/,
    "Gather agent must be fenced to web_search + web_fetch only",
  );
  // Verify: fenced ([]), never write.
  assert.match(body, /label: 'cross-check',[\s\S]*?tools: \[\]/, "Verify agent must be fenced with tools: []");
  // Report: fenced ([]), never write.
  assert.match(body, /label: 'write report',[\s\S]*?tools: \[\]/, "Report agent must be fenced with tools: []");
  // No agent gets write, bash, or edit.
  assert.doesNotMatch(body, /tools: \[[^\]]*'write'/, "no agent may select write");
  assert.doesNotMatch(body, /tools: \[[^\]]*'bash'/, "no agent may select bash");
  assert.doesNotMatch(body, /tools: \[[^\]]*'edit'/, "no agent may select edit");
});

test("generateDeepResearchWorkflow: Gather result is bounded (max 2 sources, max 2 claims, URL ≤200, claim ≤140)", () => {
  const body = generateDeepResearchWorkflow();
  // Gather schema bounds sources to maxItems 2, each url maxLength 200.
  assert.match(body, /sources: \{[\s\S]*?maxItems: 2[\s\S]*?\}/, "Gather sources must be bounded to maxItems 2");
  assert.match(body, /url: \{ type: 'string', maxLength: 200 \}/, "Gather url must have maxLength 200");
  // Claims bounded to maxItems 2, each maxLength 140.
  assert.match(
    body,
    new RegExp(
      `claims: \\{ type: 'array', maxItems: ${MAX_CLAIMS_PER_SOURCE}, items: \\{ type: 'string', maxLength: ${MAX_RESEARCH_CLAIM_CHARS} \\} \\}`,
    ),
    "Gather claims must be bounded to maxItems 2 / maxLength 140",
  );
  // Prompt must cap fetched URLs at 2.
  assert.match(body, /at most the 2 most relevant result URLs/, "Gather prompt must cap fetched URLs at 2");
  assert.match(body, /do NOT fetch more than 2 URLs/, "Gather prompt must explicitly forbid > 2 fetches");
});

test("generateDeepResearchWorkflow: Verify returns bounded supported claims through its structured result", () => {
  const body = generateDeepResearchWorkflow();
  // Verify returns supported claims (not a file artifact) with schema bounds.
  // Use includes() for the schema-snippet checks so the assertion does not
  // depend on regex backslash escaping (which a formatter can normalize).
  assert.ok(
    body.includes(`supported: {`) && body.includes(`maxItems: ${MAX_SUPPORTED_CLAIMS}`),
    "Verify supported must be bounded to maxItems 3",
  );
  assert.ok(
    body.includes(`claim: { type: 'string', maxLength: ${MAX_RESEARCH_CLAIM_CHARS} }`),
    "Verify claim must be maxLength 140",
  );
  assert.ok(
    body.includes(
      `sources: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: ${MAX_RESEARCH_URL_CHARS} } }`,
    ),
    "Verify sources must be maxItems 2 / maxLength 200",
  );
  // Verify must omit discarded strings from the result.
  assert.match(body, /omit any discarded strings from the result/, "Verify must omit discarded strings");
  // No evidence-file write in the Verify prompt.
  assert.doesNotMatch(body, /write the full supported-evidence JSON/, "Verify must not write an evidence file");
});

test("generateDeepResearchWorkflow: Report returns only a one-line summary (maxLength 120), no report body", () => {
  const body = generateDeepResearchWorkflow();
  // Report returns only { summary } with maxLength 120 — no report body.
  assert.ok(
    body.includes(`summary: { type: 'string', maxLength: ${MAX_RESEARCH_SUMMARY_CHARS} }`),
    "Report summary schema must be maxLength 120",
  );
  assert.match(body, /ONE-LINE plain-text answer/, "Report prompt must request a one-line answer only");
  assert.match(body, /Do NOT write a full report body/, "Report must not produce a full report body");
  // No read/write tool selection in Report.
  assert.doesNotMatch(body, /label: 'write report',[\s\S]*?tools: \[[^\]]*'write'/, "Report must not select write");
});

test("generateDeepResearchWorkflow: workflow final return is bounded supported + bounded summary only (no question)", () => {
  const body = generateDeepResearchWorkflow();
  // The final return carries ok/supported/summary and slices summary to 120 —
  // the validated question stays with the host and is NOT echoed back here.
  // Use includes() for the exact slice expression so the assertion does not
  // depend on regex backslash escaping (a formatter can normalize it).
  assert.ok(
    body.includes(`ok: true,`) &&
      body.includes(`supported,`) &&
      body.includes(
        `summary: (report && typeof report.summary === 'string' ? report.summary : '').slice(0, ${MAX_RESEARCH_SUMMARY_CHARS})`,
      ),
    "final return must carry ok/supported and a summary sliced to MAX_RESEARCH_SUMMARY_CHARS",
  );
  // Extract the final return block (the one with `ok: true`) and assert it
  // contains NO `question` field — the host owns the question separately.
  const finalReturnMatch = body.match(/return \{[^}]*?ok: true,[\s\S]*?\}/);
  assert.ok(finalReturnMatch, "final return block must be present");
  const finalReturn = finalReturnMatch[0];
  assert.doesNotMatch(finalReturn, /\bquestion\b/, "workflow final return must not carry the question");
  // No full `report` body field in the final return.
  assert.doesNotMatch(finalReturn, /\breport: /, "workflow return must not carry a full report body");
  // No model-controlled path in the final return.
  assert.doesNotMatch(finalReturn, /\bpath:/, "workflow return must not carry a model-controlled path");
});

test("generateDeepResearchWorkflow: worst-case bounded result serializes below 10KB UTF-8", () => {
  // Construct schema-limit data with MAX multibyte emoji payloads: 3 claims,
  // each claim max 140 emoji chars, each with 2 source URLs max 200 emoji chars,
  // plus a 120-emoji-char summary. Every bounded character is a 4-byte code
  // point (U+1F600) so this is the conservative worst case for UTF-8 byte size.
  // The question is no longer part of the result (host owns it), so excluded.
  const summary = emojiChars(MAX_RESEARCH_SUMMARY_CHARS);
  const supported = Array.from({ length: MAX_SUPPORTED_CLAIMS }, () => ({
    claim: emojiChars(MAX_RESEARCH_CLAIM_CHARS),
    sources: [emojiChars(MAX_RESEARCH_URL_CHARS), emojiChars(MAX_RESEARCH_URL_CHARS)],
  }));
  const result = { ok: true, supported, summary };
  const bytes = utf8Bytes(result);
  // Prove the returned JSON contract stays strictly below 10,000 UTF-8 bytes.
  assert.ok(bytes < 10_000, `worst-case bounded result must serialize below 10KB UTF-8, got ${bytes} bytes`);
});

// ─── Deep Research: execution-level bounds & schema hygiene ───────────────────
// These run the generated workflow end-to-end with a capturing mock agent to
// prove (a) an oversized direct-workflow question is defensively clamped so
// every assembled model prompt AND the final serialized result stay below
// 10KB even at maximum Gather fan-in, and (b) every structured schema object
// has additionalProperties:false so extras are rejected/stripped per runtime
// behavior (typebox Check rejects; Convert preserves, extractValidated returns
// undefined — i.e. no fabrication).

import type { TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { extractValidated } from "../src/agent.js";
import {
  MAX_CLAIMS_PER_SOURCE,
  MAX_GATHER_SOURCES,
  MAX_RESEARCH_ANGLES,
  MAX_RESEARCH_CLAIM_CHARS,
  MAX_RESEARCH_QUERY_CHARS,
  MAX_RESEARCH_QUESTION_CHARS,
  MAX_RESEARCH_SUMMARY_CHARS,
  MAX_RESEARCH_URL_CHARS,
  MAX_SUPPORTED_CLAIMS,
} from "../src/deep-research.js";

// A four-byte UTF-8 emoji (U+1F600). Slicing an overlong emoji string by UTF-16
// units yields a 2-unit/4-byte trailing char at even bounds and a 1-unit
// surrogate at odd bounds; both stay within the byte budget. To model the
// task's conservative worst case (every bounded CHARACTER is a 4-byte code
// point), build strings of exactly maxLength emoji — one emoji per bounded
// char, 4 UTF-8 bytes each.
const EMOJI = "😀";
/** Build an emoji string of exactly `chars` emoji (chars code points = 4*chars UTF-8 bytes). */
const emojiChars = (chars: number): string => EMOJI.repeat(chars);
/** UTF-8 byte length of a value (string or JSON-serialized object). */
const utf8Bytes = (value: string | object): number =>
  typeof value === "string" ? Buffer.byteLength(value, "utf8") : Buffer.byteLength(JSON.stringify(value), "utf8");

interface CapturedCall {
  label: string;
  prompt: string;
  schema?: TSchema;
  result: unknown;
}

/**
 * Build a capturing mock agent that returns schema-maximal payloads at every
 * phase, so every raw structured result, the aggregate Verify prompt, the
 * Report prompt, and the final result hit their conservative worst case
 * (every bounded character is a 4-byte emoji, U+1F600). Each Gather agent
 * returns the maximum 2 sources × 2 claims, so 4 angles fan in 8 candidate
 * sources — the aggregate cap keeps only MAX_GATHER_SOURCES (4).
 */
function makeCapturingRunner(calls: CapturedCall[]): {
  run: (prompt: string, options: { label?: string; schema?: TSchema }) => Promise<unknown>;
} {
  let gatherIdx = 0;
  return {
    run: async (prompt: string, options) => {
      const label = options.label ?? "";
      let result: unknown;
      if (label === "plan queries") {
        // Maximal Queries payload: 4 queries, each maxLength emoji chars.
        result = { queries: Array.from({ length: MAX_RESEARCH_ANGLES }, () => emojiChars(MAX_RESEARCH_QUERY_CHARS)) };
      } else if (label.startsWith("research ")) {
        const i = gatherIdx++;
        // Maximal Gather payload: 2 sources, each url maxLength emoji chars + 2 claims of maxLength emoji chars.
        result = {
          sources: Array.from({ length: 2 }, (_unused, j) => ({
            url: `https://src${i}-${j}.example/${emojiChars(MAX_RESEARCH_URL_CHARS)}`,
            claims: [emojiChars(MAX_RESEARCH_CLAIM_CHARS), emojiChars(MAX_RESEARCH_CLAIM_CHARS)],
          })),
        };
      } else if (label === "cross-check") {
        // Maximal Verify payload: MAX_SUPPORTED_CLAIMS claims, each maxLength emoji + 2 urls of maxLength emoji.
        result = {
          supported: Array.from({ length: MAX_SUPPORTED_CLAIMS }, (_unused, k) => ({
            claim: emojiChars(MAX_RESEARCH_CLAIM_CHARS),
            sources: [
              `https://v${k}a.example/${emojiChars(MAX_RESEARCH_URL_CHARS)}`,
              `https://v${k}b.example/${emojiChars(MAX_RESEARCH_URL_CHARS)}`,
            ],
          })),
        };
      } else if (label === "write report") {
        result = { summary: emojiChars(MAX_RESEARCH_SUMMARY_CHARS) };
      } else {
        result = {};
      }
      calls.push({ label, prompt, schema: options.schema, result });
      return result;
    },
  };
}

test("generateDeepResearchWorkflow: oversized direct-workflow question is clamped and every prompt/result stays below 10KB UTF-8 at max fan-in", async () => {
  const calls: CapturedCall[] = [];
  // Oversized question bypasses the handler gate. Use 4-byte emoji so the
  // clamped tail itself is worst-case multibyte; the full oversized string is
  // never echoed into any prompt.
  const oversizedQuestion = emojiChars(MAX_RESEARCH_QUESTION_CHARS * 4); // 1200 emoji — bypasses the handler gate
  const result = await runWorkflow(generateDeepResearchWorkflow(), {
    cwd: "/tmp/deep-research-exec",
    args: { question: oversizedQuestion, angles: 4, minSupport: "M".repeat(12_000) },
    persistLogs: false,
    agent: makeCapturingRunner(calls),
  });

  // Every phase ran: 1 Queries + 4 Gather + 1 Verify + 1 Report = 7 agent calls.
  assert.equal(calls.length, 7, "should run Queries + 4 Gather + Verify + Report");
  const labels = calls.map((c) => c.label);
  assert.equal(labels[0], "plan queries");
  assert.equal(labels.filter((l) => l.startsWith("research ")).length, 4);
  assert.equal(labels.filter((l) => l === "cross-check").length, 1);
  assert.equal(labels.filter((l) => l === "write report").length, 1);

  // The oversized question was defensively clamped: every prompt that echoes
  // the question must contain at most the first MAX_RESEARCH_QUESTION_CHARS of
  // it, never the full oversized string. The clamped tail is exactly the first
  // 300 emoji (UTF-16 units = 600, but it is the clamped prefix the workflow slices).
  const clamped = oversizedQuestion.slice(0, MAX_RESEARCH_QUESTION_CHARS);
  for (const call of calls) {
    assert.ok(
      !call.prompt.includes(oversizedQuestion),
      `${call.label} prompt must not contain the unclamped oversized question`,
    );
    if (call.label === "plan queries" || call.label === "write report") {
      assert.ok(call.prompt.includes(clamped), `${call.label} prompt must include the clamped question`);
    }
  }

  // EVERY assembled model prompt must be strictly below 10,000 UTF-8 bytes.
  for (const call of calls) {
    assert.ok(
      utf8Bytes(call.prompt) < 10_000,
      `${call.label} prompt must be below 10KB UTF-8, got ${utf8Bytes(call.prompt)} bytes`,
    );
  }

  // The Verify prompt specifically — instructions + the bounded SOURCES JSON —
  // must stay under 10,000 UTF-8 bytes even at maximum Gather fan-in (4 angles
  // = 8 candidate sources, aggregate-capped to MAX_GATHER_SOURCES sources).
  const verify = calls.find((c) => c.label === "cross-check");
  assert.ok(verify, "Verify call must exist");
  assert.ok(
    utf8Bytes(verify.prompt) < 10_000,
    `Verify prompt must be below 10KB UTF-8 at max fan-in, got ${utf8Bytes(verify.prompt)} bytes`,
  );

  // Every schema-maximal raw structured agent result must serialize below
  // 10,000 UTF-8 bytes (the model-controlled values before fan-in/final return).
  for (const call of calls) {
    assert.ok(
      utf8Bytes(call.result) < 10_000,
      `${call.label} raw structured result must be below 10KB UTF-8, got ${utf8Bytes(call.result)} bytes`,
    );
  }

  // The final serialized result must be below 10,000 UTF-8 bytes and must NOT
  // carry the question. The supported array is re-normalized to MAX_SUPPORTED_CLAIMS.
  const finalResult = result.result as { ok: boolean; question?: unknown; supported?: unknown[]; summary?: string };
  const finalBytes = utf8Bytes(finalResult);
  assert.ok(finalBytes < 10_000, `final serialized result must be below 10KB UTF-8, got ${finalBytes}`);
  assert.equal(finalResult.question, undefined, "final result must not carry the question");
  assert.equal(finalResult.ok, true);
  assert.equal(finalResult.supported?.length, MAX_SUPPORTED_CLAIMS);
});

test("generateDeepResearchWorkflow: direct minSupport values normalize to a bounded integer", async () => {
  for (const minSupport of ["M".repeat(12_000), Number.NaN, Number.POSITIVE_INFINITY, -100, 999, "4"]) {
    const calls: CapturedCall[] = [];
    await runWorkflow(generateDeepResearchWorkflow(), {
      cwd: "/tmp/deep-research-min-support",
      args: { question: "bounded question", angles: 1, minSupport },
      persistLogs: false,
      agent: makeCapturingRunner(calls),
    });
    const verify = calls.find((call) => call.label === "cross-check");
    assert.ok(verify, "Verify call must exist");
    const match = /at least (\d+) distinct source URLs/.exec(verify.prompt);
    assert.ok(match, "Verify prompt must contain normalized minSupport");
    const normalized = Number(match[1]);
    assert.ok(normalized >= 1 && normalized <= MAX_GATHER_SOURCES);
    assert.ok(utf8Bytes(verify.prompt) < 10_000);
  }
});

test("generateDeepResearchWorkflow: aggregate Gather fan-in is capped to MAX_GATHER_SOURCES sources / MAX_CLAIMS_PER_SOURCE claims before Verify", async () => {
  const calls: CapturedCall[] = [];
  await runWorkflow(generateDeepResearchWorkflow(), {
    cwd: "/tmp/deep-research-fanin",
    args: { question: "bounded question", angles: 4 },
    persistLogs: false,
    agent: makeCapturingRunner(calls),
  });
  const verify = calls.find((c) => c.label === "cross-check");
  assert.ok(verify, "Verify call must exist");
  // Recover the allSources JSON the workflow assembled for Verify. The
  // prompt embeds a real newline after "SOURCES JSON:".
  const marker = "SOURCES JSON:";
  const markerIdx = verify.prompt.indexOf(marker);
  assert.ok(markerIdx > -1, "Verify prompt must include SOURCES JSON marker");
  const sourcesJson = verify.prompt.slice(markerIdx + marker.length).trim();
  const allSources = JSON.parse(sourcesJson) as Array<{ url: string; claims: string[] }>;
  assert.ok(Array.isArray(allSources), "allSources must be an array");
  assert.ok(
    allSources.length <= MAX_GATHER_SOURCES,
    `aggregate sources must be capped at ${MAX_GATHER_SOURCES}, got ${allSources.length}`,
  );
  for (const src of allSources) {
    assert.ok(
      src.claims.length <= MAX_CLAIMS_PER_SOURCE,
      `claims per source must be capped at ${MAX_CLAIMS_PER_SOURCE}, got ${src.claims.length}`,
    );
    // The workflow re-slices every source url to MAX_RESEARCH_URL_CHARS UTF-16
    // units before fan-in, so the echoed url never exceeds that bound.
    assert.ok(
      src.url.length <= MAX_RESEARCH_URL_CHARS,
      `source url must be bounded to ${MAX_RESEARCH_URL_CHARS} UTF-16 units, got ${src.url.length}`,
    );
    for (const claim of src.claims) {
      assert.ok(
        claim.length <= MAX_RESEARCH_CLAIM_CHARS,
        `claim must be bounded to ${MAX_RESEARCH_CLAIM_CHARS} UTF-16 units, got ${claim.length}`,
      );
    }
  }
  // The aggregate SOURCES JSON itself stays under 10KB UTF-8.
  assert.ok(
    utf8Bytes(allSources) < 10_000,
    `aggregate SOURCES JSON must be below 10KB UTF-8, got ${utf8Bytes(allSources)}`,
  );
});

test("generateDeepResearchWorkflow: every structured schema has additionalProperties:false and rejects extras per runtime behavior", async () => {
  const calls: CapturedCall[] = [];
  await runWorkflow(generateDeepResearchWorkflow(), {
    cwd: "/tmp/deep-research-schemas",
    args: { question: "schema question", angles: 4 },
    persistLogs: false,
    agent: makeCapturingRunner(calls),
  });

  // Capture the four top-level structured schemas the workflow actually hands
  // to agent(): Queries, Gather, Verify, Report.
  const byLabel = new Map(calls.map((c) => [c.label, c]));
  const queriesSchema = byLabel.get("plan queries")?.schema;
  const gatherSchema = calls.find((c) => c.label.startsWith("research "))?.schema;
  const verifySchema = byLabel.get("cross-check")?.schema;
  const reportSchema = byLabel.get("write report")?.schema;
  assert.ok(queriesSchema && gatherSchema && verifySchema && reportSchema, "all four schemas must be captured");

  // Every top-level object AND every nested object item must declare
  // additionalProperties:false (recursively across Queries / Gather top + source
  // item / Verify top + claim item / Report top).
  const schemas: Array<{ name: string; schema: TSchema }> = [
    { name: "Queries", schema: queriesSchema },
    { name: "Gather", schema: gatherSchema },
    { name: "Verify", schema: verifySchema },
    { name: "Report", schema: reportSchema },
  ];

  /** Recursively collect every object-type node in a JSON-schema-ish tree. */
  function collectObjects(node: unknown, out: unknown[] = []): unknown[] {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      if ((node as { type?: string }).type === "object") out.push(node);
      for (const v of Object.values(node)) collectObjects(v, out);
    } else if (Array.isArray(node)) {
      for (const v of node) collectObjects(v, out);
    }
    return out;
  }

  for (const { name, schema } of schemas) {
    const objs = collectObjects(schema);
    assert.ok(objs.length > 0, `${name} schema must contain object nodes`);
    for (const obj of objs) {
      assert.equal(
        (obj as { additionalProperties?: unknown }).additionalProperties,
        false,
        `${name} schema object must set additionalProperties:false`,
      );
    }
  }

  // Runtime behavior proof (typebox Check/Convert/extractValidated):
  // additionalProperties:false means an object carrying an extra property is
  // REJECTED by Check (validation fails), Convert does NOT strip the extra
  // (it preserves it, so Check still fails), and extractValidated therefore
  // returns undefined (no fabrication). This is the runtime's actual behavior —
  // extras are not silently smuggled into a schema-bounded result.
  const verifyExtras = {
    supported: [{ claim: "c", sources: ["u"], malicious: "should not survive" }],
    extraTop: "nope",
  };
  assert.equal(Check(verifySchema, verifyExtras), false, "Verify schema must reject extra properties");
  const converted = Convert(verifySchema, verifyExtras);
  assert.ok(
    JSON.stringify(converted).includes("malicious"),
    "Convert must NOT strip extras (runtime preserves them; Check then fails)",
  );
  assert.equal(
    extractValidated(JSON.stringify(verifyExtras), verifySchema),
    undefined,
    "extractValidated must reject extras (no fabrication)",
  );

  // Gather source item extras are rejected too.
  const gatherExtras = { sources: [{ url: "u", claims: ["c"], extra: 1 }], topExtra: true };
  assert.equal(Check(gatherSchema, gatherExtras), false, "Gather schema must reject extra properties");

  // A clean (extras-free) payload validates fine.
  const cleanVerify = { supported: [{ claim: "c", sources: ["u"] }] };
  assert.equal(Check(verifySchema, cleanVerify), true, "clean Verify payload must validate");
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
