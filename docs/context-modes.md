# Context modes — per-subagent context governance

OpenCode-style **context governance** for the dynamic-workflows engine. Each
subagent can control whether it inherits project `AGENTS.md` context, whether
its role prompt **replaces** or augments the base system prompt, and whether it
inherits skills — selected via a named **context mode** or per-field overrides.

The default mode is `inherit`, which expands to the engine's exact prior
behavior, so **existing workflows are unchanged** (see [Backward-compatibility
gate](#backward-compatibility-gate)).

> Tracking issue: feature notes & findings live in the repo's "Context modes"
> issue. Implementation landed in `50fe3e9`.

---

## Why

In code-mode, a spawned subagent inherits the parent's project context and base
prompt with no per-agent control. That's wrong for review waves and adversarial
passes, where you want a **clean-room reviewer** that isn't biased by the
builder's `AGENTS.md` conventions or skills. Context modes add that control
without giving up code-mode orchestration.

---

## Three layers

### 1. Primitives — what the session enforces

Mapped onto the SDK `DefaultResourceLoader` in `src/agent.ts`:

| Primitive | Values | Effect |
|---|---|---|
| `inheritProjectContext` | `true` / `false` | `false` → `noContextFiles` (drop project `AGENTS.md` / context files). |
| `systemPromptMode` | `append` / `replace` | `append`: leave the base system prompt intact and carry the role prompt as task guidance (status quo). `replace`: install the role prompt **as** the session system prompt. |
| `inheritSkills` | `true` / `false` | `false` → `noSkills`. |

### 2. Context modes — named presets

A mode is a macro that expands to one primitive triple. Built-ins:

| Mode | `context` | `prompt` | `skills` | Posture |
|---|---|---|---|---|
| `inherit` *(default)* | in | append | in | Status quo — base prompt + role-as-task, full inheritance. |
| `isolated` | out | replace | out | Clean room — no project context, role replaces prompt, no skills. |
| `scoped` | in | replace | out | Reviewer — project facts in, own persona, no inherited skills. |

Project-defined modes are merged **over** the built-ins (see
[Project-defined modes](#project-defined-modes)). `inherit` is reserved and
cannot be shadowed.

### 3. Selection surface — one resolver

All entry points flow through a single resolver (`resolveContextMode` /
`resolveContextModeLayers` in `src/context-mode.ts`). **Precedence, highest
first:**

```
per-call explicit field   (agent({ inheritProjectContext: true }))
  > per-call mode         (agent({ contextMode: 'isolated' }))
    > agent .md field     (frontmatter: inheritSkills: false)
      > agent .md mode    (frontmatter: contextMode: scoped)
        > run-level mode  (/code-review --mode isolated)
          > inherit       (built-in default)
```

Within any layer, an explicit primitive field overrides that layer's mode. An
unknown mode name falls back to the default and is surfaced as `unknownMode` so
the caller can warn.

---

## Backward-compatibility gate

`inherit` resolves to `needsResourceLoader() === false`, so the default path
constructs **no** resource loader and the session is byte-identical to before
this feature. This is what keeps existing workflows unchanged and is covered by
the pre-existing tests staying green (818/818 total, 43 new).

---

## Usage

### Agent `.md` frontmatter

```markdown
---
name: independent-reviewer
contextMode: scoped          # project facts in, own persona, no inherited skills
# systemPromptMode: replace  # optional per-field override of the mode
---
You are an independent reviewer. Judge against the repo's actual conventions.
```

### Code-mode `agent()` call (wins over the agent's authored default)

```js
agent("review this diff", { agentType: "independent-reviewer", contextMode: "isolated" });
// or override a single primitive:
agent("review this diff", { contextMode: "isolated", inheritProjectContext: true });
```

### Run level (bundled commands)

```
/code-review --mode isolated
/deep-research --mode scoped <question>
/adversarial-review --mode isolated <task>
/modes                         # list built-in + project-defined modes
```

`--mode <name>` sets a run-level default posture for every subagent in that run;
agent `.md` frontmatter and per-call `agent()` options still override it.

### Project-defined modes

In `~/.pi/workflows/settings.json` (or the project override). Full triples only;
`inherit` is reserved:

```json
{
  "contextModes": {
    "lean-builder": { "inheritProjectContext": false, "systemPromptMode": "append", "inheritSkills": true }
  }
}
```

---

## `/modes` output

```
Context-inheritance modes — use `--mode <name>` or set `contextMode:` in an agent `.md`:
  inherit   context:in  · prompt:append  · skills:in
  isolated  context:out · prompt:replace · skills:out
  scoped    context:in  · prompt:replace · skills:out
```

---

## Implementation map

| File | Role |
|---|---|
| `src/context-mode.ts` | Registry, layered resolver, `resourceLoaderFlags`, `buildContextModeRegistry`, the `needsResourceLoader` backward-compat gate. |
| `src/modes-command.ts` | `/modes` listing + the shared `--mode` flag parser. |
| `src/agent-registry.ts` | Parse `contextMode` / primitive fields from frontmatter; fold into the resume call-hash. |
| `src/agent.ts` | Build a `DefaultResourceLoader` only when non-default; map primitives → loader flags; install role-as-system-prompt under `replace`. |
| `src/workflow.ts` | Surface fields on `AgentOptions`; resolve frontmatter + runtime + run layers; dedup role prompt under `replace`; fold into the call-hash. |
| `src/workflow-settings.ts` | Parse/validate `contextModes` (full triples only; `inherit` reserved). |
| `src/workflow-manager.ts`, `extensions/workflow.ts`, `src/index.ts` | Thread the project registry; register `/modes`. |
| `src/builtin-commands.ts` | `--mode` on `/deep-research`, `/adversarial-review`, `/code-review`. |
| `tests/context-mode.test.ts`, `tests/modes-command.test.ts`, `tests/context-modes-settings.test.ts` | 43 tests: resolver precedence, gate, registry merge, frontmatter + settings parsing, `--mode` extraction. |

---

## Notes & out of scope

- **Per-step temperature** is intentionally out of scope — set it at the pi-ai
  layer, not surfaced by this extension.
- The load-bearing surface for arbitrary scripts is `agent({ contextMode })` in
  code-mode; slash `--mode` is a run-level convenience on the bundled commands.
- `replace` installs the agentType body as the session system prompt and the
  workflow layer omits it from the task to avoid duplication.
