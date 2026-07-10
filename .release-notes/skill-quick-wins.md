# Skill Quick Wins — Issue Delivery 0.2.2

## Why

Bounded quick wins for Issue Delivery: prompt-guidance hardening and
`/deep-research` safety. This release includes behavioral source changes —
`/deep-research` is now artifact-first (no false success) and the
`foundation_ui_compliance` template dropped its unenforceable trace-assert.

## Changes

### Source

- **src/workflow-tool.ts**: 4 new prompt-guidance principles injected via
  `buildPromptGuidelines()` (facts-vs-decisions, HITL-AFK checkpoint,
  expand-contract for wide refactors, tautological-test guidance).
  `checkpoint()` listed in available globals.

- **src/issue-delivery.ts**: The Thinker recognizes wide mechanical migrations
  and plans expand → independently green caller batches → contract. The
  Verifier treats a detected tautological test oracle as blocking even if a
  model also returns `passed=true`.

- **src/deep-research.ts**: Primary-source-first Gather/Verify prompts and
  recursively strict schemas. Questions, angles, `minSupport`, aggregate
  evidence, claims, URLs, and summaries are bounded for worst-case four-byte
  Unicode. Empty pages do not consume source slots, overlong URLs are rejected
  rather than truncated, and the verifier selects opaque Gather source IDs
  instead of rewriting URLs. At most 3 supported claims reach the final result,
  whose UTF-8 payload remains below 10KB. No agent receives `write`.

- **src/builtin-commands.ts**: `/deep-research` uses read-only coding tools plus
  `web_search`/`web_fetch`. The host rejects private/non-public targets,
  re-fetches retained HTTP(S) citations, drops failed/empty responses,
  flattens/escapes retained claims, derives the chat summary from retained cited
  evidence, and writes `report.md` inside a fresh private OS temporary
  directory. It does not semantically fact-check claims.

### Tests

- **tests/foundation-ui-compliance.test.ts** (new): parse/static checks plus
  clean, repaired, red, malformed, null, contradictory, and visual-failure
  execution paths. Failed or contradictory gate/visual verdicts cannot deliver.

- **tests/workflow-tool.test.ts**: asserts the four new model-facing guidelines.

- **tests/builtin-workflows.test.ts**: verifies primary-source wording, strict
  schemas, question/angle/fan-in limits, and sub-10KB prompts/results at maxima.

- **tests/builtin-commands.test.ts**: verifies read-only tool policy, overlong
  question rejection, cited artifact delivery, uncited/no-result rejection,
  writer failure, and summary clamping.

### Docs

- **docs/prompt-guidance-style.md**: 4 new principles added (Principle /
  Anti-pattern / Say-this-not-that format).
- **AGENTS.md**: `.fugu/` corrected from "ignored by finalization" to "fully
  retired — leftover debris blocks finalization".
- **.codex/agents/pr-reviewer.toml**: finalization-ignore mentions only
  `.issue-delivery/`.
- **.release-notes/fastcontext.md**: `.fastcontext/` retained in `.gitignore`.

### Lock

- **docs/workflows/workflow-lock.json**: `generatedAt` → `2026-07-09`,
  issue-delivery version → `0.2.2`, deep-research `sha256` updated,
  foundation-ui-compliance note updated (no trace-assert, run receipt).

## Verification

- `npm run check` — 0 errors
- `npm run build` — clean
- `npm run check:workflow-lock` — 0 errors
- `npm test` — all tests pass

## Note

The user-level grilling and writing-great-skills sync is already completed
(e.g., negation-only rule), not a cross-repo issue.
