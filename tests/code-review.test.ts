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

test("code-review Find phase fans out one agent per angle in parallel", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /phase\('Find'\)/);
  assert.match(body, /parallel\(ANGLES\.map/);
  assert.match(body, /P\.perAngle/);
});

test("code-review Verify phase runs one verifier per finding", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /phase\('Verify'\)/);
  assert.match(body, /parallel\(rawFindings\.map/);
});

test("code-review Sweep phase is gated on P.sweep (xhigh/max only)", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /if \(P\.sweep\)/);
  assert.match(body, /phase\('Sweep'\)/);
  assert.match(body, /\.slice\(0, SWEEP_MAX\)/);
});

test("code-review Synthesize merges duplicates and caps at maxFindings", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /phase\('Synthesize'\)/);
  assert.match(body, /merge SEMANTIC duplicates/);
  assert.match(body, /cap at ' \+ P\.maxFindings/);
  assert.match(body, /CONFIRMED before PLAUSIBLE/);
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
 * Mock agent that returns canned, deterministic results keyed on the agent label
 * so the workflow exercises the full Scope→Find→Verify→(Sweep)→Synthesize topology
 * without calling a model. Find agents return `perAngle` findings each; verifiers
 * REFUTE every other finding so the REFUTED exclusion path is exercised.
 */
function mockReviewer(level: "high" | "xhigh" | "max") {
  const perAngle = level === "high" ? 6 : 8;
  let sweepCalled = false;
  const phases: string[] = [];
  return {
    state: { sweepCalled: () => sweepCalled, phases: () => phases },
    runner: {
      async run(_prompt: string, options: { label?: string }) {
        const label = options.label ?? "";
        if (label === "scope") return { files: ["src/a.ts", "src/b.ts"], diffSummary: "changed a,b" };
        if (label.startsWith("find ")) {
          // `perAngle` findings per angle agent.
          const findings = Array.from({ length: perAngle }, (_, k) => ({
            location: `src/a.ts:${k + 1}`,
            severity: k === 0 ? "high" : "low",
            description: `${label} finding ${k + 1}`,
          }));
          return { findings };
        }
        if (label.startsWith("verify ")) {
          // REFUTE every even-numbered finding (by the trailing .N) to exercise
          // the REFUTED exclusion path; CONFIRM the odd ones.
          const n = Number.parseInt(label.split(".").pop() ?? "1", 10);
          const verdict = n % 2 === 0 ? "REFUTED" : "CONFIRMED";
          return { verdict, reason: `mock ${verdict}` };
        }
        if (label === "sweep") {
          sweepCalled = true;
          return {
            findings: Array.from({ length: 3 }, (_, k) => ({
              location: `src/b.ts:${k + 1}`,
              severity: "medium",
              description: `sweep finding ${k + 1}`,
            })),
          };
        }
        if (label === "synthesize") return "MOCK CODE REVIEW REPORT";
        return "ok";
      },
    },
  };
}

test("code-review high run: ≤10 findings, every survivor has a CONFIRMED/PLAUSIBLE verdict, REFUTED excluded", async () => {
  const mock = mockReviewer("high");
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    cwd: "/tmp",
    args: "high",
    agent: mock.runner,
    persistLogs: false,
    onPhase: (t) => mock.state.phases().push(t),
  });
  const r = result.result as {
    level: string;
    surviving: Array<{ verdict: string }>;
    refutedCount: number;
    maxFindings: number;
    sweep: boolean;
    report: string;
  };
  assert.equal(r.level, "high");
  assert.equal(r.maxFindings, 10);
  assert.equal(r.sweep, false);
  // Every surviving finding must carry a CONFIRMED or PLAUSIBLE verdict (no REFUTED leaks).
  for (const f of r.surviving)
    assert.ok(f.verdict === "CONFIRMED" || f.verdict === "PLAUSIBLE", `bad verdict ${f.verdict}`);
  assert.equal(r.report, "MOCK CODE REVIEW REPORT");
  // high = 3 correctness + 5 cleanup = 8 angles × 6 findings = 48 raw; half REFUTED.
  assert.equal(r.refutedCount, 24);
  assert.equal(r.surviving.length, 24);
  // Sweep phase must NOT run at the high level.
  assert.equal(mock.state.sweepCalled(), false);
  // Phase order matches Claude's topology.
  assert.deepEqual(mock.state.phases(), ["Scope", "Find", "Verify", "Synthesize"]);
});

test("code-review xhigh run: sweep phase runs and adds ≤8 findings", async () => {
  const mock = mockReviewer("xhigh");
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    cwd: "/tmp",
    args: "xhigh main..HEAD",
    agent: mock.runner,
    persistLogs: false,
    onPhase: (t) => mock.state.phases().push(t),
  });
  const r = result.result as {
    level: string;
    target: string;
    surviving: Array<{ id: string; verdict: string }>;
    maxFindings: number;
    sweep: boolean;
  };
  assert.equal(r.level, "xhigh");
  assert.equal(r.target, "main..HEAD");
  assert.equal(r.maxFindings, 15);
  assert.equal(r.sweep, true);
  // xhigh = 5 correctness + 5 cleanup = 10 angles × 8 findings = 80 raw; half REFUTED → 40 surviving + 3 sweep.
  assert.equal(r.surviving.length, 43);
  // Sweep findings carry the sweep.<n> id and a PLAUSIBLE verdict.
  const sweepFindings = r.surviving.filter((f) => f.id.startsWith("sweep."));
  assert.equal(sweepFindings.length, 3);
  for (const f of sweepFindings) assert.equal(f.verdict, "PLAUSIBLE");
  assert.equal(mock.state.sweepCalled(), true);
  assert.deepEqual(mock.state.phases(), ["Scope", "Find", "Verify", "Sweep", "Synthesize"]);
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
  const r = result.result as { level: string; target: string };
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
  const r = result.result as { level: string; target: string };
  // "constructor" is on Object.prototype but not an own property of LEVEL_PARAMS,
  // so it must NOT parse as a level — defaults to "high" and the whole string is the target.
  assert.equal(r.level, "high");
  assert.equal(r.target, "constructor src/x.ts");
});
