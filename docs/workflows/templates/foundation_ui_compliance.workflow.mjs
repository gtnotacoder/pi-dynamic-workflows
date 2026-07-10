// foundation_ui_compliance.workflow.mjs — CANONICAL ENGINE BLUEPRINT
//
// The one frontend-delivery loop for apps built on a vendored design-system
// foundation: Gate-Diagnose → scoped
// Fix ↔ Re-gate → frontier visual verify → Deliver (opt-in) → Receipt.
// See docs/agent-workflows.md for the ownership model and hard rules.
//
// This file is a TEMPLATE maintained in the foundation so the loop shape and
// the gate contract stay next to the rules they enforce. Install it as a
// saved workflow (pi-dynamic-workflows catalog) or copy into an app's
// .pi/workflows/. App specifics arrive as ARGS — this file contains NO
// app-specific values.
//
// GATE CONTRACT (Rule 2, docs/agent-workflows.md): all gates run through the
// single entrypoint run-foundation-gates.mjs in the app's VENDORED foundation
// (third_party/frontend-foundation). Never enumerate individual gate scripts
// here — the foundation owns the gate list, which is how foundation changes
// (new themes, new canon, new gates) propagate with zero workflow edits.
//
// args (JSON):
//   appSrc      app source tree relative to repo root (e.g. "web-next/src")   REQUIRED
//   foundation  vendored foundation dir (default "third_party/frontend-foundation")
//   buildCmd    app build/typecheck gate (e.g. "pnpm --dir web-next build")
//   urls        array of served-app URLs for the rendered gate + screenshots
//   loginUrl    optional auth pre-step URL (PROPORTIONS_LOGIN_URL)
//   editAllow   fix-agent allow globs (e.g. ["web-next/src/**"])              REQUIRED
//   editDeny    fix-agent deny globs (always includes third_party/** below)
//   maxRounds   Fix ↔ Re-gate cap (default 2)
//   deliver     commit + PR when true (default false)

export const meta = {
  name: "foundation_ui_compliance",
  description:
    "Foundation UI delivery engine: run the foundation gate entrypoint to diagnose, apply scoped fixes, re-gate each round, frontier-judge a fresh screenshot, then optionally deliver a PR. Edit scope (editAllow/editDeny) is prompt-level guidance; re-gating checks resulting UI compliance, not which paths were edited. The run emits a verifiable gate-receipt log (no transcript-backed trace-assert — the runtime exposes no trace API).",
  phases: [
    { title: "Gate-Diagnose" },
    { title: "Fix <-> Re-gate loop" },
    { title: "Visual verify" },
    { title: "Deliver" },
    { title: "Receipt" },
  ],
};

// ---- args (the workflow tool may deliver args as a JSON string) ----
let A = {};
try {
  A = typeof args === "string" ? JSON.parse(args || "{}") : args || {};
} catch (err) {
  throw new Error(`args must be valid JSON: ${err?.message ? err.message : err}`);
}
const appSrc = String(A.appSrc || "");
if (!appSrc) throw new Error("args.appSrc is required (e.g. web-next/src)");
const foundation = String(A.foundation || "third_party/frontend-foundation");
const buildCmd = A.buildCmd ? String(A.buildCmd) : null;
const urls = Array.isArray(A.urls) ? A.urls.map(String) : [];
const loginUrl = A.loginUrl ? String(A.loginUrl) : null;
const editAllow = Array.isArray(A.editAllow) ? A.editAllow.map(String) : [];
if (editAllow.length === 0) throw new Error("args.editAllow is required");
const editDeny = [
  ...new Set([
    ...(Array.isArray(A.editDeny) ? A.editDeny.map(String) : []),
    "third_party/**",
    ".github/**",
    "vendor/**",
  ]),
];
const maxRounds = Number(A.maxRounds || 2);
const deliver = A.deliver === true || String(A.deliver) === "true";

// The ONE gate command (Rule 2). Rendered gate joins automatically when urls are provided.
const GATE = [
  `node ${foundation}/scripts/run-foundation-gates.mjs --app-src ${appSrc}`,
  buildCmd ? ` --build-cmd "${buildCmd}"` : "",
  urls.map((u) => ` --url ${u}`).join(""),
].join("");
const GATE_ENV = loginUrl ? `PROPORTIONS_LOGIN_URL=${loginUrl} ` : "";

// ---- verdict parsing (strict structured verdicts) ----
// Gate-Diagnose and each Re-gate MUST return {passed:boolean, findings:[]};
// Visual Verify MUST return {passed:boolean, defects:[]}. null or any malformed
// verdict (missing/wrong-typed passed, or non-array findings/defects) is treated
// as a FAILURE — never as a pass. Agent results may arrive as objects or as
// strings (the latter wrapped in prose), so a string is parsed for the first
// JSON object before shape validation.
function asObject(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  return null;
}

function parseGateVerdict(result) {
  const o = asObject(result);
  if (!o || typeof o.passed !== "boolean" || !Array.isArray(o.findings)) return null;
  // A contradictory "pass with findings" is a failure, never a clean gate.
  return { passed: o.passed === true && o.findings.length === 0, findings: o.findings };
}

function parseVisualVerdict(result) {
  const o = asObject(result);
  if (!o || typeof o.passed !== "boolean" || !Array.isArray(o.defects)) return null;
  // A contradictory "pass with defects" is a failure, never a visual pass.
  return { passed: o.passed === true && o.defects.length === 0, defects: o.defects };
}

// =====================================================================
phase("Gate-Diagnose");

const diagnose = await agent(
  [
    "You are the GATE-DIAGNOSE runner for the foundation UI compliance engine.",
    `Run: ${GATE_ENV}${GATE} --json`,
    "(If the rendered gate needs a served build, build+serve first per the app README; skip --url gates only if serving is impossible and say so.)",
    "",
    "Read the foundation rule docs for any rule you don't recognize before writing fix-hints:",
    `${foundation}/docs/compliance-validator.md, ${foundation}/docs/proportion-contract.md`,
    "",
    "Return a STRICT structured verdict object and nothing else, shaped exactly:",
    '{"passed":boolean,"findings":[...]}',
    "passed=true ONLY when every gate passed with zero violations. Otherwise passed=false with one findings item per violation:",
    '{"id","gate","file","detail","fix-hint"}.',
    "findings MUST be a bounded JSON array (empty when passed=true). Do not return prose, tokens like CLEAN, or any other shape.",
  ].join("\n"),
  { label: "gate-diagnose", contextMode: "focused", readOnly: true, inheritMainRules: false, tier: "big" },
);

// Run state: gatesCleared is set ONLY when a gate verdict has passed===true.
// A null/malformed diagnose verdict is a FAILURE (gatesCleared=false, no fix
// round — there are no actionable findings). visualVerifyRan tracks whether the
// visual-verify agent actually ran; visualVerifyPassed is null until the visual
// phase sets it (null when not required/not run, true only on a passing verdict).
// Tier arrays are built from phases that actually ran.
const diagnoseVerdict = parseGateVerdict(diagnose);
let gatesCleared = diagnoseVerdict !== null && diagnoseVerdict.passed === true;
let lastRound = 0;
let visualVerifyRan = false;
let visualVerifyPassed = null;
let delivered = null;
const frontierTiers = ["gate-diagnose:big"];
const fixTiers = [];

// Every declared phase is entered exactly once, logging skip reasons when skipped.
// ===================================================================
phase("Fix <-> Re-gate loop");
if (gatesCleared) {
  log("Skipping: gates are green from initial diagnose — no fix rounds needed.");
} else if (diagnoseVerdict === null) {
  log("Skipping: diagnose verdict was null/malformed — no actionable findings to fix.");
} else {
  // Seed the fix agent with the JSON findings from the diagnose verdict so it has
  // a concrete, bounded list to resolve each round.
  let outstanding = JSON.stringify(diagnoseVerdict.findings);

  for (let round = 1; round <= maxRounds; round++) {
    lastRound = round;
    log(`--- round ${round}/${maxRounds} ---`);

    const fix = await agent(
      [
        "You are the FIX agent. Resolve the must-fix items below.",
        "",
        outstanding,
        "",
        "Rules:",
        `- Edit ONLY: ${editAllow.join(", ")}`,
        `- NEVER touch: ${editDeny.join(", ")} (the vendored foundation updates only via resync PR — never here)`,
        `- Consult the foundation canon in ${foundation}/docs/ (styling guideline, proportion contract, block map) BEFORE inventing a fix.`,
        "- Semantic tokens only; type ramp only (no text-[Npx]); no density levers.",
        "Report each file changed and why.",
      ].join("\n"),
      { label: `fix-round-${round}`, contextMode: "focused", inheritMainRules: false, tier: "medium" },
    );
    fixTiers.push(`fix-round-${round}:medium`);
    log(`fix round ${round}: ${String(fix).slice(0, 300)}`);

    const regate = await agent(
      [
        "You are the RE-GATE runner. Run the single gate entrypoint:",
        `${GATE_ENV}${GATE} --json`,
        "",
        "Return a STRICT structured verdict object and nothing else, shaped exactly:",
        '{"passed":boolean,"findings":[...]}',
        "passed=true ONLY when summary.failed is 0 (all gates green). Otherwise passed=false with one findings item per remaining violation.",
        "findings MUST be a bounded JSON array. Do not return prose, tokens like ALL-CLEAR, or any other shape.",
      ].join("\n"),
      {
        label: `regate-round-${round}`,
        contextMode: "focused",
        readOnly: true,
        inheritMainRules: false,
        tier: "medium",
      },
    );
    fixTiers.push(`regate-round-${round}:medium`);

    const regateVerdict = parseGateVerdict(regate);
    if (regateVerdict !== null && regateVerdict.passed === true) {
      gatesCleared = true;
      break;
    }
    // A null/malformed re-gate verdict is a FAILURE: do NOT clear gates, surface the
    // raw result so the human can see the malformed verdict, and keep looping.
    if (regateVerdict === null) {
      log(`re-gate round ${round}: verdict null/malformed — treating as failure.`);
      outstanding = String(regate);
    } else {
      outstanding = JSON.stringify(regateVerdict.findings);
    }
  }
  if (!gatesCleared) log(`maxRounds (${maxRounds}) reached with gates still red — surfacing for human review.`);
}

// ===================================================================
phase("Visual verify");
if (!gatesCleared) {
  log("Skipping: gates still red — visual verify cannot confirm compliance.");
} else if (urls.length > 0) {
  const verify = await agent(
    [
      "You are the VISUAL VERIFY judge (frontier tier — never a cheap model).",
      `Re-run the rendered gate with screenshots: ${GATE_ENV}${GATE} --shot-dir /tmp/foundation-ui-verify --json`,
      "READ the PNGs it saves. Judge with your eyes, not the numbers alone:",
      "proportion (text fits its boxes), hierarchy, spacing rhythm, token fidelity, no visual regressions vs the app's canon.",
      "",
      "Return a STRICT structured verdict object and nothing else, shaped exactly:",
      '{"passed":boolean,"defects":[...]}',
      "passed=true ONLY when there are no visual defects. Otherwise passed=false with a bounded defects array (each item: {area, defect, evidence}).",
      "defects MUST be a bounded JSON array (empty when passed=true). Do not return PASS/prose or any other shape.",
    ].join("\n"),
    { label: "visual-verify", contextMode: "focused", readOnly: true, inheritMainRules: false, tier: "big" },
  );
  frontierTiers.push("visual-verify:big");
  visualVerifyRan = true;
  const visualVerdict = parseVisualVerdict(verify);
  // null means malformed; false records a valid visual failure. Both block delivery.
  visualVerifyPassed = visualVerdict === null ? null : visualVerdict.passed;
  log(`visual verify: ${String(verify).slice(0, 400)}`);
  if (visualVerdict === null) {
    log("visual verify: verdict null/malformed — treating as not-passed.");
  }
} else {
  log("Skipping: no urls provided — static + build gates only.");
}

// ===================================================================
phase("Deliver");
// Delivery eligibility is strict: gates MUST be cleared, AND when URLs were
// provided the visual verify MUST have run AND passed===true; when no URLs
// were given the visual gate is not required. `deliver` must also be true.
// A gate failure, visual failure, null/malformed verdict, or not-run visual
// (with URLs) all block delivery — never deliver after a failure/null.
const deliveryEligible = gatesCleared && (urls.length === 0 ? true : visualVerifyPassed === true) && deliver;
if (!gatesCleared) {
  log("Skipping: gates still red — delivery blocked.");
} else if (urls.length > 0 && visualVerifyPassed !== true) {
  log("Skipping: visual verify failed/not-passed — delivery blocked.");
} else if (deliver) {
  delivered = await agent(
    [
      "You are the DELIVER agent.",
      `1. Final gate run must pass: ${GATE_ENV}${GATE}`,
      "2. Commit ONLY files inside the allow globs on the CURRENT branch; push; open/update a PR with the repo's canonical PR template.",
      "Report branch, sha, PR url.",
    ].join("\n"),
    { label: "deliver", contextMode: "focused", inheritMainRules: false, tier: "medium" },
  );
  fixTiers.push("deliver:medium");
  log(`deliver: ${String(delivered).slice(0, 300)}`);
} else {
  log("Skipping: deliver=false — leaving changes for human review.");
}

// =====================================================================
phase("Receipt");
// The workflow runtime does NOT expose subagent transcripts or a trace API to
// scripts, and it has no path-glob tool policy for agent() — so this engine
// does NOT claim a transcript-backed trace-assert or runtime-enforced edit
// scope. Instead it emits a verifiable RUN RECEIPT from in-workbook state:
// roundsRun (exact count), gatesCleared (true only when a gate verdict passed),
// visualVerifyRan (true only after the visual-verify agent ran),
// visualVerifyPassed (null when not run/malformed, false for a valid failure,
// true only on a passing verdict), deliveryEligible, delivered, the tiers each phase used, and
// the edit-scope globs the fixers were instructed to honor. editAllow/editDeny
// are prompt guidance; re-gating checks resulting UI compliance — it does NOT
// prove which paths were or were not edited. This is honest about what is and
// is not runtime-enforced.
const receipt = {
  editAllow,
  editDeny,
  roundsRun: lastRound,
  gatesCleared,
  visualVerifyRan,
  visualVerifyPassed,
  deliveryEligible,
  delivered,
  frontierTiers,
  fixTiers,
};
log(`RUN RECEIPT: ${JSON.stringify(receipt)}`);
log("foundation_ui_compliance complete.");
