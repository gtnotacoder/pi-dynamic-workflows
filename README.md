# pi-dynamic-workflows-oc-style

**Dynamic multi-agent workflows for [Pi](https://pi.dev)** — fan a task out across
hundreds of subagents with model routing, token/cost accounting, resume,
git-worktree isolation, an interactive `/workflows` TUI, `/deep-research`, and
**OpenCode-style per-subagent context governance**: rules you put on the main
agent don't leak into the subagents it spawns (see [Context modes](#context-modes)).

> Independently maintained. Originally derived from [`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows) (MIT) and substantially extended; see [PROVENANCE.md](./PROVENANCE.md) for the relationship and how upstream is tracked.

- **Originally derived from:** [`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows) v2.6.0 (MIT), tracking v2.7.0
- **Security model:** workflow scripts are trusted code, not sandboxed; see [SECURITY.md](./SECURITY.md)
- **License:** MIT (see [LICENSE](./LICENSE))

---

## Install

Point Pi's agent settings at this checkout, build, and restart Pi:

```jsonc
// ~/.pi/agent/settings.json
{ "packages": [ "/path/to/this/repo" ] }
```

```bash
npm run build     # tsc -> dist/
npm test          # full gate: biome check . && build && unit tests
# then restart pi
```

If you also install `@amaster.ai/pi-telemetry`, list this package before it in
Pi settings. `pi-dynamic-workflows-oc-style` ships an early
`extensions/telemetry-scrub.ts` package extension that clears stale inherited
`PI_TELEMETRY_*` values before telemetry snapshots `process.env`; loading
telemetry first is unsupported because the stale values are already captured.

Optional Langfuse workflow tracing is enabled when `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY` are present. It emits workflow traces plus compaction
policy spans from the runtime API (`emitCompactionTelemetry`) and the local
autocompactor JSONL bridge (`~/.autocompactor/pi/stats/events.jsonl`). Payloads
and absolute run paths stay redacted unless `LANGFUSE_INCLUDE_PAYLOADS=true`.

---

## The `workflow` tool

The model-facing primitive. The tool name remains `workflow` for compatibility; only the editor auto-trigger phrase is now the exact `workflow-run` phrase so ordinary discussion of workflows does not auto-trigger orchestration. A workflow is a plain JavaScript string with a required `meta` header and at least one `agent()` call:

```js
export const meta = { name: 'research_topic', description: 'Cross-check a topic', phases: [{ title: 'Scope' }, { title: 'Synthesize' }] };

phase('Scope');
const findings = await parallel([
  () => agent('find sources for X', { label: 'scout-a', tier: 'small' }),
  () => agent('find sources for Y', { label: 'scout-b', tier: 'small' }),
]);

phase('Synthesize');
return await agent(`Synthesize: ${JSON.stringify(findings)}`, { label: 'synth', tier: 'big' });
```

- **Background by default** — the tool returns immediately with a run id; the result is delivered back into chat when the run finishes. Pass `background: false` to block inline.
- **Resume-safe** — every `agent()` call is journaled under a stable call sequence, so a run interrupted by a usage-limit checkpoint resumes without re-running finished agents.
- **Context-window aware** — finished agents record provider input/context tokens, model window, reserve/effective window, and occupancy. Runs log and persist visible warnings at 70/85/95% of the effective window, and `maxContextTokens` can hard-stop oversized agents before repeated huge prompts.
- **Bounded** — fan-out capped at 4096 items, script source at 512 KB, synchronous `runInContext` setup at 30 s, and async workflow runs by a wall-clock timeout.
- **Trusted-code execution** — Node `vm` is a determinism/authoring realm, **not** a security sandbox. Do not run unreviewed model-generated or third-party workflow scripts as untrusted input; see [SECURITY.md](./SECURITY.md).

### Authoring API (globals inside a script)

| Primitive | Purpose |
|-----------|---------|
| `agent(prompt, opts)` | Spawn one sub-agent. Returns its result (or `null` on recoverable failure). |
| `parallel(thunks)` | Fan-out. **Pass functions, not promises:** `items.map(x => () => agent(...))`. Results in input order; recoverable failures become `null`. |
| `pipeline(items, ...stages)` | Each item flows through stages sequentially; different items run concurrently. Stage gets `(prev, original, index)`. |
| `phase(title)` | Group agents under a phase (matches `meta.phases`). Optional `{ budget }` sub-budget. |
| `workflow(name, args)` | Run a saved workflow inline (one nesting level). |
| `args`, `cwd`, `budget` | Run inputs + `budget.remaining()` / `budget.total`. |
| `log(msg)` | Emit a progress log line. |
| `stageCheck(opts)` | Host-side mechanical checks (TypeScript `tsc --noEmit` and Biome when detected) with zero LLM tokens. |
| `compactFeedback(request)` / `renderCorrectionDelta(delta)` | Deterministically collapse retry feedback into a bounded, schema-validated Correction Delta for the next Worker turn. |
| `checkpoint(prompt, opts)` | Human-in-the-loop yes/no gate — deterministic, journaled, replayable (resume-safe). Maps to `ctx.ui.confirm` in a UI run; headless runs use the declared `headless` default. |

### Quality helpers

Most are built on `agent()`/`parallel()`. `retry()` and `gate()` are **generic thunk combinators** — they are agent-backed only if your thunk calls `agent()`; non-agent work in them is NOT journaled and will repeat on resume/retry.

| Helper | Signature | Returns |
|--------|-----------|---------|
| `verify(item, {reviewers=2, threshold=0.5, lens})` | Adversarial fact-check — N reviewers try to refute the claim. | `{ real, realCount, total, votes }` |
| `judgePanel(attempts, {judges=3, rubric})` | Score N candidates with a judge panel, pick the highest. | `{ index, attempt, score, judgments }` — read `.attempt` for the winning candidate |
| `loopUntilDry({round, key, consecutiveEmpty=2, maxRounds=50})` | Keep calling `round(i)` until rounds stop yielding fresh items. | `all[]` (deduped) |
| `completenessCheck(taskArgs, results)` | "What's still missing?" critic. | `{ complete, missing[] }` |
| `retry(thunk, {attempts=3, until})` | Bounded retry until `until(result)` is true. | last result |
| `gate(thunk, validator, {attempts=3})` | Retry where the validator's `feedback` steers the next attempt. | `{ ok, value, attempts }` |

### `agent()` options

| Opt | Effect |
|-----|--------|
| `tier` | Route to a tier model (`'small'` / `'medium'` / `'big'`) — see [Model routing](#model-tier-routing). |
| `model` | Pin a specific `provider/modelId` (overrides `tier`). |
| `label` | Short unique label (2–5 words) for live status + logs. |
| `schema` | JSON Schema; `agent()` returns the validated object. |
| `phase` | Override the active phase for this agent. |
| `timeoutMs`, `retries` | Per-agent timeout / retry count. |
| `maxContextTokens`, `contextReserveTokens` | Per-agent context-window guardrails. `maxContextTokens` is a hard provider input/context cap; `contextReserveTokens` overrides the reserve subtracted from the model window for 70/85/95% occupancy warnings. |
| `tools`, `disallowedTools` | Per-call coding-tool allow/deny lists by tool name; schema agents still receive `structured_output`. |
| `contextMode` | Context-inheritance posture (`'focused'` *(default)* / `'isolated'` / `'scoped'` / `'legacy'` / project-defined) — see [Context modes](#context-modes). |
| `inheritMainRules`, `inheritProjectContext`, `systemPromptMode`, `inheritSkills` | Per-field overrides of the resolved mode. |

---

## Model-tier routing

Agents are routed to concrete models by **tier**, so workflow source stays portable. The mapping lives in a machine-local config, not in the repo:

```jsonc
// ~/.pi/workflows/model-tiers.json
{ "tiers": { "small": "litellm/qwen3.6-27b", "medium": "ollama/glm-5.2", "big": "openai-codex/gpt-5.5" } }
```

- `resolveTierModel(tier, config)` returns the `provider/modelId` spec for a tagged tier.
- **Untagged agents (no `tier`/`model`) route to the configured `medium` tier** when a tier config exists; the session main model is the fallback only when no `model-tiers.json` is present. So pin `tier`/`model` explicitly when it matters.
- Inspect/edit live with **`/workflows-models`**.
- **Gotcha:** an invalid spec **silently falls back** to the session main model with no warning — always confirm the spec is in `listAvailableModelSpecs()`.

---

## Context modes

Per-subagent **context governance**, OpenCode-style: **rules you put on the main
agent don't leak into the subagents it spawns.** `AGENTS.md` stays small and
shared (general instructions for *all* agents); main-agent-only rules live in
`.pi/APPEND_SYSTEM.md` and are kept *out* of subagents so children stay focused.
The default mode **`focused`** needs zero config; `legacy` restores full
inheritance (byte-identical to before).

> [!IMPORTANT]
> **`focused` is the default for every subagent — this is the standard behavior, no flags required.** Subagents inherit the shared `AGENTS.md` and skills, but the main agent's rules (`.pi/APPEND_SYSTEM.md`) are **blocked by default** so they don't leak into children. This is a deliberate change from the pre-feature behavior, where subagents inherited everything. To restore full inheritance, set `contextMode: legacy` (or `inheritMainRules: true`) at the agent `.md`, the `agent()` call, or the run level (`--mode legacy`).

| Mode | context (`AGENTS.md`) | main-rules (`.pi/APPEND_SYSTEM.md`) | prompt | skills | Posture |
|------|------|------|--------|--------|---------|
| `focused` *(default)* | in | **out** | append | in | Shared context+skills, main rules blocked. |
| `isolated` | out | out | replace | out | True clean room (role replaces base). |
| `scoped` | in | out | replace | out | Reviewer — facts in, own persona, no skills. |
| `legacy` | in | **in** | append | in | Pre-feature behavior — everything inherited. |

A subagent's prompt has four independent channels — base, the main-rules append
channel, `AGENTS.md`, and skills — each governed by one primitive
(`systemPromptMode`, `inheritMainRules`, `inheritProjectContext`, `inheritSkills`).
Select a posture at the agent `.md` (`contextMode: scoped`), the `agent()` call
(`agent(p, { contextMode: 'legacy' })` or `{ inheritMainRules: true }`), or the
run level (`/code-review --mode legacy`). Precedence, highest first: **per-call
field > per-call mode > agent `.md` field > agent `.md` mode > run-level `--mode`
> `focused`**. Run `/modes` to list modes. (Conversation context is already
isolated — subagents spawn with fresh sessions.)

Full reference: **[docs/context-modes.md](./docs/context-modes.md)**.

---

## Slash commands

| Command | Usage | What it does |
|---------|-------|--------------|
| `/workflows` | `[list] \| status <id> \| watch <id> \| stop <id> \| pause <id> \| resume <id> \| rm <id> \| save <name> [runId]` | Manage runs. No args (with a UI) opens the interactive navigator. `watch` streams live progress to the status bar and prints the final snapshot. `save` registers a finished run as a reusable `/<name>` command. |
| `/code-review` | `[high\|xhigh\|max] [--mode <name>] [target]` | Multi-angle code review: scope → find (N angles) → verify → sweep → synthesize. All agents tagged `tier: "big"`. Used as an **in-session sanity checkpoint**, not a PR/merge gate. The first token is the effort level (`high` default; `xhigh`/`max` add a sweep phase) and is consumed before the target — so a target literally named `max` must be disambiguated. |
| `/deep-research` | `[--mode <name>] <question>` | Research a question across the web with cross-checked sources. |
| `/adversarial-review` | `[--mode <name>] [--evidence[=web_fetch,github\|web_search]] [--no-evidence] [--reviewers N] [--threshold N] <task>` | Investigate a task, then cross-check each finding with skeptical reviewers. Evidence mode adds a source-ledger phase using no-key `web_fetch`/GitHub evidence by default. Runs through the shared workflow manager in the background so `/workflows`, the task panel, and result delivery stay live. |
| `/issue-delivery` | `[--mode <name>] [--prototype] <task or issue>` | Autonomous Scout → Thinker → Worker → LocalChecks → Verifier workflow with DAG scheduling and draft-PR delivery. Intended for scoped issue-to-PR tasks; it plans, edits, verifies, commits, pushes, and opens a draft PR. |
| `/fugu` | `[--mode <name>] [--prototype] <task or issue>` | Deprecated compatibility alias for `/issue-delivery`. |
| `/modes` | — | List context-inheritance modes (built-in + project-defined) and what each expands to — see [Context modes](#context-modes). |
| `/effort` | `off \| high \| ultra` | Standing workflow effort — auto-arms a workflow for substantive messages. |
| `/ultracode` | `[off]` | Standing maximal-effort mode; `/ultracode off` to stop. |
| `/workflows-models` | — | View and edit model tiers (small/medium/big). |
| `/workflows-trigger` | `on \| off \| status` | Keyword trigger: when on, typing the exact `workflow-run` phrase auto-arms workflows mode. |
| `/workflows-progress` | `compact \| detailed \| status` | Bottom progress-panel render mode. |
| `/workflows-progress-max` | `<1-1000>` | Cap agents shown per phase in detailed mode. |

### Issue Delivery workflow

`/issue-delivery [--mode <name>] [--prototype] <task or issue>` is the built-in issue-to-draft-PR coordinator: a small deterministic workflow script routes work between specialist agents instead of stuffing the whole coordination policy into one massive prompt. Fugu/Trinity are historical inspirations; `/fugu` remains a deprecated compatibility alias.

```text
/issue-delivery implement issue #42
/issue-delivery --mode focused --prototype fix the failing parser regression and open a draft PR
```

The normal production path is still issue/plan driven: a GitHub issue with a matching plan markdown file flows through the closed-loop delivery system and then PR review. `--prototype` is the dogfood harness lane for small repo-local experiments while developing the workflow package itself; `--dry-run` also implies this prototype lane. Prototype mode defaults to `dryRun=true`: it performs the safety check, read-only Scout/Thinker planning, host local checks, and bounded prototype review rounds, then stops before Worker edits, git push, and PR creation. To allow bounded local edits but still stop before PR delivery, run `--prototype --dry-run=false` from an isolated linked worktree. Context posture is still controlled separately by `--mode` (`focused`, `scoped`, `isolated`, `legacy`).

High-level flow:

```text
Task / issue text
  ↓
Scout (small tier): FastContext firewall returns a compact Code Map
  ↓
Thinker (big tier): plan a DAG from the compact Code Map
  ↓
Deterministic scheduler: run dependency-ready steps with parallel()
  ↓
Worker (small → medium → big tier on retry): edit one focused step
  ↓
LocalChecks (host stageCheck): run tsc/Biome mechanically with zero LLM tokens
  ↓
Verifier (big tier): strict semantic pass/fail review after checks pass
  ↓
Feedback Compactor: failed checks/verdicts become a bounded Correction Delta for retry
  ↓
PR delivery + Telemetry finalization: branch, commit, push, PR, clean/pushed/checks gate
```

Components:

| Component | Role |
|-----------|------|
| **Scout** | Runs `fastcontext-scout` on the small tier to gather targeted citations and API/test hints. The Thinker receives this compact Code Map instead of large raw files. |
| **Thinker** | Plans from the task plus Code Map, then emits structured JSON: `summary` plus `steps[]` with `id`, `file`, `instructions`, `expectedOutput`, and optional `dependencies`. Same-file edits should be sequential; independent files can stay dependency-free. |
| **DAG scheduler** | Runs inside the workflow VM, not inside a model. It repeatedly finds steps whose dependencies are complete, starts them together with `parallel()`, and rejects cyclic/deadlocked plans. |
| **Worker** | Receives exactly one step and edits the repo directly with coding tools. First attempt uses `small`, second `medium`, third `big`; it sees only the current Correction Delta, not raw history. |
| **LocalChecks** | Calls host-side `stageCheck()` (TypeScript and Biome by default) and fails fast before the LLM Verifier when mechanical checks fail. |
| **Verifier** | Performs strict semantic LLM review with schema output `{ passed, feedback }`, only after host checks pass. |
| **Feedback Compactor** | Converts failed stage checks or verifier feedback into a bounded, redacted Correction Delta (`maxTokens: 512`) for the next Worker attempt. |
| **State writer** | Writes transient diagnostic progress to `.issue-delivery/status.json` so long runs have inspectable local state. Legacy `.fugu/` scratch state is still ignored during migration. This is scratch state, not intended for commits. |
| **PR delivery / Telemetry** | After all steps pass, creates a safe branch, commits, pushes, opens a draft PR, then runs the deterministic finalization gate. If the task mentions an issue like `#42`, the PR body should include `Closes #42`. |

DAG example produced by the Thinker:

```json
[
  { "id": "step-1", "file": "src/parser.ts", "dependencies": [] },
  { "id": "step-2", "file": "tests/parser.test.ts", "dependencies": ["step-1"] },
  { "id": "step-3", "file": "README.md", "dependencies": [] }
]
```

In that example, `step-1` and `step-3` can run together, while `step-2` waits for the parser change.

Model routing is intentionally portable for NPM: built-in Issue Delivery uses tiers rather than hard-coded provider IDs.

- Scout / state / PR delivery: `tier: "small"`
- Thinker / Verifier: `tier: "big"`
- Worker: attempt 1 `tier: "small"`, attempt 2 `tier: "medium"`, attempt 3 `tier: "big"`
- LocalChecks: host-side `stageCheck()` (zero LLM tokens)

Use `/workflows-models` to map those tiers to your own subscriptions or local models. For example, one machine can route big to GPT-5-class reasoning, medium to GLM/DeepSeek coding, and small to a fast local Qwen verifier without changing the shipped workflow.

Prototype guardrails:

- `--prototype` defaults: `dryRun=true`, `worktreeRequired=true`, `maxSteps=4`, `maxRepairRounds=1`, `maxReviewRounds=1`.
- Prototype mode refuses the primary/shared checkout by default; use a linked worktree or pass `--worktree-required=false --allow-shared-checkout` deliberately.
- Prototype dry-runs use read-only pre-report agents, do not run Worker edit agents, do not push, and do not create PRs. The final report includes selected steps, omitted steps, safety status, local checks, review notes, and the recommended next action.
- Prototype execution (`--dry-run=false`) can edit the isolated worktree, but still stops before git push/PR creation so a human can inspect or promote it.

Operational notes:

- Start from a clean git working tree when possible; Issue Delivery will create its own branch during normal PR delivery.
- `gh` must be authenticated and the repo must allow pushing branches for draft PR delivery to succeed.
- Prefer focused issue-sized tasks. Broad roadmap requests should be broken into issues first.
- Use `--mode <name>` to choose the context-inheritance posture for all subagents, e.g. `focused`, `scoped`, or a project-defined mode.
- Issue Delivery opens a draft PR; it does not auto-merge.

### Adversarial review evidence mode

Baseline `/adversarial-review <task>` preserves the original fast workflow: investigate → skeptical refutation → consensus. Add `--evidence` to insert an Evidence phase before refutation:

```text
/adversarial-review --evidence check this claim against https://github.com/org/repo/blob/main/README.md
/adversarial-review --evidence=web_search,github --reviewers=3 --threshold=0.75 check this external claim
```

Options:

- `--mode <name>` / `--mode=<name>` — choose the run-level context mode for all subagents.
- `--evidence` — enable source-ledger collection with the default no-key components: `web_fetch,github`.
- `--evidence=<components>` — enable only selected components. Comma/plus separated, e.g. `web_fetch,github` or `web_search+github`.
- `--evidence-components=<components>` — alias for selecting evidence components explicitly.
- `--no-evidence` — force baseline mode even if an earlier flag enabled evidence.
- `--reviewers <N>` / `--reviewers=<N>` — skeptical reviewers per finding. Default: `2`.
- `--reviewer-count <N>` / `--reviewer-count=<N>` — alias for `--reviewers`.
- `--threshold <N>` / `--threshold=<N>` — required real-vote ratio for a finding to survive, clamped to `0..1`. Default: `0.5`.
- `--agreement-threshold <N>` / `--agreement-threshold=<N>` — alias for `--threshold`.
- `--` — stop option parsing; everything after it becomes the task text.

Evidence components:

- `web_fetch` — fetch and quote known URLs.
- `github` — GitHub URLs/files via `web_fetch`; no API key required. Aliases: `gh`, `github_fetch`.
- `web_search` — optional best-effort web discovery, then `web_fetch` to read sources. Aliases: `search`, `bing`.
- `all` — enable `web_fetch`, `github`, and `web_search`.
- `off` / `none` / `false` / `no` / `0` — disable evidence when used as the value for `--evidence=`.

Brave/Exa provider-backed search can be layered in by installing a web-tools package or saved workflow that exposes those tools, but the built-in command starts with reliable no-key fetch/GitHub evidence.

### Saved workflows

Run a workflow, then register it for reuse:

```
/workflows save research_topic        # saves the most recent run with a script
/workflows save research_topic <runId>
```

This creates a `/<name>` command (with `key=value` args). Saved-workflow slash commands start through the shared `WorkflowManager`, print the run ID immediately, show live progress in the task panel/`/workflows`, and deliver the final result back to chat when complete. Call a saved workflow from another workflow via `await workflow('research_topic', { key: 'value' })`. Storage is `WorkflowStorage` (`workflow-saved.ts`).

---

## UI & notifications

Three surfaces show workflow state, by design serving different moments:

- **Below-editor "workflows running" panel** (`installTaskPanel`) — live agents/phases/tokens while a run is in flight. Informational only (it takes no input) — run `/workflows` to open the interactive navigator. Mode controlled by `/workflows-progress`.
- **Status bar** (`ctx.ui.setStatus`) — one-line live progress while watching a run (`/workflows watch <id>`).
- **Chat `<task-notification>`** (`installResultDelivery`) — the canonical *final* status delivered when a background run finishes. Modeled on Claude Code's XML: `<status>`, `<usage>` (`agent_count`, `subagent_tokens`, `tool_uses`, `duration_ms`), and on failure a `<recovery>` block with **`file://` links** to the on-disk agent transcripts and the persisted run-state JSON (`ManagedRun.runStatePath`, set regardless of transcript persistence).

> **Foreground dedup.** A foreground (`background: false`) tool run used to stream live progress into chat *and* the below-editor panel at the same time. Now, when a UI is present, live progress shows only in the panel (`installTaskPanel`, which subscribes to the manager directly) and chat receives just the final result; in headless/RPC mode (no panel) it still streams to chat as a fallback. Background runs are unchanged: the panel shows live progress and chat gets the final `<task-notification>`.

---

## Conductor statuses

Workflow runs carry an **engine status** (`running`, `completed`, `failed`, etc.) and
an optional **semantic status** that layers conductor-level intent on top. This
helps distinguish a completed workflow whose tmux pane is still open from one that
is truly active, and signals when a repair run needs finalization attention.

| Semantic status | When it appears |
|-----------------|------------------|
| `spawned` | tmux pane created, workflow not yet started |
| `workflow-running` | workflow is actively executing |
| `workflow-complete-pane-open` | workflow finished, pane still open for inspection |
| `needs-finalize` | repair/delivery invariants (clean, committed, pushed) not yet met |
| `finalizing` | finalization in progress (e.g. checks pending) |
| `completed` | run finished, worktree clean and delivered |
| `failed` | run failed |
| `needs-human` | blocked; requires human intervention |

The semantic status is displayed in `/workflows list` and `/workflows status <id>`
output alongside the engine status. The finalization gate checks:

1. Worktree clean (transient `.issue-delivery/`, legacy `.fugu/`, and `.fastcontext/` paths are ignored)
2. Branch pushed to upstream
3. Local HEAD matches remote HEAD
4. PR head SHA matches (when known)
5. GitHub checks green or clearly pending

When any invariant fails, the run reports `needs-finalize` or `needs-human`
with an actionable `nextAction` instead of silently claiming success.

---

## Our patches

All merged into `main`. See **[PROVENANCE.md](./PROVENANCE.md)** for the full table and per-edit commits.

| Patch | Summary |
|-------|---------|
| EDIT 1 | 4096-item fan-out cap |
| EDIT 2 | 512 KB script-size cap + 30 s `runInContext` timeout |
| EDIT 3 | `<task-notification>` / `<usage>` / `<recovery>` XML result delivery |
| EDIT 4 | Built-in `code-review` workflow (multi-angle: scope → find → verify → sweep → synthesize) |
| EDIT 5 | Per-subagent transcript logging (`ManagedRun.transcriptDir`) |
| EDIT 6 | Live progress panel polish + concurrency floor |
| EDIT 7 | Per-subagent **context modes** — main-agent rules don't leak into subagents (default `focused`) + `/modes` command. See [Context modes](#context-modes) / [docs](./docs/context-modes.md) |
| + | Error-surfacing in the task panel + 5 bug fixes (code-point-safe truncation, first-line extraction, whitespace-only errors, shared `agentErrorText()` helper) |
| + | `code-review` agents pinned to `tier: "big"`; model-tier routing config |
| + | Chat notification enrichment: `file://` log links on failure + real `tool_uses` from agent history |

---

## Status & acknowledgements

**Status:** **1048/1048** unit tests pass; full `npm test` gate (biome + build + unit) green. Tracked issues are indexed in [docs/issues.md](./docs/issues.md).

Originally derived from [`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows)
(MIT, by QuintinShaw; original `pi-dynamic-workflows` by Michael Livs), now
independently maintained and substantially extended. See
[PROVENANCE.md](./PROVENANCE.md) for the change list and how upstream is tracked.

---

## License

MIT, retained from upstream. See [LICENSE](./LICENSE).
