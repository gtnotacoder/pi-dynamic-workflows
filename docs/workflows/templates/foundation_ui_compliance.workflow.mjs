// foundation_ui_compliance.workflow.mjs — CANONICAL ENGINE BLUEPRINT
//
// The one frontend-delivery loop for apps built on a vendored design-system
// foundation: Gate-Diagnose → scoped
// Fix ↔ Re-gate → frontier visual verify → Deliver (opt-in) → Trace-assert.
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
    "Foundation UI delivery engine: run the foundation gate entrypoint to diagnose, apply scoped fixes, re-gate each round, frontier-judge a fresh screenshot, then optionally deliver a PR — with a trace-assert that the judge was frontier-tier and fixers stayed in editScope.",
  phases: [
    { title: "Gate-Diagnose" },
    { title: "Fix <-> Re-gate loop" },
    { title: "Visual verify" },
    { title: "Deliver" },
    { title: "Trace-assert" },
  ],
};

// ---- args (the workflow tool may deliver args as a JSON string) ----
let A = {};
try {
  A = typeof args === "string" ? JSON.parse(args || "{}") : args || {};
} catch (err) {
  throw new Error(`args must be valid JSON: ${err && err.message ? err.message : err}`);
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

// =====================================================================
phase("Gate-Diagnose");

const diagnose = await agent(
  [
    "You are the GATE-DIAGNOSE runner for the foundation UI compliance engine.",
    `Run: ${GATE_ENV}${GATE} --json`,
    "(If the rendered gate needs a served build, build+serve first per the app README; skip --url gates only if serving is impossible and say so.)",
    "",
    "From the JSON output, produce a MUST-FIX list: one item per violation with",
    "{ id, gate, file/probe, detail, fix-hint }. Read the foundation rule docs",
    `(${foundation}/docs/compliance-validator.md, ${foundation}/docs/proportion-contract.md)`,
    "for any rule you don't recognize before writing fix-hints.",
    "Report the must-fix JSON array. If every gate passed, report exactly: CLEAN.",
  ].join("\n"),
  { label: "gate-diagnose", contextMode: "focused", readOnly: true, inheritMainRules: false, tier: "big" },
);

if (/\bCLEAN\b/.test(diagnose) && !/must-fix/i.test(diagnose)) {
  log("Gates are green — nothing to fix.");
} else {
  // ===================================================================
  phase("Fix <-> Re-gate loop");
  let outstanding = diagnose;
  let cleared = false;

  for (let round = 1; round <= maxRounds; round++) {
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
    log(`fix round ${round}: ${String(fix).slice(0, 300)}`);

    const regate = await agent(
      [
        "You are the RE-GATE runner. Run the single gate entrypoint and report:",
        `${GATE_ENV}${GATE} --json`,
        "If summary.failed is 0, end with the exact token: ALL-CLEAR.",
        "Otherwise report the remaining must-fix items (same shape as before).",
      ].join("\n"),
      {
        label: `regate-round-${round}`,
        contextMode: "focused",
        readOnly: true,
        inheritMainRules: false,
        tier: "medium",
      },
    );
    if (/\bALL-CLEAR\b/.test(regate)) {
      cleared = true;
      break;
    }
    outstanding = regate;
  }
  if (!cleared) log(`maxRounds (${maxRounds}) reached with gates still red — surfacing for human review.`);

  // ===================================================================
  phase("Visual verify");
  if (urls.length > 0) {
    const verify = await agent(
      [
        "You are the VISUAL VERIFY judge (frontier tier — never a cheap model).",
        `Re-run the rendered gate with screenshots: ${GATE_ENV}${GATE} --shot-dir /tmp/foundation-ui-verify --json`,
        "READ the PNGs it saves. Judge with your eyes, not the numbers alone:",
        "proportion (text fits its boxes), hierarchy, spacing rhythm, token fidelity, no visual regressions vs the app's canon.",
        "Report PASS or a list of visual defects with pixel evidence.",
      ].join("\n"),
      { label: "visual-verify", contextMode: "focused", readOnly: true, inheritMainRules: false, tier: "big" },
    );
    log(`visual verify: ${String(verify).slice(0, 400)}`);
  } else {
    log("No urls provided — skipping visual verify (static + build gates only).");
  }

  // ===================================================================
  phase("Deliver");
  if (deliver) {
    const delivered = await agent(
      [
        "You are the DELIVER agent.",
        `1. Final gate run must pass: ${GATE_ENV}${GATE}`,
        "2. Commit ONLY files inside the allow globs on the CURRENT branch; push; open/update a PR with the repo's canonical PR template.",
        "Report branch, sha, PR url.",
      ].join("\n"),
      { label: "deliver", contextMode: "focused", inheritMainRules: false, tier: "medium" },
    );
    log(`deliver: ${String(delivered).slice(0, 300)}`);
  } else {
    log("deliver=false — leaving changes for human review.");
  }
}

// =====================================================================
phase("Trace-assert");
const trace = await agent(
  [
    "You are the TRACE-ASSERT auditor. Read this run's subagent transcripts and ASSERT:",
    "  A. gate-diagnose and visual-verify ran on frontier-tier models.",
    `  B. Fix agents modified ONLY paths matching: ${editAllow.join(", ")} and touched none of: ${editDeny.join(", ")}.`,
    "  C. Every fix round was followed by a re-gate through run-foundation-gates.mjs (the single entrypoint).",
    "Report PASS/FAIL per assertion with evidence.",
  ].join("\n"),
  { label: "trace-assert", contextMode: "focused", readOnly: true, inheritMainRules: false, tier: "medium" },
);
log(`trace-assert: ${String(trace).slice(0, 500)}`);
log("foundation_ui_compliance complete.");
