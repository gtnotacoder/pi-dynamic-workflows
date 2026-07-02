# Changelog

All notable changes to **`pi-dynamic-workflows-oc-style`** — originally derived from
[`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows) (MIT).
Only changes from upstream are listed here; upstream history is preserved in git.
See [PROVENANCE.md](./PROVENANCE.md) for the derivation history and upstream relationship.

## [Unreleased]

### Removed

- Remove `docs/2.0-roadmap.md` — a stale pre-fork upstream planning artifact (upstream implemented and deleted it in their own tree); it misled planning sessions into treating upstream's completed backlog as ours. (#97)
- Remove `docs/fugu-test.md`, the naming-migration compatibility pointer; `docs/issue-delivery-smoke-test.md` is the canonical page. (#97)

### Changed

- Reposition PROVENANCE/README/CHANGELOG upstream language: the projects have diverged and upstream is now a read-only idea source (reviewed ~quarterly, concepts ported as issues — never diffs). Records the 2026-07-02 review of upstream v2.10.0 (one portable fix → #98). Stale test counts refreshed. (#97)

### Added

- Add the workflow authoring global `dag([{ id, dependsOn?, run }])` for dependency-aware fan-out. It runs dependency-ready nodes in deterministic waves for resume-safe `agent()` call ordering, validates duplicate/missing/cyclic dependencies, cascade-skips dependents of failed nodes, and lets independent branches continue.
- Add a run-level `loopGuard` option that detects repeated identical `agent()` calls. The default is warn-only; `{ action: "abort" }` hard-stops runaway workflow loops.
- `WorkflowSettings.defaultWorkflowTimeoutMs` (number | null) for a configurable run-wide wall-clock timeout default, normalized like `defaultAgentTimeoutMs` (`null` disables, positive finite numbers are retained, invalid/zero/negative values are dropped, absent keeps the runtime constant).
- Thread the settings default through `WorkflowManager` (`WorkflowManagerOptions.defaultWorkflowTimeoutMs`), the `workflow` tool, saved slash-command execution, and `/workflows resume`. Effective timeout precedence per run: `exec.workflowTimeoutMs` → the run's captured/persisted value → the manager/settings default → `undefined` (runtime `DEFAULT_WORKFLOW_TIMEOUT_MS`). The effective value is persisted so resumed runs keep their original explicit/settings timeout; old persisted runs without the field keep using the runtime constant. (Closes #10, part 1)

## [0.1.3] — 2026-06-22

### Added

- Add `/adversarial-review --evidence` as an opt-in source-ledger mode on the existing command.
- Support no-key evidence components: `web_fetch`, GitHub URLs/files via `web_fetch`, and optional best-effort `web_search` discovery.
- Add `/adversarial-review` options for reviewer count and agreement threshold.
- Let `WorkflowManager` receive per-run tool sets so background/managed slash workflows can inject evidence tools only when requested.

### Fixed

- Make built-in and saved slash workflows start through the shared `WorkflowManager` so `/workflows`, the task panel, transcripts, and final result delivery stay live instead of appearing frozen.

### Documentation

- Document `/adversarial-review` flags, evidence components, aliases, and release status.

## [0.1.2] — 2026-06-22

### Security / hardening

- Document the trusted-code workflow security model: Node `vm` is a determinism realm, not a sandbox for untrusted workflow scripts.
- Add workflow run ID validation before persistence, lease, resume, delete, transcript, and run-state path joins.
- Include resolved context primitives in resume journal hashes so `legacy` output cannot replay under `focused` or a changed project mode.
- Add an async workflow wall-clock timeout for suspended scripts and make per-agent timeouts abort and settle before limiter/worktree release.
- Make `/code-review` use read-only tools and host-computed structured git argv/patch data instead of model-produced command strings.
- Ship security and provenance docs in the npm package.

## [0.1.1] — 2026-06-22

### Fixed

- Require the exact `workflow-run` editor trigger phrase for rainbow/workflows mode; ordinary `workflow` / `workflows` text no longer auto-arms workflow execution.
- Keep the model-facing tool name as `workflow` for compatibility.
- Update the workflows-mode forcing prompt to require a concise final synthesis after the `workflow` tool returns, preventing blank final assistant messages.
- Make worktree tests independent of local git commit hooks in temporary repositories.

### Documentation

- Add `docs/issues.md` as the local issue tracker index for migrated/cross-repo issues.
- Update README command/help text and status to 827/827 tests.

## [0.1.0] — first standalone release (derived from upstream v2.7.0)

Originally derived from `@quintinshaw/pi-dynamic-workflows` v2.6.0 (`622f6df`),
aligned to upstream v2.7.0. All changes below are on top of that.

### Workflow engine (EDITs 1–2)

- Cap `parallel()` / `pipeline()` fan-out at 4096 items. (`9a65cb4`)
- Cap workflow script body at 524,288 bytes and `runInContext` timeout at 30,000 ms. (`b41d89a`)

### Built-in `code-review` (EDIT 4 + routing)

- Add built-in `/code-review` workflow with an effort-parameterized topology (scope → find → verify → sweep → synthesize). (`5f720d5`)
- Add the code-review angle prompts (correctness/cleanup angles, verdict ladder). (`ff604c9`)
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

- Add per-subagent context governance: `inheritProjectContext` / `systemPromptMode` (`append`|`replace`) / `inheritSkills`, selected via named modes or per-field overrides, the `/modes` command, and `--mode` on the bundled commands. (`50fe3e9`)
- **Redesign around main-agent rule leakage (OpenCode model).** Add the `inheritMainRules` primitive governing the main-agent append channel (`.pi/APPEND_SYSTEM.md`) — verified that subagents previously inherited it, leaking orchestration-only rules. New default mode **`focused`** keeps shared `AGENTS.md` + skills but blocks the main-rules channel (`appendSystemPrompt:[]`); `legacy` (alias `inherit`) restores full inheritance byte-identically. Modes renamed (`focused`/`isolated`/`scoped`/`legacy`); built-in names reserved from project overrides. 825/825 unit tests.

### Documentation

- Document context modes in the README + `docs/context-modes.md` (the four prompt channels, the main-rules model, verified behavior). (EDIT 7)
- Add PROVENANCE + fork banner. (`dbece49`)
- Note v2.7.0 upstream tracking and the edit-branch forward-merge. (`6d9116d`)
- Simplify the README to a fork pointer and consolidate edits into `main`. (`799aeb9`)
- Document commands, the authoring API, and model routing. (`2d34e34`)

### Merges (branch consolidation)

- `94649f0` — merge `origin/main` into `edit2/script-size-timeout-cap`.
- `0b53731` — merge `edit2/script-size-timeout-cap` into `main`.
