/**
 * Built-in `code-review` workflow — Claude Code's effort-parameterized multi-angle review.
 *
 * Topology + level parameters are verbatim from claude.exe 2.1.185's `.bun` section
 * (see cc-pi/notes/builtin-code-review.js): Scope → Find (one agent per review angle,
 * `perAngle` findings each) → Verify (one independent verifier per finding, verdict ladder)
 * → Sweep (xhigh/max only, ≤8 gap-filling findings) → Synthesize (merge semantic dupes,
 * cap at `maxFindings`, highest-severity/CONFIRMED first).
 *
 * The prompt-fragment constants (`CORRECTNESS_ANGLES`, `CLEANUP_ANGLES`, `VERDICT_LADDER`,
 * `SWEEP_GAP_FOCUS`) are RUNTIME-INJECTED in Claude and ship as 0xFF placeholders in the
 * static bundle, so their exact text is unrecoverable. The constants below are
 * RECONSTRUCTED plausible angle prompts — the structure, caps, phase order, and verdict
 * ladder match Claude exactly; the per-angle wording is ours. Frame tests against
 * topology + caps, not byte-identical findings.
 *
 * Level parameters (verified):
 *   high  = 3 correctness + 5 cleanup angles, ≤6 per angle, ≤10 findings, no sweep
 *   xhigh = 5 correctness + 5 cleanup angles, ≤8 per angle, ≤15 findings, sweep of ≤8
 *   max   = same as xhigh
 *
 * The generated script is static and reads its inputs from the `args` string at runtime
 * (mirroring Claude's own arg parsing, including the own-property level check so
 * `Object.prototype` keys like "constructor" never parse as a level) — no string
 * interpolation of user input into source, so there are no escaping hazards.
 */

/** Claude's verified level parameters (own-property check protects the level parse). */
const LEVEL_PARAMS: Record<
  string,
  { correctnessAngles: number; perAngle: number; maxFindings: number; sweep: boolean }
> = {
  high: { correctnessAngles: 3, perAngle: 6, maxFindings: 10, sweep: false },
  xhigh: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
  max: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
};

/** Max findings the sweep phase may add (xhigh/max only). */
const SWEEP_MAX = 8;

/**
 * Reconstructed correctness review angles (Claude injects these at runtime; text is ours).
 * Ordered so `high` (first 3) gets the highest-signal angles and `xhigh`/`max` get all 5.
 */
const CORRECTNESS_ANGLES = [
  "null dereferences, uninitialized reads, and use-before-init / use-after-free",
  "off-by-one and boundary errors: loop bounds, slice/splice ranges, inclusive vs exclusive endpoints",
  "error handling and resource management: swallowed errors, unchecked results, leaked handles/files/connections",
  "concurrency and ordering hazards: races, deadlocks, missing locks, event-order assumptions",
  "API misuse and contract violations: wrong argument order/types, ignored return values, invalid state transitions",
];

/** Reconstructed cleanup review angles (always all 5). Text is ours. */
const CLEANUP_ANGLES = [
  "dead code: unreachable branches, unused variables/imports, commented-out blocks",
  "naming and clarity: misleading or inconsistent names, stale or wrong comments",
  "duplication: copy-pasted logic that should be factored into a shared helper",
  "complexity: deeply nested conditionals, overlong functions, unclear control flow",
  "type safety: unchecked any/unknown casts, missing null checks the types permit, unsafe narrowing",
];

/** Verifier verdict ladder — exactly the three Claude uses. */
const VERDICT_LADDER = ["CONFIRMED", "PLAUSIBLE", "REFUTED"];

/** Focus prompt for the sweep (gap-filling) phase. */
const SWEEP_GAP_FOCUS =
  "cross-file interactions, integration assumptions, ordering across modules, and whole-change gaps that a single per-angle pass cannot see";

/**
 * Generate a `code-review` workflow script matching Claude's topology.
 *
 * The script reads its level + target from the `args` string at runtime:
 *   `<level> <target>` where level ∈ {high, xhigh, max} (default `high`).
 * `target` is a git range (e.g. `main..HEAD`), a path, or empty for uncommitted changes.
 */
export function generateCodeReviewWorkflow(): string {
  return `export const meta = {
  name: 'code-review',
  description: 'Multi-angle code review with independent verification and synthesis',
  whenToUse: 'Review uncommitted/branch changes for correctness bugs and cleanup findings',
  phases: [
    { title: 'Scope' },
    { title: 'Find' },
    { title: 'Verify' },
    { title: 'Sweep' },
    { title: 'Synthesize' },
  ],
}

const LEVEL_PARAMS = ${JSON.stringify(LEVEL_PARAMS)}
const SWEEP_MAX = ${SWEEP_MAX}
const CORRECTNESS_ANGLES = ${JSON.stringify(CORRECTNESS_ANGLES)}
const CLEANUP_ANGLES = ${JSON.stringify(CLEANUP_ANGLES)}
const VERDICT_LADDER = ${JSON.stringify(VERDICT_LADDER)}
const SWEEP_GAP_FOCUS = ${JSON.stringify(SWEEP_GAP_FOCUS)}

const RAW_ARGS = (typeof args === "string" ? args : "").trim()
const FIRST = RAW_ARGS.split(/\\s+/)[0] || ""
// Own-property check so Object.prototype keys ("constructor", "toString") never parse as a level.
const FIRST_IS_LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, FIRST)
const LEVEL = FIRST_IS_LEVEL ? FIRST : "high"
const TARGET = FIRST_IS_LEVEL ? RAW_ARGS.slice(FIRST.length).trim() : RAW_ARGS
const P = LEVEL_PARAMS[LEVEL]
const ANGLES = CORRECTNESS_ANGLES.slice(0, P.correctnessAngles).concat(CLEANUP_ANGLES)
const CONTEXT = TARGET || "uncommitted/working-tree changes"

phase('Scope')
const scope = await agent(
  'You are scoping a code review. Identify the exact files and changes to review.\\n' +
  'TARGET (git range, path, or empty for uncommitted changes): ' + TARGET + '\\n' +
  'Use git to list the changed files and capture a concise diff summary (one line per file). ' +
  'If TARGET is empty, review uncommitted/working-tree changes (git status + git diff). ' +
  'Return the file list and a short diff summary.',
  { label: 'scope', schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, diffSummary: { type: 'string' } }, required: ['files'] } }
)
const files = (scope && scope.files) || []
const diffSummary = (scope && scope.diffSummary) || ''

phase('Find')
const perAngle = await parallel(ANGLES.map((angle, i) => () =>
  agent(
    'You are a code reviewer focused on ONE review angle only.\\n' +
    'ANGLE: ' + angle + '\\n' +
    'Review the changed files below for issues on THIS angle. Report at most ' + P.perAngle + ' concrete, individually-checkable findings. ' +
    'Each finding must cite a specific file:line location. Skip if there are none on this angle.\\n' +
    'FILES:\\n' + JSON.stringify(files) + '\\n' +
    (diffSummary ? 'DIFF SUMMARY:\\n' + diffSummary + '\\n' : ''),
    { label: 'find ' + (i + 1), schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { location: { type: 'string' }, severity: { type: 'string' }, description: { type: 'string' } }, required: ['location', 'description'] } } }, required: ['findings'] } }
  )
))
const rawFindings = perAngle.filter(Boolean).flatMap((a, ai) =>
  ((a && a.findings) || []).map((f, fi) => ({ id: (ai + 1) + '.' + (fi + 1), location: f.location, severity: f.severity, description: f.description }))
)

phase('Verify')
const verified = await parallel(rawFindings.map((f) => () =>
  agent(
    'You are an INDEPENDENT verifier. Do not trust the claim below — read the cited code and decide for yourself.\\n' +
    'Return a verdict from exactly one of: ' + JSON.stringify(VERDICT_LADDER) + '.\\n' +
    'CONFIRMED = the issue is real and reproducible from the code shown. ' +
    'PLAUSIBLE = likely real but not certain without more context. ' +
    'REFUTED = not a real issue / false positive.\\n' +
    'FINDING JSON:\\n' + JSON.stringify(f),
    { label: 'verify ' + f.id, schema: { type: 'object', properties: { verdict: { type: 'string', enum: VERDICT_LADDER }, reason: { type: 'string' } }, required: ['verdict'] } }
  )
))
const judged = rawFindings.map((f, i) => ({
  ...f,
  verdict: (verified[i] && verified[i].verdict) || 'REFUTED',
  reason: (verified[i] && verified[i].reason) || '',
}))
const surviving = judged.filter((j) => j.verdict === 'CONFIRMED' || j.verdict === 'PLAUSIBLE')
const refutedCount = judged.length - surviving.length

let swept = []
if (P.sweep) {
  phase('Sweep')
  const sweep = await agent(
    'You are the final sweeper. The angles above already produced the surviving findings below. ' +
    'Find up to ' + SWEEP_MAX + ' ADDITIONAL issues they likely missed. Focus on ' + SWEEP_GAP_FOCUS + '.\\n' +
    'Do not repeat findings already listed. Each must cite a specific file:line location.\\n' +
    'SURVIVING FINDINGS JSON:\\n' + JSON.stringify(surviving),
    { label: 'sweep', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { location: { type: 'string' }, severity: { type: 'string' }, description: { type: 'string' } }, required: ['location', 'description'] } } }, required: ['findings'] } }
  )
  swept = ((sweep && sweep.findings) || []).slice(0, SWEEP_MAX).map((f, i) => ({
    id: 'sweep.' + (i + 1), location: f.location, severity: f.severity, description: f.description, verdict: 'PLAUSIBLE',
  }))
}
const allSurviving = surviving.concat(swept)

phase('Synthesize')
const report = await agent(
  'Write the final code review report.\\n' +
  'Rules: (1) merge SEMANTIC duplicates among the findings below (same root cause/location); ' +
  '(2) cap at ' + P.maxFindings + ' distinct findings, highest severity and CONFIRMED before PLAUSIBLE; ' +
  '(3) for each finding give: location, severity, verdict (CONFIRMED/PLAUSIBLE), and a one-line description; ' +
  '(4) note how many raw findings were discarded as REFUTED (' + refutedCount + ').\\n' +
  'CONTEXT: ' + CONTEXT + '\\n' +
  'SURVIVING FINDINGS JSON:\\n' + JSON.stringify(allSurviving),
  { label: 'synthesize' }
)

return {
  level: LEVEL,
  target: TARGET,
  context: CONTEXT,
  files,
  rawFindingCount: rawFindings.length,
  surviving: allSurviving,
  refutedCount,
  maxFindings: P.maxFindings,
  sweep: P.sweep,
  report,
}`;
}
