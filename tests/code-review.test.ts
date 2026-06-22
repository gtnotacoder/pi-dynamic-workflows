import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinWorkflows } from "../src/builtin-commands.js";
import { generateCodeReviewWorkflow } from "../src/code-review.js";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";
import { makeCommandRegistryPi } from "./helpers/mock-pi.js";

// ─── Generator: structure & topology ────────────────────────────────────────────

test("generateCodeReviewWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateCodeReviewWorkflow());
  assert.equal(meta.name, "code-review");
  assert.equal(typeof meta.description, "string");
  // Claude's verified phase order: Scope → Find → Verify → Sweep → Synthesize.
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Scope", "Find", "Verify", "Sweep", "Synthesize"],
  );
  assert.match(body, /LEVEL_PARAMS/);
  assert.match(body, /hasOwnProperty\.call\(LEVEL_PARAMS/);
});

test("code-review embeds the verified level parameters", () => {
  const body = generateCodeReviewWorkflow();
  // high: 3 correctness angles, ≤6 per angle, ≤10 findings, no sweep.
  assert.match(body, /"high":\s*\{\s*"correctnessAngles":\s*3/);
  assert.match(body, /"high":\{[^}]*"perAngle":\s*6/);
  assert.match(body, /"high":\{[^}]*"maxFindings":\s*10/);
  assert.match(body, /"high":\{[^}]*"sweep":\s*false/);
  // xhigh/max: 5 correctness angles, ≤8 per angle, ≤15 findings, sweep.
  assert.match(body, /"xhigh":\{[^}]*"correctnessAngles":\s*5/);
  assert.match(body, /"max":\{[^}]*"correctnessAngles":\s*5/);
  assert.match(body, /"xhigh":\{[^}]*"maxFindings":\s*15/);
  assert.match(body, /"xhigh":\{[^}]*"sweep":\s*true/);
  assert.match(body, /SWEEP_MAX = 8/);
});

test("code-review script parses level + target from the args string", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /RAW_ARGS = \(typeof args === "string"/);
  assert.match(body, /FIRST_IS_LEVEL \? FIRST : "high"/);
  assert.match(body, /FIRST_IS_LEVEL \? RAW_ARGS\.slice\(FIRST\.length\)/);
});

test("code-review uses the verdict ladder CONFIRMED/PLAUSIBLE/REFUTED", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /"CONFIRMED"/);
  assert.match(body, /"PLAUSIBLE"/);
  assert.match(body, /"REFUTED"/);
});

// ─── Prompt content: the angle prompt fragments are embedded ──

test("code-review embeds the angle taxonomy (5 correctness + 5 cleanup)", () => {
  const body = generateCodeReviewWorkflow();
  // 5 correctness angles, labelled angle-A..angle-E (Claude's H$p mapping).
  for (const l of ["angle-A", "angle-B", "angle-C", "angle-D", "angle-E"]) {
    assert.match(body, new RegExp(`"label":\\s*"${l}"`), `missing correctness angle ${l}`);
  }
  // 5 cleanup angles: reuse / simplification / efficiency / altitude / conventions.
  for (const l of ["reuse", "simplification", "efficiency", "altitude", "conventions"]) {
    assert.match(body, new RegExp(`"label":\\s*"${l}"`), `missing cleanup angle ${l}`);
  }
});

test("code-review embeds the angle prompt text", () => {
  const body = generateCodeReviewWorkflow();
  // Distinctive substrings from each angle prompt.
  assert.match(body, /line-by-line diff scan/);
  assert.match(body, /removed-behavior auditor/);
  assert.match(body, /cross-file tracer/);
  assert.match(body, /language-pitfall specialist/);
  assert.match(body, /wrapper\/proxy correctness/);
  assert.match(body, /Re-implements something the codebase already has|re-implements something the codebase/i);
  assert.match(body, /unnecessary complexity the diff adds/);
  assert.match(body, /wasted work the diff introduces/);
  assert.match(body, /right depth, not as a fragile bandaid/);
  assert.match(body, /CLAUDE\.md files that govern the changed code/);
});

test("code-review embeds the verdict ladder + recall-bias + sweep focus", () => {
  const body = generateCodeReviewWorkflow();
  // VERDICT_LADDER definitions (Efo).
  assert.match(body, /can name the inputs\/state that trigger it/);
  assert.match(body, /mechanism is real, trigger is uncertain/);
  assert.match(body, /factually wrong \(code doesn't say that\)/);
  // VERDICT_LADDER_RECALL (Hfo) — PLAUSIBLE by default (markdown-bold `**REFUTED**`).
  assert.match(body, /PLAUSIBLE by default/);
  assert.match(body, /constructible from the code/);
  // CLEANUP_PRECEDENCE ($3t).
  assert.match(body, /Correctness bugs always outrank cleanup, altitude, and conventions/);
  // SWEEP_GAP_FOCUS (vfo).
  assert.match(body, /moved\/extracted code that dropped a guard/);
  assert.match(body, /setup\/teardown asymmetry in tests/);
});

test("code-review Find phase runs pipeline(FINDERS) with one finder per angle", () => {
  const body = generateCodeReviewWorkflow();
  // Find is entered via the agent `phase: "Find"` option (not a phase() call), and
  // finders fan out through pipeline(FINDERS, ...) — no barrier between finders.
  assert.match(body, /phase: "Find"/);
  assert.match(body, /pipeline\(\s*FINDERS/);
  assert.match(body, /P\.perAngle/);
  // FINDERS = correctness(0..P.correctnessAngles) + all 5 cleanup, tagged by kind.
  assert.match(body, /CORRECTNESS_ANGLES\.slice\(0, P\.correctnessAngles\)/);
  assert.match(body, /\.concat\(CLEANUP_ANGLES\.map/);
});

test("code-review Verify phase runs one verifier per candidate inside the pipeline", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /phase: "Verify"/);
  assert.match(body, /parallel\(result\.candidates\.map\(c => \(\) => verifyCandidate/);
  assert.match(body, /function verifyCandidate/);
});

test("code-review Sweep phase is gated on P.sweep (xhigh/max only)", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /if \(P\.sweep\)/);
  assert.match(body, /phase\("Sweep"\)/);
  assert.match(body, /\.slice\(0, SWEEP_MAX\)/);
  // Sweep candidates are themselves verified (sweepVerified), not trusted.
  assert.match(body, /parallel\(sliced\.map\(c => \(\) => verifyCandidate/);
});

test("code-review Synthesize ranks, merges by index, caps at maxFindings, backfills", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /phase\("Synthesize"\)/);
  // Correctness outranks cleanup; CONFIRMED outranks PLAUSIBLE.
  assert.match(body, /const rank = c => \(c\.kind === "cleanup" \? 2 : 0\)/);
  assert.match(body, /Correctness bugs always outrank cleanup findings/);
  assert.match(body, /Keep at most " \+ P\.maxFindings/);
  // Assembler: decisions by index, merge array, verdict escalation, backfill.
  assert.match(body, /Assembler invariants/);
  assert.match(body, /BY INDEX/);
  assert.match(body, /merged\.some\(m => m\.verdict === "CONFIRMED"\)/);
  assert.match(body, /additional verified finding/);
});

// ─── Command registration ───────────────────────────────────────────────────────

test("registerBuiltinWorkflows registers /code-review", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  const names = commands.map((c) => c.name);
  assert.ok(names.includes("code-review"));
  const cr = commands.find((c) => c.name === "code-review");
  assert.equal(typeof cr?.handler, "function");
});

test("/code-review is idempotent (alreadyRegistered guard)", () => {
  const { pi, commands } = makeCommandRegistryPi(["code-review"]);
  registerBuiltinWorkflows(pi, { cwd: "/tmp" });
  // Pre-registering code-review must skip it; the other two builtins may still register.
  assert.ok(!commands.some((c) => c.name === "code-review"));
});

// ─── Token-free run: topology + caps with a mock agent ───────────────────────────

/**
 * Mock agent that returns canned, deterministic results keyed on the agent label /
 * prompt so the workflow exercises the full Scope→Find→Verify→(Sweep)→Synthesize
 * topology without calling a model. Finders return `perAngle` candidates each; the
 * verifier verdict is derived from the candidate's `line` (odd → CONFIRMED, even →
 * REFUTED) so the REFUTED-exclusion path is exercised deterministically.
 */
function mockReviewer(level: "high" | "xhigh" | "max") {
  const perAngle = level === "high" ? 6 : 8;
  let sweepCalled = false;
  return {
    state: { sweepCalled: () => sweepCalled },
    runner: {
      async run(prompt: string, options: { label?: string }) {
        const label = options.label ?? "";
        if (label === "scope") {
          return {
            diffCommand: "git diff main...HEAD",
            files: ["src/a.ts", "src/b.ts"],
            summary: "changed a and b",
            claudeMdFiles: [],
            conventions: "",
          };
        }
        // Finder angles: correctness (angle-A..E) + cleanup (reuse/simplification/...).
        if (/^angle-[A-E]$/.test(label) || /^(reuse|simplification|efficiency|altitude|conventions)$/.test(label)) {
          return {
            candidates: Array.from({ length: perAngle }, (_, k) => ({
              file: "src/a.ts",
              line: k + 1,
              summary: `${label} finding ${k + 1}`,
              failure_scenario: "mock failure",
            })),
          };
        }
        if (label.startsWith("verify:")) {
          // Derive the candidate's line from the verifier prompt (VERIFIER_PROMPT
          // embeds `File: <file>:<line>`) and REFUTE even lines, CONFIRM odd ones.
          const m = prompt.match(/:\s*(\d+)\n/);
          const line = m ? Number.parseInt(m[1], 10) : 1;
          const verdict = line % 2 === 0 ? "REFUTED" : "CONFIRMED";
          return { verdict, evidence: `mock ${verdict}` };
        }
        if (label === "sweep") {
          sweepCalled = true;
          // Odd lines so all 3 survive verification (sweep candidates are verified too).
          return {
            candidates: Array.from({ length: 3 }, (_, k) => ({
              file: "src/b.ts",
              line: k * 2 + 1,
              summary: `sweep finding ${k + 1}`,
              failure_scenario: "mock sweep failure",
            })),
          };
        }
        if (label === "synthesize") {
          // Empty decisions → the assembler backfills from the ranked survivors up
          // to maxFindings, exercising the backfill + cap path.
          return { summary: "MOCK CODE REVIEW REPORT", decisions: [] };
        }
        return null;
      },
    },
  };
}

test("code-review high run: ≤10 findings, no REFUTED leaks, sweep skipped", async () => {
  const mock = mockReviewer("high");
  const phases: string[] = [];
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    cwd: "/tmp",
    args: "high",
    agent: mock.runner,
    persistLogs: false,
    onAgentStart: (e) => phases.push(e.phase ?? ""),
  });
  const r = result.result as {
    level: string;
    target?: string;
    summary: string;
    findings: Array<{ verdict: string }>;
    refuted: unknown[];
    stats: { finders: number; candidates: number; verified: number; refuted: number; reported: number };
  };
  assert.equal(r.level, "high");
  // high = 3 correctness + 5 cleanup = 8 finders × 6 candidates = 48; half REFUTED.
  assert.equal(r.stats.finders, 8);
  assert.equal(r.stats.candidates, 48);
  assert.equal(r.stats.verified, 48);
  assert.equal(r.stats.refuted, 24);
  // 24 survived → capped at maxFindings=10 via backfill.
  assert.equal(r.findings.length, 10);
  for (const f of r.findings) {
    assert.ok(f.verdict === "CONFIRMED" || f.verdict === "PLAUSIBLE", `bad verdict ${f.verdict}`);
  }
  // Sweep must NOT run at the high level.
  assert.equal(mock.state.sweepCalled(), false);
  // Phase order matches Claude's topology (Find/Verify entered via the agent phase option).
  assert.equal(phases[0], "Scope");
  assert.equal(phases.filter((p) => p === "Find").length, 8); // 3 correctness + 5 cleanup
  assert.equal(phases.filter((p) => p === "Verify").length, 48); // 8 finders × 6 candidates
  assert.equal(phases.at(-1), "Synthesize");
  assert.ok(!phases.includes("Sweep"), "no Sweep at high level");
});

test("code-review xhigh run: sweep runs, survivors + sweep capped at 15", async () => {
  const mock = mockReviewer("xhigh");
  const phases: string[] = [];
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    cwd: "/tmp",
    args: "xhigh main..HEAD",
    agent: mock.runner,
    persistLogs: false,
    onAgentStart: (e) => phases.push(e.phase ?? ""),
  });
  const r = result.result as {
    level: string;
    target: string;
    findings: Array<{ verdict: string }>;
    stats: { finders: number; candidates: number; verified: number; refuted: number; reported: number };
  };
  assert.equal(r.level, "xhigh");
  assert.equal(r.target, "main..HEAD");
  // xhigh = 5 correctness + 5 cleanup = 10 finders × 8 = 80; half REFUTED → 40 survive.
  assert.equal(r.stats.finders, 10);
  assert.equal(r.stats.candidates, 83); // 80 + 3 sweep
  assert.equal(r.stats.refuted, 40);
  // 40 + 3 sweep survivors = 43 → capped at maxFindings=15.
  assert.equal(r.findings.length, 15);
  for (const f of r.findings) {
    assert.ok(f.verdict === "CONFIRMED" || f.verdict === "PLAUSIBLE", `bad verdict ${f.verdict}`);
  }
  assert.equal(mock.state.sweepCalled(), true);
  assert.ok(phases.includes("Sweep"), "Sweep phase entered");
  assert.equal(phases.filter((p) => p === "Find").length, 10); // 5 correctness + 5 cleanup
  // 80 finder candidates + 3 sweep candidates, each verified → 83 Verify agents.
  assert.equal(phases.filter((p) => p === "Verify").length, 83);
});

test("code-review default level is high when the first token is not a known level", async () => {
  const mock = mockReviewer("high");
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    cwd: "/tmp",
    // "somepath" is not a level → defaults to high, target = "somepath".
    args: "somepath",
    agent: mock.runner,
    persistLogs: false,
  });
  const r = result.result as { level: string; target?: string };
  assert.equal(r.level, "high");
  assert.equal(r.target, "somepath");
});

test("code-review own-property check: 'constructor' does not parse as a level", async () => {
  const mock = mockReviewer("high");
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    cwd: "/tmp",
    args: "constructor src/x.ts",
    agent: mock.runner,
    persistLogs: false,
  });
  const r = result.result as { level: string; target?: string };
  // "constructor" is on Object.prototype but not an own property of LEVEL_PARAMS,
  // so it must NOT parse as a level — defaults to "high" and the whole string is the target.
  assert.equal(r.level, "high");
  assert.equal(r.target, "constructor src/x.ts");
});
