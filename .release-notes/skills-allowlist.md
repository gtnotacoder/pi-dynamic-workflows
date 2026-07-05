# Per-agent skills allowlist — release 0.2.1 cleanup

Commit: `<pending>` on `chore/0.2.1-cleanup`.

## Motivation

Subagent skill inheritance was binary (`inheritSkills` true/false via context
modes in `src/context-mode.ts`). Every subagent got ALL user + project skills,
so cheap-tier mechanical agents (e.g. a grep-only scout) carried irrelevant
skill descriptions as pure context tax.

## Feature

`agent()` now accepts a per-agent **skills allowlist**:

```js
await agent("grep the repo for X", { label: "scout", skills: ["langfuse"] });
await agent("worker", { skills: [] }); // fence → zero skills
```

- `skills: ["name", ...]` loads ONLY the named skills (matched by skill
  `name`), regardless of `inheritSkills`/`contextMode`.
- **Empty array is a fence** → zero skills (equivalent to `inheritSkills:
  false`), *not* "all skills". Omitting the option preserves today's behavior.
- Unknown names **warn** (console) and are skipped; the run never fails.
- Precedence for the skills channel: `skills` > `inheritSkills`/`contextMode`.
  When set, a custom resource loader is always constructed (even under
  `legacy`) with `noSkills:false` and a `skillsOverride` filter that keeps
  only the named skills. The allowlist is folded into the resume call-hash so
  changing it busts the cached result and re-runs the agent.

## Implementation

- **`src/context-mode.ts`** — new pure helper `filterSkillsByName(discovered,
  requested)` returning `{ skills, unknown }`. Empty `requested` ⇒ zero
  skills (fence, mirroring `applyToolPolicy`). Exported so the enforcement
  mapping is unit-tested directly.
- **`src/agent.ts`** — `AgentRunOptions.skills?: string[]`. In
  `WorkflowAgent.run`, when `skills` is set the resource-loader block forces a
  custom `DefaultResourceLoader` (even under `legacy`): `noSkills` is false
  unless the allowlist is empty, and a `skillsOverride` hooks
  `filterSkillsByName` to keep only the named skills, warning on unknowns.
- **`src/workflow.ts`** — `AgentOptions.skills?: string[]` threaded through to
  `agentRunner.run` (verbatim — `undefined` vs `[]` matters). Folded into the
  resume call-hash identity (`skills: options.skills ?? null`).
- **`README.md`** + **`docs/context-modes.md`** — new "Per-agent skills
  allowlist" section documenting the option, precedence, fence semantics, and
  resume interaction.

## Tests (`tests/skills-allowlist.test.ts`, 13 cases)

1. `filterSkillsByName` (pure) — filters by name, reports unknowns, `[]` ⇒
   zero skills, preserves discovery order.
2. Workflow-layer threading — `skills` forwarded verbatim: `undefined`
   (absent), `["langfuse","shadcn"]` (named), `[]` (fence).
3. Resume identity — changing the allowlist busts the cache (live re-run);
   unchanged allowlist replays (cache hit).
4. End-to-end loader wiring — a real `DefaultResourceLoader` built exactly as
   `WorkflowAgent.run` builds it (real skill files in a fake home, real
   `SettingsManager`): non-empty allowlist loads only named skills, empty
   allowlist loads zero, absence loads the full set, unknown names load the
   known ones and warn (no failure).

Note: the workflow VM hands sandbox-realm arrays whose prototype differs from
the host `Array.prototype`, so `assert/strict`'s `deepEqual` flags them as
"same structure but not reference-equal"; the capturing runner coerces to a
host array via `Array.from` before asserting.

## Verification

`npm test` (biome check + tsc build + 1398 unit tests) passes — exit 0, no
regressions. New tests: 13.