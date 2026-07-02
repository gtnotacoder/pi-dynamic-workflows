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

## Rules for writing these

- Keep each principle to <10 lines. If it needs more, it's two principles.
- Anti-patterns must be **quotable** — write them in the model's voice.
- Prefer measurable corrected phrasings (numbers, commands, file paths) over adjectives.
- Don't import another project's values wholesale. Each principle must earn its place
  against *our* constraints (token budget, real-provider verification, user sovereignty).
- One source of truth: link to this file from prompt docs rather than restating the format.
