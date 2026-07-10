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

- ❌ "Done — the bug is gone." → ✅ "Re-ran the repro: 0 failures (was N). Fixed."
- ❌ "Nothing else calls this." → ✅ "`grep` finds no other callers in `src/` (didn't check generated code)."

## Separate Facts from Decisions

Facts include tool/file results and time-scoped observations such as current CI status — always cite the command or source and observation context. Decisions are human choices: preferences, approvals, policy/routing tradeoffs. Never classify CI pass/fail as a decision. Cross-reference 'Ground Claims in Evidence' for the proof requirement.

**Anti-patterns:**

- "Tier routing is set correctly." (No `modelTierConfig` was read — assumption.)
- "CI is green, so the build passes." (The CI result was not checked — guess.)

**Say this, not that:**

- ❌ "The model tier mapping is correct." → ✅ "Read `modelTierConfig`: tier assignments verified against the saved config."
- ❌ "CI passed." → ✅ "`npm test` returned 0 failures (verified)."

## Human-in-the-Loop is AFK-Safe

Gate a consequential human decision on `checkpoint()`, but never let it silently approve: a background/detached run has no human present, so `checkpoint()` replays its journaled default. Therefore every consequential checkpoint MUST pass an explicit conservative default (normally `default: false` for any ship/merge/delete/proceed gate) or `headless: 'abort'` — do NOT rely on the implicit `default ?? true`, which proceeds as approved. Gather all facts autonomously BEFORE the decision gate. Recorded human choices are immutable constraints, not inferred facts — never re-derive or override them later in the run. Do NOT block on undefined human input or spin-poll.

**Anti-patterns:**

- "Please confirm this PR is ready." (Sent to a background run with no UI — it will never get a response and the run hangs or times out.)
- `checkpoint('Ship?')` with no default in a background run — replays the implicit `true` and ships without a human. (Silent approval.)
- Polling a checkpoint in a loop without a default. (Run spins on undefined input until timeout.)
- Re-deriving a recorded human choice later in the run and overriding it.

**Say this, not that:**

- ❌ `checkpoint('Ship the PR?')` in a background run → ✅ `checkpoint('Ship the PR?', { default: false })` so an AFK run declines instead of shipping.
- ❌ `checkpoint('Proceed?', {})` relying on `default ?? true` → ✅ `checkpoint('Proceed?', { default: false })` or `checkpoint('Proceed?', { headless: 'abort' })`.
- ❌ Blocking an agent on human input in a detached workflow → ✅ Return explicit decision points or `needs-human` instead of inventing preferences.

## Expand-Contract Only for Wide Mechanical Refactors

EXPAND the new API/form beside the old, MIGRATE callers in independently green bounded batches, then CONTRACT/delete the old form. It never means propose candidates, grill one, arbitrary 10+ file thresholds, or compaction policy. Use it only as a planning exception for wide mechanical refactors; ordinary feature/bug work stays thin vertical steps. Dependency ordering must keep CI green.

**Anti-patterns:**

- Expand-contract for a single-file edit. (Overhead with no benefit — the file fits in context.)
- Using expand-contract for feature work or bug fixes. (It's a planning exception, not a default strategy.)

**Say this, not that:**

- ❌ Expand-contract because a change touches several files → ✅ Use it only when old and new forms must coexist while independently green caller batches migrate.
- ❌ No dependency ordering on the contract phase → ✅ Sequence contract steps to keep CI green across batches.

## Avoid Tautological Tests

The expected value must come from an independent source of truth (a spec, a known constant, a hand-computed oracle); never recompute the same way as the code under test. This is **guidance** for when tests are written, not a requirement to write tests first.

**Anti-patterns:**

- `expect(add(a, b)).toBe(a + b)` (The oracle is computed the same way — a tautology that passes regardless of correctness.)
- Testing `formatDate(new Date())` with `expect(result).toMatch(/\d{4}-\d{2}-\d{2}/)` when the same logic is used to build the expected value.

**Say this, not that:**

- ❌ `expect(add(a, b)).toBe(a + b)` (reuses the code under test as the oracle — proves nothing) → ✅ `expect(add(2, 3)).toBe(5)` (independent hand-checked literal).
- ❌ "This test is tautological" → ✅ "The oracle `a+b` uses the same `add` logic; replace with a hand-checked constant like `expect(add(2,3)).toBe(5)`."

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
