# Plan — Issue #87: Enforce engine.min floor in the production run path

Follow-up from #82 (PR #86). Bounded; continues engine-compat work.

## Scope
1. **Explicit below-floor `--harness-config` clean-skip:** retain loader-skipped descriptors (e.g. a side-channel map of skipped ids → reason) so `runWorkflow` can detect an explicit `--harness-config <skipped-id>` and clean-skip (structured skip result) instead of silently falling back to `pi` defaults.
2. **Workflow `meta.engine.min` enforcement:** in `runWorkflow`, after `parseWorkflowScript`, read `meta.engine?.min` and `checkEngineFloor` against the running engine; if below, warn + clean-skip the whole run (mirror the validator's meta check).

## Files
- `src/harness-config.ts` (loadHarnessConfigRegistry: retain skipped descriptors)
- `src/workflow.ts` (explicit-config detection + meta.engine.min check)
- `tests/harness-engine-compat.test.ts` or a new `tests/workflow-engine-floor.test.ts`

## Acceptance
- [ ] Explicit `--harness-config <skipped-id>` clean-skips with the engine.min reason (no silent pi fallback).
- [ ] A workflow script with `meta.engine.min` above the running engine clean-skips on launch.
- [ ] Tests for both; no regression.

## Check
npm run check && npm run build && npm run test:unit -- tests/<targeted>
