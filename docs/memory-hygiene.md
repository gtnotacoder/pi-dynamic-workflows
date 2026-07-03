# Memory hygiene — Hindsight retain discipline, injection tuning, and the memory_gardener

> **Status:** Binding policy — governs what this repo's agents retain into Hindsight memory and how the `memory_gardener` workflow keeps banks from rotting. See also [Supervisor telemetry env](supervisor-telemetry-env.md) for the *plumbing* of Hindsight env vars; this doc is about *content discipline*.

Hindsight memory is a long-lived shared asset (per-project bank plus the cross-project `shared-dev` bank). It is valuable only if it holds durable knowledge and is actively weeded of ephemeral noise. This doc defines the taxonomy, the retain rules, the injection tuning that keeps recall cheap, and the `memory_gardener` workflow that performs Graphiti-style eager staleness resolution.

## 1. Durable-vs-ephemeral fact taxonomy

Before retaining anything, classify it.

**Durable — retain.** These survive re-reads months later and change how future sessions should behave.

- **Decisions** — "we chose OpenTofu over Terraform", "issue-delivery finalization treats `.fugu/` as a transient path". Include the *why*, not just the *what*.
- **Preferences** — "use `uv` not `pip`", "prefer targeted tests during review, full `npm test` for broad changes".
- **Architecture contracts** — invariants reviewers must enforce: "reviewers must be read-only by tool policy, not by prompt text", "resume/journal hashing must invalidate on changed tool policy or context mode".
- **Hard-won lessons** — a non-obvious failure mode and its fix: "blank `HINDSIGHT_API_URL` under `inherit` is silently disabled; use `required-url` when telemetry is mandatory".

**Ephemeral — never retain.** These describe a momentary state that is stale by the next session.

- **CI results** — "the build is green on commit abc123", "biome check passed at step 3".
- **PR states** — "PR #42 is draft", "PR #55 CI is pending", "the PR was merged".
- **Run/liveness** — "issue-delivery run mqw97i6m is running", "the Worker is on attempt 2".
- **Transient file states** — "the Verifier flagged line 88 of `harness-env.ts`". This belongs in the run transcript, not the memory bank.

If a fact would be wrong (not merely incomplete) one week later, it is ephemeral. Do not retain it.

## Examples

**Good durable retain** (decision, dated, with why):
> `as of 2026-07-03: finalization opens a draft PR and never pushes to main. Why: review protection — a direct push bypasses the Verifier gate and the PR head SHA check.`

**Good supersession** (explicit, names the prior claim):
> `supersedes "gardener hard-deletes stale memories" — the Hindsight API has no per-memory hard delete; retirement is PATCH state=invalidated (reversible).`

**Bad retain — ephemeral** (do NOT retain):
> ~~`PR #55 CI is pending`~~ — transient; will be wrong within an hour. Belongs in the task panel.
> ~~`issue-delivery run mqw97i6m is running on attempt 2`~~ — run state; lives in the run transcript.

**Bad retain — undated claim** (do NOT retain without a date):
> ~~`finalization treats .fugu/ as transient`~~ — add `as of YYYY-MM-DD` so staleness is detectable.

## 2. Retain rules

When you retain a durable fact, follow these rules so the bank stays queryable and self-updating.

- **Date every fact.** Lead with `as of YYYY-MM-DD` so a reader knows the freshness without guessing. Example: `as of 2026-07-03: issue-delivery normal path is Scout→Thinker→Worker→LocalChecks→Verifier→PR→finalization`.
- **Supersede explicitly.** When a new fact replaces an old one, phrase it as `replaces ...` / `supersedes ...` and name the prior claim. Example: `supersedes "finalization pushes to main" — finalization opens a draft PR, never pushes to main`. Never leave two contradictory durable claims co-existing silently.
- **Never retain transient pipeline state.** No CI pass/fail, no PR open/draft/merged state, no "X is running". These go in transcripts and task panels, not memory. If you need to remember *that* a pipeline exists or *how* it behaves, retain the durable contract instead ("finalization refuses to push when remote HEAD differs from PR head SHA").
- **Keep it crisp.** One durable claim per retain, with the why. No narrative of the session that discovered it.

## 3. Injection tuning rationale

Recall injects memories into every turn. Untuned, it bloats context and crowds out the actual task. The tuning used on this VM:

- **`autoRecallBudget` set low** — recall runs cheaply on most turns; a low budget means only high-relevance memories surface automatically, instead of dumping the whole bank.
- **`maxRecallTokens` ≈ 1200** — caps the per-turn recall injection so a large bank cannot saturate the prompt. 1200 tokens is enough to surface 2–4 crisp durable facts and their dates, and no more.
- **`reflect` for deep synthesis, not every turn** — reflective recall (the heavier, synthesizing pass) is reserved for moments that actually warrant it: end-of-issue retrospectives, architecture decisions, gardener runs. Routine turns get the cheap recall only.

The goal is *signal per token*: durable facts with dates, not ephemeral status dumps.

## 4. The `memory_gardener` workflow

`memory_gardener` is a saved workflow (`~/.pi/workflows/saved/memory_gardener.json`) that performs Graphiti-style eager staleness resolution over the Hindsight API. It does not wait for contradictions to accumulate; it actively inventories and resolves them.

**Posture — report-first, gated apply.** By default (`apply=false`) it inventories and judges but mutates nothing, returning a compact summary. Set `apply=true` to execute curated `PATCH state=invalidated` calls, capped at 25 per run. This makes the gardener safe to run read-only on shared banks before committing to any retirement.

**Tiers — cheap.** Inventory runs on the `small` tier (list memories, spot-check history); judging runs on `medium` (decide keep/supersede/expire per cluster); apply runs on `small` (execute curl PATCH). No `big`-tier spend — gardening is mechanical, not synthesis-heavy.

**Graphiti-inspired eager invalidation.** The gardener models three staleness kinds and resolves each:

- **near_duplicate** — 2+ memories stating the same fact. Action: `supersede` — keep the newest/correct member, `expire` the older ones with `supersededBy=<kept id>`.
- **contradiction** — same subject, incompatible claims. Action: `supersede` keeping the most recently stated correct claim; expire the rest.
- **expired_ephemera** — CI/PR/run-status memories older than 14 days. Action: `expire` on all members. (These ideally were never retained per §2; the gardener is the safety net.)

Semantics map to the Hindsight API's soft-retire: `PATCH /memories/{id}` with `{state:"invalidated", reason:"..."}`. There is no hard delete — retirement is reversible, so a bad gardening call can be undone. Memories already in `invalidated` state are skipped.

**Run shape:** four phases — `Inventory` (confirm endpoints, list recent, spot-check history, identify clusters) → `Judge` (emit per-memory actions, ≤25) → `Apply` (only if `apply=true`) → `Report` (compact summary: `clusters=N actions=M keep=K retire=R applied=A`). On shared banks, run report-first first, review the summary, then re-run with `apply=true` if the actions look right.

**Quick reference**

| Signal | Class | Action |
|---|---|---|
| Decision / preference / contract / lesson, dated | Durable | Retain with `as of YYYY-MM-DD` |
| Newer claim replaces older one | Durable | Retain with `supersedes "<prior claim>"` |
| CI pass/fail, PR state, "X is running" | Ephemeral | Do not retain; use transcript/panel |
| 2+ memories, same fact | near_duplicate | Gardener: `supersede` (keep newest) |
| 2+ memories, same subject, incompatible | contradiction | Gardener: `supersede` (keep correct) |
| CI/PR/run-status memory > 14 days | expired_ephemera | Gardener: `expire` all members |