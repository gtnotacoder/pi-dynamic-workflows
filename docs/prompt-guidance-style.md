# Prompt & Skill Guidance Style

> **Status:** Reference — describes current shipped behavior.

How we write behavioral guidance for agents (system prompts, workflow specialist
definitions, `promptGuidelines`, skill docs). Borrowed *structure* from gstack's
ETHOS — **not** its content. (gstack's "Boil the Ocean" is wrong for us: we run on
token budgets, so completeness-at-any-cost is an anti-goal.)

## Why this format

Abstract principles ("be careful", "be thorough") barely move model behavior.
What moves it is **concrete negative exemplars**: show the wrong move and the
corrected phrasing side by side. Every principle gets three parts:

1. **Principle** — one sentence, imperative, falsifiable.
2. **Anti-patterns** — the specific wrong behaviors, quoted as the model would phrase them.
3. **Say this, not that** — the corrected move.

## Template

```md
## <Principle name>

<One imperative sentence stating the rule and why.>

**Anti-patterns:**
- "<thing a model would say/do that violates the rule>" (<why it's wrong>)
- "<another>" (<why>)

**Say this, not that:**
- ❌ <wrong phrasing> → ✅ <corrected phrasing>
```

## Worked example (one of ours)

## Ground Claims in Evidence

State only what a tool result or read file supports; mark inference as inference.

**Anti-patterns:**

- "This is fixed." (No verification was run — claim is unproven.)
- "The function is unused." (Grep wasn't run across the repo — assumption.)
- Framing a guess as settled fact in a confident summary.

**Say this, not that:**

- ❌ "Done — the bug is gone." → ✅ "Re-ran the repro 5×: 0 failures (was 3/5). Fixed."
- ❌ "Nothing else calls this." → ✅ "`grep` finds no other callers in `src/` (didn't check generated code)."

## Verdicts, not payloads (the agent-result channel)

> The agent-result channel — what a workflow's `agent()` call returns to the
> script — is for **verdicts**, not payloads. Anything over ~10KB goes to a
> file; the ack is `{ok, path, count}`.

This is the workflow-authoring rule learned this cycle. It applies to every
fan-out agent that produces a structured artifact (manifests, cluster maps,
action lists, digests, reports) and to the workflow's own final return
value.

**Why.** A workflow script parses agent results deterministically
(`extractJson` + `JSON.parse`). A >10KB JSON payload in the agent-result
channel gets truncated by the transport, and a truncated JSON document does
not parse — the script then sees `null` and either silently skips work or
throws a generic "unparseable" error far from the real cause. The failure
mode is subtle: the agent *did* the work, the file would have been fine, but
the result never made it back through the channel intact. Keeping the
channel to a tiny ack and putting the payload on disk decouples "the work
succeeded" from "the channel survived."

**Anti-patterns:**

- Returning the full manifest/cluster/action list in the agent response
  ("here's everything I found" — 50KB of JSON in a 120KB channel).
- `return { ...fullResults }` from the workflow itself when `fullResults` is
  a large array.
- Piping a model's full prose summary back as the workflow result.

**Say this, not that:**

- ❌ Return the manifest in the response → ✅ Write the manifest to a file,
  return `{"ok":true,"path":"/tmp/.../manifest.json","total":N,"fetched":M,"shardCount":K}`.
- ❌ `return { ok: true, clusters: <huge array> }` → ✅ Write clusters to a
  file, return `{"ok":true,"path":"...","count":N}`.
- ❌ A final workflow return of `{ summary: <5000-word prose> }` → ✅ Write
  the prose to a file, return `{ ok: true, path, summary: "<one-line>" }`.

**Rule of thumb:** if the agent's output is a *thing* (a manifest, a list, a
report), it goes to a file and the ack carries `{ok, path, count}`. If the
agent's output is a *verdict* (pass/fail, a score, a one-line decision), it
can ride the channel directly.

## Rules for writing these

- Keep each principle to <10 lines. If it needs more, it's two principles.
- Anti-patterns must be **quotable** — write them in the model's voice.
- Prefer measurable corrected phrasings (numbers, commands, file paths) over adjectives.
- Don't import another project's values wholesale. Each principle must earn its place
  against *our* constraints (token budget, real-provider verification, user sovereignty).
- One source of truth: link to this file from prompt docs rather than restating the format.
