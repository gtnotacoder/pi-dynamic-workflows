# Plan — Issue #82: Repo-artifact ⇄ engine compatibility (engine.min floor + schemaVersion range + validate-harness gate)

Part of #57. Independent of naming/contract work. Surfaced while building the first real southbound harness (admin-portal UI visual-refine).

## Problem
Repos pin harness artifacts locally (`.pi/workflows/harnesses/*.json` + a workflow script), but Pi loads the engine at whatever version is installed. If the engine floats and a schema field/API changes, every repo's saved harness can break on load — a silent cross-repo failure.

## What already protects us (keep)
- `schemaVersion` gate in `src/harness-config.ts` — mismatched descriptors warn + skip, not crash.
- Deprecation discipline already practiced (`profile→id`, `harness→harness_type`, `/fugu→/issue-delivery`, `inherit→legacy`).

## Scope (in) — minimal path
1. **Engine-compat floor.** Optional `"engine": { "min": "<semver>" }` on the harness descriptor **and** workflow `meta`. On load, compare engine version; if below floor → warn + skip (mirror the `schemaVersion` behavior). Guards engine behavior the way `schemaVersion` guards data shape.
2. **schemaVersion range, not a point.** Accept a supported range (e.g. `1..N`) with a deprecation warning on the old one; only drop an old version at a major bump.
3. **`validate-harness` smoke gate.** A load+parse path that resolves the config, `parseWorkflowScript`, checks required fields + schemaVersion + engine floor + referenced tools/paths — **without executing agents**. Run in repo CI and as a post-engine-upgrade smoke. Expose as a function (e.g. `validateHarness(path)`) + a thin CLI/command entry.
4. **Written discipline rule.** Additive-only in minors; rename/remove only at a major with a `schemaVersion` bump.

## Acceptance criteria (from issue)
- [ ] Descriptor + workflow meta accept optional `engine.min`; below-floor load warns + skips (test).
- [ ] Loader accepts a schemaVersion range with a deprecation warning on the old one (test).
- [ ] `validate-harness` returns non-zero on a broken/incompatible descriptor without spawning agents (test).
- [ ] Docs note the additive-only minor / major-bump-to-remove rule.

## Verifiable signal
`tests/harness-engine-compat.test.ts`: below-floor skip; range accept + deprecation warning; `validateHarness` non-zero on broken descriptor, zero on valid, no agents spawned.

## Files
- `src/harness-config.ts` (engine.min + schemaVersion range)
- `src/workflow.ts` or `src/parse-workflow-script` location (meta.engine.min) — extend the meta parser if needed
- `src/validate-harness.ts` (new) + CLI/command registration
- `tests/harness-engine-compat.test.ts` (new)
- `docs/` (discipline rule note)

## Check command
```bash
npm run check && npm run build && npm run test:unit -- tests/harness-engine-compat.test.ts
```

## Reference example
`kneutral-admin-portal/.pi/workflows/harnesses/portal-visual-refine.json` (schemaVersion 1; would declare `engine.min`).