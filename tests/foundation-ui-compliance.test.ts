import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, "..", "docs", "workflows", "templates", "foundation_ui_compliance.workflow.mjs");
const source = readFileSync(templatePath, "utf8");

/**
 * Extract each `await agent(...)` call as a block of source text, including the
 * options object. The template writes each call as `await agent(` on its own
 * line followed by an array prompt and a `{ ... }` options object.
 */
function agentCallBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/await agent\(/.test(line)) continue;
    let depth = 0;
    let started = false;
    const buf: string[] = [];
    for (let j = i; j < lines.length; j++) {
      const l = lines[j] ?? "";
      for (const ch of l) {
        if (ch === "(") {
          depth++;
          started = true;
        } else if (ch === ")") {
          depth--;
        }
      }
      buf.push(l);
      if (started && depth === 0) {
        blocks.push(buf.join("\n"));
        i = j;
        break;
      }
    }
  }
  return blocks;
}

function blockFor(blocks: string[], needle: string): string {
  return blocks.find((b) => b.includes(needle)) ?? "";
}

function expectDeny(): string[] {
  return [...new Set(["third_party/**", ".github/**", "vendor/**"])];
}

// =====================================================================
// STATIC SOURCE TESTS
// =====================================================================

test("foundation_ui_compliance parses with the expected meta and phase order", () => {
  const { meta, body } = parseWorkflowScript(source);
  assert.equal(meta.name, "foundation_ui_compliance");
  assert.ok((meta.description ?? "").length > 0);
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Gate-Diagnose", "Fix <-> Re-gate loop", "Visual verify", "Deliver", "Receipt"],
  );
  // Every declared phase is entered via phase() in the body.
  for (const title of meta.phases?.map((p) => p.title) ?? []) {
    assert.match(body, new RegExp(`phase\\("${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
  }
});

test("foundation_ui_compliance validates required args and closes the editDeny set", () => {
  const { body } = parseWorkflowScript(source);
  assert.match(body, /if \(!appSrc\) throw new Error\(/);
  assert.match(body, /if \(editAllow\.length === 0\) throw new Error\(/);

  const denyMatch = /const editDeny = \[[\s\S]*?\];/.exec(body);
  assert.ok(denyMatch, "editDeny declaration should be present");
  const denyBlock = denyMatch?.[0];
  assert.match(denyBlock, /third_party\/\*\*/);
  assert.match(denyBlock, /\.github\/\*\*/);
  assert.match(denyBlock, /vendor\/\*\*/);
  assert.match(denyBlock, /new Set\(/, "editDeny should be Set-deduplicated");

  assert.match(body, /run-foundation-gates\.mjs --app-src \$\{appSrc\}/);
  assert.doesNotMatch(body, /run-foundation-gates\/[a-z-]+\.mjs/, "must not enumerate individual gate scripts");
  assert.doesNotMatch(body, /gate-(colors|spacing|proportions|tokens)\.mjs/);
});

test("foundation_ui_compliance read-only fences the gate, regate, and visual-verify agents (no trace-assert agent)", () => {
  const { body } = parseWorkflowScript(source);
  const blocks = agentCallBlocks(body);
  assert.ok(blocks.length >= 5, `expected at least 5 agent calls, got ${blocks.length}`);

  for (const needle of ["gate-diagnose", "visual-verify"]) {
    const block = blockFor(blocks, `label: "${needle}"`);
    assert.ok(block, `agent block for ${needle} should exist`);
    assert.match(block, /readOnly:\s*true/, `${needle} must be readOnly: true`);
  }
  const regate = blockFor(blocks, "regate-round-");
  assert.ok(regate, "regate-round block should exist");
  assert.match(regate, /readOnly:\s*true/, "regate-round must be readOnly: true");

  const fix = blockFor(blocks, "fix-round-");
  assert.ok(fix, "fix-round block should exist");
  assert.doesNotMatch(fix, /readOnly:\s*true/, "fix-round must NOT be readOnly");
  const deliver = blockFor(blocks, `label: "deliver"`);
  assert.ok(deliver, "deliver block should exist");
  assert.doesNotMatch(deliver, /readOnly:\s*true/, "deliver must NOT be readOnly");

  assert.doesNotMatch(body, /label: "trace-assert"/, "no trace-assert agent (runtime has no trace API)");
  assert.doesNotMatch(body, /Read this run's subagent transcripts/, "no fake transcript-read instruction");
});

test("foundation_ui_compliance tier routes big diagnose/verify, medium fix/deliver", () => {
  const { body } = parseWorkflowScript(source);
  const blocks = agentCallBlocks(body);

  assert.match(blockFor(blocks, "gate-diagnose"), /tier:\s*"big"/, "gate-diagnose uses big tier");
  assert.match(blockFor(blocks, "visual-verify"), /tier:\s*"big"/, "visual-verify uses big tier");
  assert.match(blockFor(blocks, "fix-round-"), /tier:\s*"medium"/, "fix-round uses medium tier");
  assert.match(blockFor(blocks, `label: "deliver"`), /tier:\s*"medium"/, "deliver uses medium tier");
});

test("foundation_ui_compliance contains no hardcoded app-specific values", () => {
  const { body } = parseWorkflowScript(source);
  const codeOnly = body
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(codeOnly, /https?:\/\/localhost:\d+/, "urls must come from args, not be hardcoded");
  assert.doesNotMatch(codeOnly, /pnpm --dir web-next/, "buildCmd must come from args, not be hardcoded");
  assert.match(body, /A\.appSrc/, "appSrc is read from args");
  assert.match(body, /A\.buildCmd/, "buildCmd is read from args");
  assert.match(body, /A\.urls/, "urls is read from args");
});

test("foundation_ui_compliance does not claim runtime-enforced edit scope or transcript-backed trace-assert", () => {
  const { body } = parseWorkflowScript(source);
  assert.doesNotMatch(body, /phase\("Trace-assert"\)/, "must not declare a trace-assert phase");
  assert.doesNotMatch(body, /label: "trace-assert"/, "must not spawn a trace-assert agent");
  assert.doesNotMatch(body, /runtime-enforced edit scope/i, "must not claim runtime-enforced edit scope");
  assert.doesNotMatch(body, /Read this run's subagent transcripts/, "must not instruct reading transcripts");
  assert.match(body, /phase\("Receipt"\)/, "final phase is Receipt");
  assert.match(body, /RUN RECEIPT/, "emits a RUN RECEIPT log");
  assert.match(body, /roundsRun: lastRound/, "receipt records roundsRun from in-workbook state");
  assert.match(body, /gatesCleared,/, "receipt records gatesCleared from in-workbook state (shorthand)");
  assert.match(body, /visualVerifyRan,/, "receipt records visualVerifyRan from in-workbook state (shorthand)");
  assert.match(body, /visualVerifyPassed,/, "receipt records visualVerifyPassed (shorthand)");
  assert.match(body, /deliveryEligible,/, "receipt records deliveryEligible (shorthand)");
  assert.doesNotMatch(body, /visualVerifyRan:\s*urls\.length > 0/, "receipt must not derive visualVerifyRan from args");
  assert.doesNotMatch(
    body,
    /frontierTiers:\s*\[/,
    "frontierTiers in receipt must be a dynamic reference, not a static array literal",
  );
  assert.doesNotMatch(
    body,
    /fixTiers:\s*\[/,
    "fixTiers in receipt must be a dynamic reference, not a static array literal",
  );
});

// =====================================================================
// EXECUTION TESTS
// =====================================================================
// Verdicts are returned as strict structured objects. Stubs detect agent
// role by prompt markers (GATE-DIAGNOSE / RE-GATE runner / VISUAL VERIFY /
// FIX agent / DELIVER agent).

const CLEAN_VERDICT = { passed: true, findings: [] };
const RED_VERDICT = {
  passed: false,
  findings: [{ id: "spacing-1", gate: "proportion", file: "web/src/App.tsx", "fix-hint": "use size token" }],
};
const VISUAL_PASS = { passed: true, defects: [] };
const VISUAL_FAIL = { passed: false, defects: [{ area: "hero", defect: "text overflow", evidence: "crop @120,40" }] };
const DELIVER_OK = "branch=fix/ui sha=abc123 pr=https://github.com/org/repo/pull/1";

async function runWith(
  stubAgent: (prompt: string) => unknown,
  args: Record<string, unknown>,
): Promise<{ res: unknown; receipt: Record<string, unknown>; logs: string[] }> {
  const logs: string[] = [];
  const res = await runWorkflow(source, {
    agent: { run: stubAgent } as never,
    args,
    persistLogs: false,
    onLog: (m) => logs.push(String(m)),
  });
  const receiptLog = logs.find((l) => l.includes("RUN RECEIPT")) ?? "";
  assert.ok(receiptLog, "RUN RECEIPT log must be emitted");
  const receipt = JSON.parse(receiptLog.replace(/^RUN RECEIPT: /, ""));
  return { res, receipt, logs };
}

function baseArgs(over: Record<string, unknown>): Record<string, unknown> {
  return {
    appSrc: "web/src",
    foundation: "third_party/frontend-foundation",
    buildCmd: null,
    urls: ["http://localhost:4173/dashboard"],
    editAllow: ["web/src/**"],
    editDeny: [],
    maxRounds: 2,
    deliver: false,
    ...over,
  };
}

test("execution: initial-clean with URLs enters every phase, runs visual verify, skips fix/deliver", async () => {
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return CLEAN_VERDICT;
    if (/VISUAL VERIFY/.test(prompt)) return VISUAL_PASS;
    return "ok";
  };
  const { res, receipt } = await runWith(stubAgent, baseArgs({ deliver: false }));

  assert.deepEqual((res as { phases: string[] }).phases, [
    "Gate-Diagnose",
    "Fix <-> Re-gate loop",
    "Visual verify",
    "Deliver",
    "Receipt",
  ]);
  assert.equal(receipt.gatesCleared, true, "initial clean sets gatesCleared=true");
  assert.equal(receipt.roundsRun, 0, "no fix rounds run");
  assert.equal(receipt.visualVerifyRan, true, "visual verify ran because gates clear + URLs provided");
  assert.equal(receipt.visualVerifyPassed, true, "visual verify passed");
  assert.equal(receipt.deliveryEligible, false, "deliver=false so not eligible");
  assert.equal(receipt.delivered, null, "deliver=false means no delivery");
  assert.deepEqual(receipt.frontierTiers, ["gate-diagnose:big", "visual-verify:big"]);
  assert.deepEqual(receipt.fixTiers, []);
  assert.deepEqual(receipt.editDeny, expectDeny());
});

test("execution: initial-clean without URLs enters every phase, skips visual verify and delivery", async () => {
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return CLEAN_VERDICT;
    return "ok";
  };
  const { res, receipt } = await runWith(stubAgent, baseArgs({ urls: [], deliver: true }));

  assert.deepEqual((res as { phases: string[] }).phases, [
    "Gate-Diagnose",
    "Fix <-> Re-gate loop",
    "Visual verify",
    "Deliver",
    "Receipt",
  ]);
  assert.equal(receipt.gatesCleared, true);
  assert.equal(receipt.roundsRun, 0);
  assert.equal(receipt.visualVerifyRan, false, "no URLs means visual verify skipped");
  assert.equal(receipt.visualVerifyPassed, null, "visual not run => null (not derived from args)");
  assert.equal(receipt.deliveryEligible, true, "gates clear + no URLs (visual not required) + deliver=true");
  assert.ok(receipt.delivered, "no URLs + deliver=true => delivery runs");
  assert.deepEqual(receipt.frontierTiers, ["gate-diagnose:big"]);
  assert.deepEqual(receipt.fixTiers, ["deliver:medium"]);
  assert.deepEqual(receipt.editDeny, expectDeny());
});

test("execution: repaired-to-green runs fix, regate, visual verify, and delivery", async () => {
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return RED_VERDICT;
    if (/FIX agent/.test(prompt)) return "fixed web/src/styles.css";
    if (/RE-GATE runner/.test(prompt)) return CLEAN_VERDICT;
    if (/VISUAL VERIFY/.test(prompt)) return VISUAL_PASS;
    if (/DELIVER agent/.test(prompt)) return DELIVER_OK;
    return "ok";
  };
  const { res, receipt } = await runWith(stubAgent, baseArgs({ deliver: true }));

  assert.deepEqual((res as { phases: string[] }).phases, [
    "Gate-Diagnose",
    "Fix <-> Re-gate loop",
    "Visual verify",
    "Deliver",
    "Receipt",
  ]);
  assert.equal(receipt.gatesCleared, true, "regate passed so gatesCleared=true");
  assert.equal(receipt.roundsRun, 1, "one fix round");
  assert.equal(receipt.visualVerifyRan, true, "gates clear + URLs => visual verify ran");
  assert.equal(receipt.visualVerifyPassed, true, "visual verify passed");
  assert.equal(receipt.deliveryEligible, true, "gates clear + visual pass + deliver=true");
  assert.ok(receipt.delivered, "deliver=true => delivery attempted");
  assert.deepEqual(receipt.frontierTiers, ["gate-diagnose:big", "visual-verify:big"]);
  assert.deepEqual(receipt.fixTiers, ["fix-round-1:medium", "regate-round-1:medium", "deliver:medium"]);
  assert.deepEqual(receipt.editDeny, expectDeny());
});

test("execution: still-red (NOT CLEAN equivalent) skips visual verify and delivery, logs skip reasons", async () => {
  const logs: string[] = [];
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return RED_VERDICT;
    if (/FIX agent/.test(prompt)) return "attempted fix";
    if (/RE-GATE runner/.test(prompt))
      return { passed: false, findings: [{ id: "spacing-1", gate: "proportion", detail: "still failing" }] };
    return "ok";
  };
  const res = await runWorkflow(source, {
    agent: { run: stubAgent } as never,
    args: baseArgs({ maxRounds: 1, deliver: true }),
    persistLogs: false,
    onLog: (m) => logs.push(String(m)),
  });

  assert.deepEqual(res.phases, ["Gate-Diagnose", "Fix <-> Re-gate loop", "Visual verify", "Deliver", "Receipt"]);

  const receiptLog = logs.find((l) => l.includes("RUN RECEIPT")) ?? "";
  assert.ok(receiptLog);
  const receipt = JSON.parse(receiptLog.replace(/^RUN RECEIPT: /, ""));
  assert.equal(receipt.gatesCleared, false, "gates never cleared");
  assert.equal(receipt.roundsRun, 1, "one fix round attempted");
  assert.equal(receipt.visualVerifyRan, false, "visual verify skipped because gates red");
  assert.equal(receipt.visualVerifyPassed, null, "visual not run => null");
  assert.equal(receipt.deliveryEligible, false, "gates red => not eligible");
  assert.equal(receipt.delivered, null, "delivery blocked because gates red");
  assert.deepEqual(receipt.frontierTiers, ["gate-diagnose:big"]);
  assert.deepEqual(receipt.fixTiers, ["fix-round-1:medium", "regate-round-1:medium"]);
  assert.deepEqual(receipt.editDeny, expectDeny());

  assert.ok(
    logs.some((l) => l.includes("Skipping: gates still red — visual verify cannot confirm compliance.")),
    "visual verify skip reason logged",
  );
  assert.ok(
    logs.some((l) => l.includes("Skipping: gates still red — delivery blocked.")),
    "delivery skip reason logged",
  );
});

test("execution: failed re-gate (passed:false) after a round blocks delivery", async () => {
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return RED_VERDICT;
    if (/FIX agent/.test(prompt)) return "attempted fix";
    if (/RE-GATE runner/.test(prompt)) return { passed: false, findings: [{ id: "x", gate: "tokens", detail: "bad" }] };
    return "ok";
  };
  const { receipt } = await runWith(stubAgent, baseArgs({ maxRounds: 1, deliver: true }));

  assert.equal(receipt.gatesCleared, false, "re-gate passed=false => gates stay red");
  assert.equal(receipt.roundsRun, 1);
  assert.equal(receipt.visualVerifyRan, false, "gates red => visual skipped");
  assert.equal(receipt.visualVerifyPassed, null);
  assert.equal(receipt.deliveryEligible, false, "gates red => not eligible");
  assert.equal(receipt.delivered, null, "delivery skipped after failed re-gate");
});

test("execution: passed:true with diagnose findings is contradictory and cannot clear gates", async () => {
  const contradictory = { passed: true, findings: RED_VERDICT.findings };
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return contradictory;
    if (/FIX agent/.test(prompt)) return "attempted fix";
    if (/RE-GATE runner/.test(prompt)) return RED_VERDICT;
    if (/DELIVER agent/.test(prompt)) return DELIVER_OK;
    return "ok";
  };
  const { receipt } = await runWith(stubAgent, baseArgs({ maxRounds: 1, deliver: true }));

  assert.equal(receipt.gatesCleared, false, "non-empty findings override passed:true");
  assert.equal(receipt.deliveryEligible, false);
  assert.equal(receipt.delivered, null);
});

test("execution: passed:true with re-gate findings remains red", async () => {
  const contradictory = { passed: true, findings: RED_VERDICT.findings };
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return RED_VERDICT;
    if (/FIX agent/.test(prompt)) return "attempted fix";
    if (/RE-GATE runner/.test(prompt)) return contradictory;
    if (/DELIVER agent/.test(prompt)) return DELIVER_OK;
    return "ok";
  };
  const { receipt } = await runWith(stubAgent, baseArgs({ maxRounds: 1, deliver: true }));

  assert.equal(receipt.gatesCleared, false, "non-empty re-gate findings override passed:true");
  assert.equal(receipt.deliveryEligible, false);
  assert.equal(receipt.delivered, null);
});

test("execution: visual failure (defects) blocks delivery even when gates cleared", async () => {
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return CLEAN_VERDICT;
    if (/VISUAL VERIFY/.test(prompt)) return VISUAL_FAIL;
    if (/DELIVER agent/.test(prompt)) return DELIVER_OK;
    return "ok";
  };
  const { receipt, logs } = await runWith(stubAgent, baseArgs({ deliver: true }));

  assert.equal(receipt.gatesCleared, true, "gates cleared");
  assert.equal(receipt.visualVerifyRan, true, "visual ran");
  assert.equal(receipt.visualVerifyPassed, false, "valid visual failure is recorded as false");
  assert.equal(receipt.deliveryEligible, false, "visual failed => not eligible");
  assert.equal(receipt.delivered, null, "delivery skipped after visual failure");
  assert.ok(
    logs.some((l) => l.includes("Skipping: visual verify failed/not-passed — delivery blocked.")),
    "visual-failure skip reason logged",
  );
});

test("execution: passed:true with visual defects is contradictory and blocks delivery", async () => {
  const contradictory = { passed: true, defects: VISUAL_FAIL.defects };
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return CLEAN_VERDICT;
    if (/VISUAL VERIFY/.test(prompt)) return contradictory;
    if (/DELIVER agent/.test(prompt)) return DELIVER_OK;
    return "ok";
  };
  const { receipt } = await runWith(stubAgent, baseArgs({ deliver: true }));

  assert.equal(receipt.visualVerifyRan, true);
  assert.equal(receipt.visualVerifyPassed, false, "non-empty defects override passed:true");
  assert.equal(receipt.deliveryEligible, false);
  assert.equal(receipt.delivered, null);
});

test("execution: failed diagnose without findings never grants fixer authority", async () => {
  let fixCalls = 0;
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return { passed: false, findings: [] };
    if (/FIX agent/.test(prompt)) fixCalls++;
    return "ok";
  };
  const { receipt, logs } = await runWith(stubAgent, baseArgs({ deliver: true }));

  assert.equal(fixCalls, 0, "no actionable findings means no mutating fixer");
  assert.equal(receipt.roundsRun, 0);
  assert.equal(receipt.gatesCleared, false);
  assert.equal(receipt.deliveryEligible, false);
  assert.equal(receipt.delivered, null);
  assert.ok(logs.some((line) => line.includes("fixer authority not granted")));
});

test("execution: failed re-gate without findings stops before another fixer round", async () => {
  let fixCalls = 0;
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return RED_VERDICT;
    if (/FIX agent/.test(prompt)) {
      fixCalls++;
      return "attempted fix";
    }
    if (/RE-GATE runner/.test(prompt)) return { passed: false, findings: [] };
    return "ok";
  };
  const { receipt, logs } = await runWith(stubAgent, baseArgs({ maxRounds: 2, deliver: true }));

  assert.equal(fixCalls, 1, "empty re-gate findings stop before a second fixer");
  assert.equal(receipt.roundsRun, 1);
  assert.equal(receipt.gatesCleared, false);
  assert.equal(receipt.deliveryEligible, false);
  assert.equal(receipt.delivered, null);
  assert.ok(logs.some((line) => line.includes("stopping fixer loop")));
});

test("execution: null diagnose verdict is a failure — no fix round, no delivery", async () => {
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return null;
    return "ok";
  };
  const { receipt, logs } = await runWith(stubAgent, baseArgs({ deliver: true }));

  assert.equal(receipt.gatesCleared, false, "null diagnose => not cleared");
  assert.equal(receipt.roundsRun, 0, "no fix round run for null verdict");
  assert.equal(receipt.visualVerifyRan, false);
  assert.equal(receipt.visualVerifyPassed, null);
  assert.equal(receipt.deliveryEligible, false, "null diagnose => not eligible");
  assert.equal(receipt.delivered, null, "delivery skipped after null diagnose");
  assert.ok(
    logs.some((l) => l.includes("diagnose verdict was null/malformed")),
    "null-diagnose skip reason logged",
  );
});

test("execution: malformed diagnose verdict (wrong shape) is a failure", async () => {
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return { passed: "yes", findings: "not-an-array" };
    return "ok";
  };
  const { receipt } = await runWith(stubAgent, baseArgs({ deliver: true }));

  assert.equal(receipt.gatesCleared, false, "malformed diagnose => not cleared");
  assert.equal(receipt.roundsRun, 0, "no fix round for malformed verdict");
  assert.equal(receipt.deliveryEligible, false);
  assert.equal(receipt.delivered, null, "delivery skipped after malformed diagnose");
});

test("execution: null re-gate verdict stops before another fixer round", async () => {
  let fixCalls = 0;
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return RED_VERDICT;
    if (/FIX agent/.test(prompt)) {
      fixCalls++;
      return "fixed";
    }
    if (/RE-GATE runner/.test(prompt)) return null;
    return "ok";
  };
  const { receipt, logs } = await runWith(stubAgent, baseArgs({ maxRounds: 2, deliver: true }));

  assert.equal(fixCalls, 1, "malformed re-gate cannot authorize another mutating pass");
  assert.equal(receipt.gatesCleared, false, "null re-gate => not cleared");
  assert.equal(receipt.roundsRun, 1, "fix loop stops after the null re-gate");
  assert.equal(receipt.visualVerifyRan, false, "gates red => visual skipped");
  assert.equal(receipt.deliveryEligible, false);
  assert.equal(receipt.delivered, null, "delivery skipped after null re-gate");
  assert.ok(logs.some((line) => line.includes("verdict null/malformed — stopping fixer loop")));
});

test("execution: null visual verdict blocks delivery even when gates cleared", async () => {
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return CLEAN_VERDICT;
    if (/VISUAL VERIFY/.test(prompt)) return null;
    if (/DELIVER agent/.test(prompt)) return DELIVER_OK;
    return "ok";
  };
  const { receipt, logs } = await runWith(stubAgent, baseArgs({ deliver: true }));

  assert.equal(receipt.gatesCleared, true, "gates cleared");
  assert.equal(receipt.visualVerifyRan, true, "visual agent ran");
  assert.equal(receipt.visualVerifyPassed, null, "null visual verdict => null (not true)");
  assert.equal(receipt.deliveryEligible, false, "null visual => not eligible");
  assert.equal(receipt.delivered, null, "delivery skipped after null visual verdict");
  assert.ok(
    logs.some((l) => l.includes("verdict null/malformed — treating as not-passed")),
    "null visual logged as not-passed",
  );
});

test("execution: string-wrapped verdict (prose around JSON object) parses correctly", async () => {
  const stubAgent = async (prompt: string) => {
    if (/GATE-DIAGNOSE/.test(prompt)) return `Gates report: ${JSON.stringify(CLEAN_VERDICT)} — done.`;
    if (/VISUAL VERIFY/.test(prompt)) return `Visual: ${JSON.stringify(VISUAL_PASS)}`;
    return "ok";
  };
  const { receipt } = await runWith(stubAgent, baseArgs({ deliver: false }));

  assert.equal(receipt.gatesCleared, true, "string-wrapped clean verdict parses");
  assert.equal(receipt.visualVerifyRan, true);
  assert.equal(receipt.visualVerifyPassed, true, "string-wrapped visual pass parses");
});
