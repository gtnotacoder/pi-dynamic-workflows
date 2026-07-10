# Repo harness bootstrapping guide

> **Status:** Reference — describes current shipped behavior.

How to onboard a repo as a **southbound Pi harness** — the canonical, repeatable "add a Pi harness to a repo" guide. As we add new repos with custom UI/UX treatment (e.g. `desktop-app`, same pattern as `kneutral-admin-portal`), each repo's harness is set up the same way and stays engine-compatible.

This is the control-plane counterpart to [harness-engine-compat.md](./harness-engine-compat.md) (which defines the `schemaVersion`/`engine.min` compatibility discipline). Read that first.

## Mental model

A harness is **two artifacts the repo pins locally** plus the engine that runs them:

| Layer | Lives in | Owns |
|---|---|---|
| Descriptor (control plane) | repo: `.pi/workflows/harnesses/<id>.json` | data shape, capability bundle, context/isolation profiles, tiered model pools, gates, `engine.min` |
| Workflow script (thin) | repo: a thin in-repo script (or a saved workflow) | the orchestration verbs; kept minimal |
| Engine | installed `pi-dynamic-workflows` | the `agent()` / `parallel()` / `gate()` / `stageCheck()` runtime, harness expansion, read-only fence |

**Fat config, thin script.** Put as much as possible in the descriptor (declarative, versioned, `validate-harness`-checkable). Keep the workflow script a thin orchestration shell — it should call `agent()` / `gate()` / `stageCheck()` and almost nothing else. The smaller the engine-API surface the script uses, the less it breaks when the engine floats. A script that reaches into engine internals or re-implements harness policy defeats the point.

## Repo-local layout

```
<repo>/
  .pi/workflows/harnesses/<id>.json     # the descriptor (control plane)
  .pi/workflows/<id>.js                 # thin in-repo workflow script — OR a saved
                                        # workflow under ~/.pi/workflows/saved/<id>.json
                                        # with an INLINE `script` string (a saved workflow
                                        # is a JSON object with `script` as a string, NOT a
                                        # path reference to a .js file)
  docs/<area>-development.md            # human-readable anchor doc (the "why")
```

- The **descriptor** is the source of truth for what the harness does. It is JSON, schema-versioned, and linted by `validate-harness`.
- `triggerRules.pathPrefixes` / `triggerRules.importPatterns` are the signals the auto-selector reads. **`labels` are metadata-only** (the selector deliberately does not read labels) — keep them as documentation, not a routing signal.
- The **anchor doc** (e.g. `docs/ui-development.md`) is the human-readable companion: the UX rules, the file/path conventions the harness encodes, and the reason the harness exists. The descriptor's `trigger`/`triggerRules` and `displayName`/`description` are the machine-readable echo of this doc.

## Descriptor essentials

```jsonc
{
  "schemaVersion": 1,
  "id": "portal-visual-refine",
  "harness_type": "pi",
  "displayName": "Portal visual-refine",
  "description": "UI/UX refinement harness for the admin portal frontend.",
  "engine": { "min": "0.1.7" },

  "trigger": "manual",
  "triggerRules": {
    "pathPrefixes": ["components/ui/", "src/components/ui/", "app/"]
  },

  "tools": ["read", "grep", "find", "ls", "ctx_read", "ctx_grep", "ctx_find", "ctx_ls"],
  "disallowedTools": [],

  "contextMode": "focused",
  "inheritProjectContext": true,
  "inheritSkills": true,
  "inheritMainRules": false,
  "systemPromptMode": "append",

  "componentExtensions": [".tsx", ".jsx"],
  "indexExtensions": [".ts", ".tsx", ".js", ".jsx"],
  "directoryModuleSelfFile": true,
  "frontendPathTriggers": ["components/ui/", "src/components/ui/"],

  "stageCheck": { "cwd": "packages/web", "targetFile": null }
}
```

> **`targetFile` semantics:** `targetFile: null` (or omitted) means biome checks the entire `cwd`; set it to a specific file to scope the check.

### `schemaVersion` + `engine.min`

- `schemaVersion` (data shape) and `engine.min` (engine behavior) are the two compatibility guards — see [harness-engine-compat.md](./harness-engine-compat.md). Set `engine.min` to the oldest engine that supports the behavior this descriptor relies on. Both are advisory: a below-floor/incompatible descriptor is **warned + skipped** on load (and `validate-harness` flags it), never crashes the run.

### `harness_type`

The runtime axis: `pi` (wired), `opencode` / `hermes` (placeholders, not wired). A descriptor whose runtime is not wired clean-skips on load and per-call selection (the engine throws `HARNESS_NOT_WIRED` for a per-call selection of an unwired runtime rather than running under the wrong harness).

### Per-role context / isolation profiles

A harness selects a posture for its agents via the context/inheritance fields. Compose them deliberately — they are the isolation fence:

| Field | What it controls | Typical for a UI harness |
|---|---|---|
| `contextMode` | built-in posture (`focused`/`isolated`/`scoped`/`legacy`) | `focused` (shared project context + skills) |
| `inheritProjectContext` | load project AGENTS.md / context files | `true` |
| `inheritSkills` | load skills into subagents | `true` |
| `inheritMainRules` | inherit the main-agent append channel | `false` (no leak) |
| `systemPromptMode` | `append` (role as task) vs `replace` (role IS system prompt) | `append` |
| `readOnly` (run-level / per-call) | strip write-capable tools — the authority fence | `true` for reviewers; `false` for workers |

`readOnly` is the **authority fence**: `expandHarnessConfig` filters `WRITE_TOOL_NAMES` under `readOnly`, applied AFTER allow/deny so a `tools` allowlist can never re-grant a write tool. A per-call `readOnly` is narrow-only (a call may add the fence, not lift a run-level one). **Use `readOnly` for a hard authority fence** — a `tools` allowlist alone is not a fence.

**Tool policy — narrow-only by default, with one explicit exception.** When a call supplies an explicit `agent(..., { tools: [...] })`/`disallowedTools`, that override **wins** (it is part of the resume call-hash, so widening a single call is intentional and safe). When no explicit per-call tools are supplied, the resolved tool set is the **intersection** of the agentType and harness allowlists (denylists unioned); a disjoint intersection yields deny-all (`applyToolPolicy` treats an explicit empty allowlist as no-tools, not "all tools"). So a per-step config may only **select/narrow** the run-level harness authority unless the script explicitly widens a call.

### Tiered model slots

Model routing lives in the **machine-local** `~/.pi/workflows/model-tiers.json`, not the descriptor — descriptors stay portable. The config shape today is `tiers: Record<string, string>` (one model id per tier: `small`, `medium`, `big`); **per-tier fallback chains are not yet supported**. The workflow script assigns `tier: "small"|"medium"|"big"` per role — fanout workers on a cheap/local `small`/`medium` tier, judges/verifiers on a `big` (frontier) tier — and the run resolves each tier to its configured model. (Multi-model fallback pools are a planned addition; track via an engine issue, not the descriptor.)

### Gates and receipts

Use `gate(workerThunk, validator, { attempts })` for the repair loop (worker → host `stageCheck` → feedback). `stageCheck` runs **host-side mechanical checks with zero LLM tokens**: auto-detected defaults are `tsc --noEmit` (if `tsconfig.json` AND `package.json` exist) + `biome check` (if `biome.json` AND `package.json` exist and `targetFile` is null or has a supported extension); a repo `build` script is **NOT auto-added** — supply it explicitly via `stageCheck.commands`. Defaults otherwise come from the descriptor's `stageCheck` block (package `cwd`, `targetFile`). For a per-step harness, pass the step's `harness_config` to `stageCheck` so checks run in the step's package, not the run-level default.

**Trace-assert (planned, not yet shipped):** asserting telemetry spans/events from inside a workflow script (e.g. that a UI worker consulted the anchor doc / guardrail) is not yet an exposed API — the sandbox globals do not include a trace reader. Until it ships, encode the read-path guardrail via the descriptor's `componentExtensions`/`frontendPathTriggers` (enforced by the harness expansion) rather than a runtime trace assertion. Track the trace-assert capability via an engine issue.

## The "fat config, thin script" rule (binding)

- ✅ Descriptor: `contextMode`, `tools`, `stageCheck`, `componentExtensions`, `frontendPathTriggers`, `engine.min`, `triggerRules`.
- ✅ Script: `agent(...)`, `parallel(...)`, `gate(...)`, `stageCheck({ targetFile, harness_config })`, `phase(...)`, `log(...)`, `return`.
- ❌ Script: reaching into `expandHarnessConfig` / the registry directly, re-implementing tool policy, hardcoding model ids (use tiers), importing engine internals.

If you find the script needing engine internals, that's a signal the descriptor is missing a field (add it, with a `schemaVersion`-compatible addition) or the engine lacks a capability (file an engine issue).

## `validate-harness` + CI wiring

`validate-harness` (shipped via the package entry point) loads + parses a descriptor and checks required fields, `schemaVersion`, the `engine.min` floor, and (when referenced) parses the linked workflow script — **without spawning agents**. Use it in repo CI and as a post-engine-upgrade smoke.

Programmatic:

```ts
import { validateHarnessFile, runValidateHarness } from "pi-dynamic-workflows-oc-style";
const result = validateHarnessFile(".pi/workflows/harnesses/portal-visual-refine.json", { engineVersion });
// result.ok === false → result.findings has the errors
```

CLI (the `validate-harness` bin ships with the package; exit non-zero on any error):

```sh
npx validate-harness .pi/workflows/harnesses/portal-visual-refine.json --script .pi/workflows/portal-visual-refine.js
```

CI snippet:

```yaml
- name: Validate harnesses
  run: |
    # Descriptor validation (every harness):
    npx validate-harness .pi/workflows/harnesses/*.json
    # Also validate each harness's linked thin script (descriptor-only validation skips it):
    npx validate-harness .pi/workflows/harnesses/portal-visual-refine.json --script .pi/workflows/portal-visual-refine.js
```

After bumping the engine across dependent repos, run `validate-harness` over each repo's harnesses to catch silent breakage before a real run.

## Onboarding checklist (per repo)

1. **Anchor doc** — write `docs/<area>-development.md` (the UX rules + file/path conventions).
2. **Descriptor** — add `.pi/workflows/harnesses/<id>.json` with the schema above; set `engine.min` to the current engine; encode the anchor doc's conventions in `triggerRules` + the guardrail fields.
3. **Thin script** — a minimal workflow script (or saved workflow) that orchestrates with `agent()`/`gate()`/`stageCheck()`.
4. **Model tiers** — ensure `workflows/model-tiers.json` maps each tier to one intended model; encode fallback/escalation explicitly in the script.
5. **CI** — wire `validate-harness` over `.pi/workflows/harnesses/*.json`.
6. **Dogfood** — run a `--prototype` issue-delivery lane against a small change to confirm the harness routes workers/verifiers correctly and `stageCheck` runs in the right package.
7. **Lock** — if the script is a built-in source, update `docs/workflows/workflow-lock.json` (`npm run check:workflow-lock`).

## Worked examples

- ✅ **`kneutral-admin-portal`** — `portal-visual-refine` UI harness (kneutral-admin-portal#195). The sophisticated first case: a frontend harness with a shadcn directory-module guardrail, package-local `stageCheck.cwd`, and prompt-level edit-scope guardrails (trace-assert is planned, not yet shipped). This guide is the generalization of that setup.
- ⏳ **`desktop-app`** — the next consumer; onboarded via this guide to confirm the standard generalizes. Tracked as the second proof.

## Reference

- [harness-engine-compat.md](./harness-engine-compat.md) — `schemaVersion`/`engine.min` discipline.
- `src/harness-config.ts` — descriptor schema + `expandHarnessConfig` (the fence + guardrail expansion).
- `src/validate-harness.ts` — the smoke gate.
- `docs/workflows/catalog.md` + `docs/workflows/workflow-lock.json` — workflow command/lock contract.
- Issue #83; parent epic #57; relates to #29 (admin-portal trace hardening) and #63 (naming).
