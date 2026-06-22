# Changelog

All notable changes to **`@gtnotacoder/pi-dynamic-workflows`** — a patched fork of
[`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows) (MIT).
Only fork-only changes are listed here; upstream history is preserved in git.
See [PROVENANCE.md](./PROVENANCE.md) for the full edit table and fork point.

## [unreleased] — fork on upstream v2.7.0

Fork point: upstream `46faf18` (`chore(release): bump version to 2.7.0`).
All changes below are on top of that, 2026-06-21.

### Workflow engine (EDITs 1–2)
- Cap `parallel()` / `pipeline()` fan-out at 4096 items. (`9a65cb4`)
- Cap workflow script body at 524,288 bytes and `runInContext` timeout at 30,000 ms. (`b41d89a`)

### Built-in `code-review` (EDIT 4 + routing)
- Add built-in `/code-review` workflow with Claude's effort-parameterized topology (scope → find → verify → sweep → synthesize). (`5f720d5`)
- Port the verbatim Claude prompt fragments (correctness/cleanup angles, verdict ladder). (`ff604c9`)
- Run all review agents on the `big` tier (GPT/Codex); coding workers stay on `small` (local Qwen). (`9993056`, superseding `d7ee84a`)

### Task panel & notifications (EDITs 3, 5, 6 + hardening)
- Add per-subagent transcript logging (`ManagedRun.transcriptDir`) and `<task-notification>` XML delivery. (`b8ae522`)
- Polish the live progress panel and add the Claude concurrency floor. (`719bd27`)
- Surface an errored subagent's error message in the live panel. (`b65872c`)
- Harden errored-subagent error surfacing — 5 confirmed bugs fixed (code-point-safe truncation, first-line extraction, whitespace-only errors, shared `agentErrorText()` helper). (`3f22868`)
- Add a narrow-width regression test for the error-reason truncation fix. (`bd658a7`)
- Make chat the canonical workflow surface: `<recovery>` links transcript dir + run-state JSON with `file://` URIs on failure; `<usage><tool_uses>` now real (from agent history). (`f1b4cc8`)
- Address the Codex `/code-review` findings on the UI-fix commit. (`b3a981c`)

### Progress dedup (chat + panel)
- Suppress redundant foreground chat streaming when a UI task panel is showing live progress. (`5711204`)
- Address all 10 Codex `/code-review` findings: robust suppression gated on `manager.hasTaskPanel` (no-panel hosts keep the chat stream), guard the per-event recompute for inert displays, `ManagedRun.runStatePath` decoupled from transcript persistence, shared `runStateJsonPath` helper, cheap `hasActiveRuns()` for the idle timer. (`5fda282`)

### Context modes (EDIT 7 — feature)
- Add per-subagent context governance: `inheritProjectContext` / `systemPromptMode` (`append`|`replace`) / `inheritSkills`, selected via named modes (`inherit` / `isolated` / `scoped` / project-defined) or per-field overrides. Reachable from agent `.md` frontmatter, the `agent()` call, run-level `--mode`, and `contextModes` in workflow settings. Adds the `/modes` command and `--mode` on `/deep-research`, `/adversarial-review`, `/code-review`. Default `inherit` constructs no resource loader (backward-compat gate), so existing workflows are byte-identical. 13 files, +968/−12, 818/818 unit tests (43 new). (`50fe3e9`)

### Documentation
- Document context modes in the README + `docs/context-modes.md`. (EDIT 7)
- Add PROVENANCE + fork banner. (`dbece49`)
- Note v2.7.0 upstream tracking and the edit-branch forward-merge. (`6d9116d`)
- Simplify the README to a fork pointer and consolidate edits into `main`. (`799aeb9`)
- Document commands, the authoring API, model routing, and the Claude Code `.bun` RE derivation. (`2d34e34`)

### Merges (branch consolidation)
- `94649f0` — merge `origin/main` into `edit2/script-size-timeout-cap`.
- `0b53731` — merge `edit2/script-size-timeout-cap` into `main`.