# Context modes — per-subagent context governance

OpenCode-style **context governance** for the dynamic-workflows engine. The
headline behavior: **rules you put on the main agent do not leak into the
subagents it spawns.** `AGENTS.md` stays small and shared (general instructions
for *all* agents); main-agent-only instructions ("spawn waves of subagents",
"use superpowers") live on the main session and are kept *out* of subagents, so
children stay focused and un-confused.

The default mode is **`focused`** and needs **zero configuration** — a spawned
subagent inherits the shared project context and skills, runs under pi's base
prompt plus its own role, but does **not** inherit the main-agent append channel.
`legacy` restores the exact pre-feature behavior (everything inherited).

> Tracking issue: [#1](https://github.com/gtnotacoder/pi-dynamic-workflows/issues/1).

> [!IMPORTANT]
> **`focused` is the default for every subagent — this is the standard behavior, no flags required.** Subagents inherit the shared `AGENTS.md` and skills, but the main agent's rules (`.pi/APPEND_SYSTEM.md`) are **blocked by default** so they don't leak into children. This is a deliberate change from the pre-feature behavior, where subagents inherited everything. To restore full inheritance, set `contextMode: legacy` (or `inheritMainRules: true`) at the agent `.md`, the `agent()` call, or the run level (`--mode legacy`).

> [!WARNING]
> `replace` (used by `isolated` / `scoped`) installs the agent's role **as** the base system prompt, which **drops pi's entire base prompt** (tool list + guidelines). Use it only for true clean-room agents; the default `focused` keeps the base via `append`.

---

## How pi assembles a session prompt (verified)

A pi session's system prompt is built from four **independent** channels
(confirmed against the SDK `DefaultResourceLoader` + `buildSystemPrompt`):

| Channel | Source file(s) | Governed by |
|---|---|---|
| **Base prompt** | pi core (or `.pi/SYSTEM.md`) | `systemPromptMode` (`append` keeps it, `replace` swaps it) |
| **Main-agent rules** | `.pi/APPEND_SYSTEM.md` (append channel) | `inheritMainRules` |
| **Project context** | `AGENTS.md` / `CLAUDE.md` | `inheritProjectContext` |
| **Skills** | skills | `inheritSkills` |

The bug this feature fixes: by default a spawned subagent inherited **all four**,
including `.pi/APPEND_SYSTEM.md` — so the main agent's orchestration rules leaked
into every child. `focused` blocks just that channel.

> **Conversation context** (the main agent's message history) is a separate
> concept and is **already isolated** in pi — workflow subagents spawn with fresh
> sessions and never receive the parent's transcript. Nothing to configure.

---

## Primitives

| Primitive | Values | Effect |
|---|---|---|
| `inheritProjectContext` | `true`/`false` | `false` → `noContextFiles` (drop `AGENTS.md`). Default **true**. |
| `inheritMainRules` | `true`/`false` | `false` → `appendSystemPrompt:[]` (block `.pi/APPEND_SYSTEM.md`). Default **false**. |
| `inheritSkills` | `true`/`false` | `false` → `noSkills`. Default **true**. |
| `systemPromptMode` | `append`/`replace` | `append`: keep pi's base + role-as-task (default). `replace`: install the role **as** the base prompt — ⚠️ this drops pi's whole base (tools/guidelines), so reserve it for true clean-room agents. |

## Built-in modes

| Mode | context | main-rules | prompt | skills | Posture |
|------|---------|-----------|--------|--------|---------|
| `focused` *(default)* | in | **out** | append | in | Shared context+skills, pi base + role-as-task, main rules blocked. |
| `isolated` | out | out | replace | out | True clean room (role replaces base; nothing inherited). |
| `scoped` | in | out | replace | out | Reviewer — project facts in, own persona, no skills. |
| `legacy` | in | **in** | append | in | Pre-feature behavior — everything inherited (byte-identical). |

`inherit` is a back-compat alias of `legacy`. Project-defined modes (below) merge
over these; built-in names are reserved.

---

## Backward-compatibility gate

`legacy` resolves to `needsResourceLoader() === false`, so selecting it
constructs **no** resource loader and the session is byte-identical to the
pre-feature behavior. The default (`focused`) *does* build a loader — but it uses
exactly the same `{ cwd, agentDir, settingsManager }` the SDK's own default
loader uses (`createAgentSession`), adding only `appendSystemPrompt:[]`. So no
other config (extensions, skills, prompt templates) is lost; only the main-rules
channel is dropped.

---

## Selection & precedence

A single resolver (`resolveContextMode` / `resolveContextModeLayers`). Precedence,
highest first:

```
per-call explicit field   (agent({ inheritMainRules: true }))
  > per-call mode         (agent({ contextMode: 'legacy' }))
    > agent .md field
      > agent .md mode    (frontmatter: contextMode: scoped)
        > run-level mode  (/code-review --mode legacy)
          > focused       (built-in default)
```

Within any layer, an explicit primitive overrides that layer's mode. An unknown
mode falls back to the default and is surfaced as `unknownMode` for a warning.

---

## Usage

### Where main-agent rules go

Put shared, all-agent instructions in **`AGENTS.md`** (kept small). Put
main-session-only orchestration rules in **`.pi/APPEND_SYSTEM.md`** — subagents
won't see them by default.

### Agent `.md` frontmatter

```markdown
---
name: independent-reviewer
contextMode: scoped          # project facts in, own persona, no skills, no main rules
---
You are an independent reviewer. Judge against the repo's actual conventions.
```

### Code-mode `agent()` call

```js
agent("review this diff", { agentType: "independent-reviewer" });   // focused by default
agent("debug with full context", { contextMode: "legacy" });        // opt back into full inheritance
agent("worker", { inheritMainRules: true });                        // per-field override of the default
```

### Run level (bundled commands) & listing

```
/code-review --mode legacy        # run every subagent with full inheritance
/modes                            # list modes + what each expands to
```

### Project-defined modes

In `~/.pi/workflows/settings.json` (or the project override). Full set required
(three booleans + `systemPromptMode`); built-in names are reserved:

```json
{
  "contextModes": {
    "lean-builder": { "inheritProjectContext": false, "inheritMainRules": false, "inheritSkills": true, "systemPromptMode": "append" }
  }
}
```

---

## Verified behavior

Model-free test (real SDK loaders + assembled prompt) against a project with a
shared `AGENTS.md` and a main-only `.pi/APPEND_SYSTEM.md`:

| Mode | pi base | `AGENTS.md` | main rules (`.pi/APPEND_SYSTEM.md`) |
|---|---|---|---|
| `focused` *(default)* | kept | present | **blocked** |
| `legacy` | kept | present | inherited |
| `isolated` | replaced | dropped | blocked |

---

## Implementation map

| File | Role |
|---|---|
| `src/context-mode.ts` | Primitives (incl. `inheritMainRules`), registry, resolver, `resourceLoaderFlags` (incl. `appendSystemPrompt`), `needsResourceLoader` gate, reserved names. |
| `src/agent.ts` | Builds a `DefaultResourceLoader` when non-default; maps primitives → loader flags incl. `appendSystemPrompt:[]`. |
| `src/workflow.ts` | Surfaces the fields; resolves run/frontmatter/runtime layers; folds into the call-hash. |
| `src/agent-registry.ts` | Parses `inheritMainRules` (+ the others) from frontmatter; folds into the resume key. |
| `src/workflow-settings.ts` | Parses/validates `contextModes` (full set; built-in names reserved). |
| `src/modes-command.ts` | `/modes` (with the `main-rules` column) + the shared `--mode` parser. |
| `src/builtin-commands.ts` | `--mode` on `/deep-research`, `/adversarial-review`, `/code-review`. |
| `tests/*context*` | resolver precedence, the gate, append-channel block, base preservation, registry merge, settings + frontmatter parsing. |

---

## Notes

- The load-bearing surface for scripts is `agent({ contextMode })` / the per-field
  options; slash `--mode` is a run-level convenience on the bundled commands.
- `replace` (used by `isolated`/`scoped`) installs the agentType body as the base
  system prompt and the workflow layer omits it from the task to avoid duplication.
- Reliability for headless drivers (e.g. an external orchestrator running `pi
  --mode rpc`): the main-rules block is the **default with no flags**, works in
  the non-interactive path, and no-ops when `.pi/APPEND_SYSTEM.md` is absent.
