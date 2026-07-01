# Plan — Issue #64 (G): Leader per-step harness_type/harness_config selection

Part of EPIC #57. Depends on D (merged via #75). Parallel with E (merged). Closes nothing downstream but unblocks #65 (H).

## Goal
The leader (Thinker) decomposes work into a step DAG. Per the conductor→leader→worker model, the leader chooses each worker's `(harness_type, harness_config)` per task — the **per-call** precedence layer. Natural extension of the step schema in `src/issue-delivery.ts`.

## Scope (in)
- Extend the Thinker step schema (`THINKER_SCHEMA` in `src/issue-delivery.ts`) with optional `harness_type` + `harness_config` per step.
- Orchestrator passes them through to the worker: `agent(workerPrompt, { harness_type: step.harness_type, harness_config: step.harness_config })` — only when set; absent ⇒ inherits run-level selection (do not pass undefined).
- Thinker guidance (the `Guidelines for DAG mapping` block): infer `(harness_type, harness_config)` from the step's file/target (e.g. `components/ui/**` ⇒ `harness_type=pi`, `harness_config=frontend-react-shadcn`); default to the run-level selection when unset.
- Worker/Verifier inherit the resolved per-step harness_config; worker never re-selects.
- Read-only fence still holds per step: a step config may only select/narrow; it must not widen authority (enforced by `resolveHarnessLayers` per D — no new authority path here).

## Acceptance criteria (from issue)
- [ ] Thinker can emit `step.harness_type`/`step.harness_config`; absent ⇒ inherits run-level.
- [ ] Worker agent runs under the leader-selected harness_config (resolved via `resolveHarnessLayers` per-call layer).
- [ ] A mixed plan (one frontend step + one backend step) routes each worker to its own config (test).
- [ ] Read-only fence still holds per step (a step config cannot widen authority).

## Verifiable signal
`tests/issue-delivery-harness-config.test.ts`: a 2-step mixed plan resolves distinct per-step configs; default-inherit case green.

## Files
- `src/issue-delivery.ts` (step schema + thinker guidance + worker agent call)
- `tests/issue-delivery-harness-config.test.ts` (new)

## Check command
```bash
npm run check && npm run build && npm run test:unit -- tests/issue-delivery-harness-config.test.ts
```

## Notes
- Final external field spelling is blocked on dev-system #230; use the already-shipped tentative spelling (`harness_type`/`harness_config`). Add a pre-merge note linking #230 if any external contract is touched (this issue is internal, so no note required).