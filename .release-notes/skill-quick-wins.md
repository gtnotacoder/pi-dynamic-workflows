# Workflow quick wins — 0.2.2

## Why

Ship a small set of reusable workflow-authoring improvements without expanding
the release into unrelated workflow redesigns.

## Changes

### Prompt guidance

- Separate observed facts from human decisions.
- Make consequential `checkpoint()` calls AFK-safe with an explicit
  conservative default or `headless: "abort"`.
- Use expand → migrate → contract only for wide mechanical refactors; ordinary
  feature and bug work remains thin vertical slices.
- Require independent test oracles rather than tautological expectations.
- List `checkpoint(promptText, options?)` among the available workflow globals.

### Issue Delivery

- Teach the Thinker the bounded expand-contract planning exception.
- Make tautological tests a blocking Verifier result even when a model also
  returns `passed: true`.

### Documentation and drift cleanup

- Add concrete anti-patterns and corrected examples to
  `docs/prompt-guidance-style.md`.
- Remove the stale README table of initial derivation patches; `CHANGELOG.md`
  and `PROVENANCE.md` remain authoritative.
- Correct `.fugu/` finalization guidance and retain `.fastcontext/` only as
  defensive third-party-output hygiene.

## Scope

The `/deep-research` and `foundation_ui_compliance` redesigns were explicitly
removed from this release. Their broader concerns are tracked in
[#122](https://github.com/gtnotacoder/pi-dynamic-workflows/issues/122) and
[#123](https://github.com/gtnotacoder/pi-dynamic-workflows/issues/123) rather
than bundled into these quick wins.

## Required gate

- `npm test`
- `npm run check:workflow-lock`
