# pi-dynamic-workflows-oc-style

**Dynamic multi-agent workflows for [Pi](https://pi.dev)** — fan a task out across
hundreds of subagents with model routing, token/cost accounting, resume,
git-worktree isolation, an interactive `/workflows` TUI, `/deep-research`, and
**OpenCode-style per-subagent context governance**: rules you put on the main
agent don't leak into the subagents it spawns (see [Context modes](#context-modes)).

> Independently maintained. Originally derived from [`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows) (MIT) and substantially extended; see [PROVENANCE.md](./PROVENANCE.md) for the relationship and how upstream is tracked.

- **Originally derived from:** [`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows) v2.6.0 (MIT), tracking v2.7.0
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

---

## The `workflow` tool

The model-facing primitive. A workflow is a plain JavaScript string with a required `meta` header and at least one `agent()` call:

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
- **Bounded** — fan-out capped at 4096 items, script source at 512 KB, `runInContext` at 30 s (our EDITs 1–2).

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
| `/adversarial-review` | `[--mode <name>] <task>` | Investigate a task, then cross-check each finding with skeptical reviewers. |
| `/modes` | — | List context-inheritance modes (built-in + project-defined) and what each expands to — see [Context modes](#context-modes). |
| `/effort` | `off \| high \| ultra` | Standing workflow effort — auto-arms a workflow for substantive messages. |
| `/ultracode` | `[off]` | Standing maximal-effort mode; `/ultracode off` to stop. |
| `/workflows-models` | — | View and edit model tiers (small/medium/big). |
| `/workflows-trigger` | `on \| off \| status` | Keyword trigger: when on, mentioning "workflow(s)" auto-arms workflows mode. |
| `/workflows-progress` | `compact \| detailed \| status` | Bottom progress-panel render mode. |
| `/workflows-progress-max` | `<1-1000>` | Cap agents shown per phase in detailed mode. |

### Saved workflows

Run a workflow, then register it for reuse:

```
/workflows save research_topic        # saves the most recent run with a script
/workflows save research_topic <runId>
```

This creates a `/<name>` command (with `key=value` args). Call it from another workflow via `await workflow('research_topic', { key: 'value' })`. Storage is `WorkflowStorage` (`workflow-saved.ts`).

---

## UI & notifications

Three surfaces show workflow state, by design serving different moments:

- **Below-editor "workflows running" panel** (`installTaskPanel`) — live agents/phases/tokens while a run is in flight. Informational only (it takes no input) — run `/workflows` to open the interactive navigator. Mode controlled by `/workflows-progress`.
- **Status bar** (`ctx.ui.setStatus`) — one-line live progress while watching a run (`/workflows watch <id>`).
- **Chat `<task-notification>`** (`installResultDelivery`) — the canonical *final* status delivered when a background run finishes. Modeled on Claude Code's XML: `<status>`, `<usage>` (`agent_count`, `subagent_tokens`, `tool_uses`, `duration_ms`), and on failure a `<recovery>` block with **`file://` links** to the on-disk agent transcripts and the persisted run-state JSON (`ManagedRun.runStatePath`, set regardless of transcript persistence).

> **Foreground dedup.** A foreground (`background: false`) tool run used to stream live progress into chat *and* the below-editor panel at the same time. Now, when a UI is present, live progress shows only in the panel (`installTaskPanel`, which subscribes to the manager directly) and chat receives just the final result; in headless/RPC mode (no panel) it still streams to chat as a fallback. Background runs are unchanged: the panel shows live progress and chat gets the final `<task-notification>`.

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

**Status:** **825/825** unit tests pass; full `npm test` gate (biome + build + unit) green.

Originally derived from [`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows)
(MIT, by QuintinShaw; original `pi-dynamic-workflows` by Michael Livs), now
independently maintained and substantially extended. See
[PROVENANCE.md](./PROVENANCE.md) for the change list and how upstream is tracked.

---

## License

MIT, retained from upstream. See [LICENSE](./LICENSE).