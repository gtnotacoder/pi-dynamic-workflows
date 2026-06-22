# pi-dynamic-workflows (gtnotacoder fork)

A vendored, patched fork of [`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows) (MIT) that brings Claude-Code-style **dynamic multi-agent workflows** to [Pi](https://pi.dev).

The upstream package is itself a Pi re-implementation of Claude Code's `Workflow` tool. **This fork's patches increase fidelity to the *actual* Claude Code 2.1.185 JavaScript**, which we reverse-engineered from Claude Code's packed `.bun` bundle. The `<task-notification>`/`<usage>`/`<recovery>` XML delivery, the built-in `code-review` topology, per-subagent transcript logging, and the live progress panel are all modeled on the real CC behavior rather than guesswork. See the RE findings linked under [Provenance](#provenance--derivation) below.

> **Not the upstream package.** We vendor it, apply internal "Claude-Code-fidelity" patches, and maintain it for our own use. Full change log in **[PROVENANCE.md](./PROVENANCE.md)**.

- **Upstream:** https://github.com/QuintinShaw/pi-dynamic-workflows · **npm:** https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows
- **Fork point:** v2.6.0 (`622f6df`) — now tracking upstream **v2.7.0** (`b11fdbd`, version-string-only)
- **License:** MIT, retained from upstream (see [LICENSE](./LICENSE))

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
| `contextMode` | Context-inheritance posture (`'inherit'` / `'isolated'` / `'scoped'` / project-defined) — see [Context modes](#context-modes). |
| `inheritProjectContext`, `systemPromptMode`, `inheritSkills` | Per-field overrides of the resolved mode. |

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

Per-subagent **context governance**: each subagent can control whether it
inherits project `AGENTS.md` context, whether its role prompt **replaces** or
augments the base system prompt, and whether it inherits skills — via a named
mode or per-field overrides. Default `inherit` == prior behavior, so existing
workflows are unchanged.

| Mode | context | prompt | skills | Posture |
|------|---------|--------|--------|---------|
| `inherit` *(default)* | in | append | in | Status quo — full inheritance, role-as-task. |
| `isolated` | out | replace | out | Clean room — no project context/skills, role replaces prompt. |
| `scoped` | in | replace | out | Reviewer — project facts in, own persona, no skills. |

Select it at the agent `.md` (`contextMode: scoped`), the `agent()` call
(`agent(p, { contextMode: 'isolated' })`), or the run level
(`/code-review --mode isolated`). Precedence, highest first: **per-call field >
per-call mode > agent `.md` field > agent `.md` mode > run-level `--mode` >
`inherit`**. Run `/modes` to list built-in + project-defined modes. Define your
own under `contextModes` in `~/.pi/workflows/settings.json`.

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
| EDIT 3 | `<task-notification>` XML delivery (CC-fidelity) |
| EDIT 4 | Built-in `code-review` workflow matching CC 2.1.185 topology |
| EDIT 5 | Per-subagent transcript logging (`ManagedRun.transcriptDir`) |
| EDIT 6 | Live progress panel polish + Claude concurrency floor |
| EDIT 7 | Per-subagent **context modes** + `/modes` command — see [Context modes](#context-modes) / [docs](./docs/context-modes.md) |
| + | Error-surfacing in the task panel + 5 bug fixes (code-point-safe truncation, first-line extraction, whitespace-only errors, shared `agentErrorText()` helper) |
| + | `code-review` agents pinned to `tier: "big"`; model-tier routing config |
| + | Chat notification enrichment: `file://` log links on failure + real `tool_uses` from agent history |

---

## Provenance & derivation

This fork's fidelity patches are grounded in direct reverse engineering of Claude Code's `Workflow` tool, extracted from its `.bun` bundle. Related analysis (in the `gtnotacoder/re` workspace, `cc-pi/` target):

- `cc-pi/findings/cc-workflows.md` — RE of Claude Code's `Workflow` tool
- `cc-pi/findings/comparison-pi-dynamic-workflows.md` — side-by-side: our from-scratch port vs. this package vs. CC internals
- `cc-pi/findings/cc-subagent-logging.md` — per-subagent logging mechanism + EDIT 5 fix spec
- `cc-pi/findings/comparison-test-suite.md` — token-free comparison harness + parity money chart

**Status:** patched-fork parity vs. Claude Code 2.1.185 — **15/17** (matches CC best). **818/818** unit tests pass; full `npm test` gate (biome + build + unit) green.

---

## License

MIT, retained from upstream. See [LICENSE](./LICENSE).