# Engine ⇄ repo-artifact compatibility

Repos pin harness artifacts locally (`.pi/workflows/harnesses/<id>.json` descriptors + thin in-repo workflow scripts), but the engine (`pi-dynamic-workflows`) loads at whatever version is installed. This document defines the compatibility discipline so a saved harness does not break silently when the engine floats.

## Two guards, one shape

| Guard | What it protects | Mechanism |
|---|---|---|
| `schemaVersion` | **Data shape** of the descriptor | `parseHarnessConfigDescriptor` accepts only `DEFAULT_SUPPORTED_SCHEMA_VERSIONS`; mismatched descriptors **warn + skip**, never crash. |
| `engine.min` | **Engine behavior** the descriptor relies on | Optional `engine: { "min": "<semver>" }` on the descriptor; on load, if the running engine is older than `min` → **warn + skip**. Mirrors the `schemaVersion` gate. |

Both guards are advisory (warn + skip), not hard failures: a repo with an incompatible harness stays usable; only that one harness is skipped.

## Discipline rule (binding)

- **Additive-only in minors.** New descriptor fields, new `harness_config` ids, new `harness_type` values, and new schema-version *entries* may be added in a minor release.
- **Rename / remove / breaking-shape change only at a major bump**, paired with a `schemaVersion` bump. Old `schemaVersion` values move into `DEFAULT_DEPRECATED_SCHEMA_VERSIONS` first (loader warns, keeps loading) and are dropped only at the next major.
- `engine.min` is a **floor**, not a ceiling. Descriptors should declare the oldest engine that still supports the behavior they rely on; the running engine skips only when it is *older* than the floor.

## schemaVersion range

`loadHarnessConfigRegistry` accepts `supportedSchemaVersions` (range) and `deprecatedSchemaVersions` (subset that still loads with a warning). Defaults: supported `[1]`, deprecated `[]`. A future v2 is added to `supported` first; v1 moves to `deprecated`; v1 is dropped only at a major bump.

## `validate-harness` smoke gate

`src/validate-harness.ts` exposes a load+parse path that resolves the config, checks required fields + `schemaVersion` + `engine.min` floor + (when referenced) parses the linked workflow script — **without executing agents**. Use it:

- in repo CI, over `.pi/workflows/harnesses/*.json`;
- as a post-engine-upgrade smoke (after bumping `pi-dynamic-workflows`, run it across dependent repos' harnesses to catch silent breakage before a real run).

Programmatic: `validateHarnessFile(path, { engineVersion })` → `{ ok, findings }`. CLI: `runValidateHarness([paths])` → `{ exitCode, report }` (non-zero on any error).

## Reference

- Worked example: `kneutral-admin-portal/.pi/workflows/harnesses/portal-visual-refine.json` (schemaVersion 1; would declare `engine.min`).
- Issue: #82. Parent epic: #57. Sibling: #83 (repo bootstrapping guide).