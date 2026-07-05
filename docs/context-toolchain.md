# Context toolchain — keeping long Pi sessions alive

> **Status:** Reference — describes the context-handling companions that run
> alongside this repo's workflows. These are user-level Pi extensions and
> saved workflows, not source in this repo, but they form the *context tier*
> of the same system the workflow engine runs in.

The workflow runtime in this repo schedules agents, routes models, and
finalizes runs. It does not, by design, manage the **context window** of the
host Pi session that drives it. Two companions fill that gap, and both are
part of the same end-to-end loop:

1. **Autocompactor** — automatic context compaction with durable-artifact
   preservation, so a long session can be compacted without losing the
   founding request or the user's corrections.
2. **Hindsight memory** (`retain` / `recall` / `reflect`) plus the
   **`memory_gardener`** saved workflow — a long-lived, cross-session memory
   bank that survives compaction *and* survives process restarts, with a
   map-reduce gardener that keeps the bank from rotting.

Mental model: autocompactor keeps *this session* usable as the context window
fills; Hindsight keeps knowledge *across sessions*; the gardener keeps
Hindsight honest. The workflows in this repo run on top of both — they assume a
host session that can still reason (autocompactor) and a memory bank that
remembers what was already tried (Hindsight).

---

## 1. Autocompactor — in-session compaction with no silent loss

**Location:** user-level Pi extension at
`~/.pi/agent/extensions/autocompactor.ts`, backed by a Python bridge
(`pi_bridge.py`) and an `artifacts.py` module. It is a logic-minimal shim:
all analysis lives in the bridge; the extension only wires Pi events to it
and never lets a failure reach Pi (every handler is fully try/caught).

### Modes

- **`advise`** (default) — notify only; Pi's native compaction runs unchanged.
- **`actuate`** — self-trigger `ctx.compact` with bridge-built
  `customInstructions` (the verdict mode comes from the bridge's `evaluate`,
  overridable via `AUTOCOMPACTOR_PI_MODE`).
- **Native-auto interception** (`AUTOCOMPACTOR_PI_INTERCEPT=1`, default OFF)
  cancels Pi's native compaction and re-triggers it with the bridge's custom
  instructions. It is skipped when `@davidorex/pi-custom-compactor` is
  configured, so the two coexist passively.

### Pre-compaction accounting

Before any compaction fires, the bridge produces a **pre-compaction
accounting** of the context window, broken into three buckets:

- **Floor** — the irreducible base (system prompt, skills, per-package tool
  schemas probed via `floor-probe.json`). A compaction can only reclaim what
  sits *above* this floor (`POST_FLOOR` ≈ 70k tokens is the estimated
  post-compaction floor).
- **Tool output** — the dynamic ledger of per-tool/per-item results, each
  carrying `age_turns`, `dormant`, `redundant`, and `reclaimable` flags.
  Stale tool output (`STALE_FRAC` ≈ 0.90) is the primary reclaim signal.
- **Dormant** — content not recently touched; flagged for reclaim ranking.

The `/contextinventory` slash command renders this breakdown as a widget
above the editor (`/contextinventory no-probe` skips the floor probe for an
honest residual bucket). The compaction gate itself is zero-spawn: a pre-gate
in the extension mirrors the bridge's `SOFT_PCT` / `MIN_SAVINGS` / `COOLDOWN`
thresholds (window-aware: `SOFT_PCT_WIDE` for ≥300k-token windows) so a
compaction advise only fires when there is something meaningful to reclaim.

### Durable-artifact preservation to disk

The failure mode autocompactor exists to prevent: a native compaction
summarizes the transcript, and the summarizer quietly drops the user's
founding request or a critical mid-session correction. The bridge's
`artifacts.py` extracts **durable session artifacts** *before* compaction and
writes them to `~/.autocompactor/pi/artifacts/<session_id>.json`:

- **`initial_prompts`** — the user's founding request(s), **verbatim**.
- **`corrections`** — user redirects/preferences, **verbatim**.
- **`error_ledger`**, **`hex_constants`**, and other priority categories
  (priority order: `initial_prompts → corrections → error_ledger → …`).

On `session_compact`, the bridge `reinject`s a composed **artifact digest**
back into context as a persisted one-shot (`display: false` keeps it out of
the user-facing chat; it is for the model). The digest is trimmed by
priority to fit the re-injection budget, and a per-artifact size accounting
("preserved verbatim → disk (survive the summary): N initial prompt(s), M
corrections (~XB)") is appended to the post-compaction status line. The
extension awaits the `prepare` step before yielding to native compaction so
the reinject cannot race ahead and build a digest from stale/empty artifacts
(data loss guard).

### Post-compaction next-step

`session_compact` also surfaces an optional **next-step** recovered at
prepare time from the rich pre-compaction transcript (pending todo → last
user task → last correction). Gated by `NEXTSTEP` mode:

- **`off`** — never surface.
- **`advisory`** — surface a ready-to-run brief for the next human turn.
- **`autonomous`** (default) — immediately trigger a model turn after
  compaction, flushing the artifact digest explicitly with the resumed turn.

### `vcc_recall` — searching session history across compactions

Because compaction is lossy by definition, the durable artifacts and the
compacted summaries are only half the story — the *full pre-compaction
transcript* is still on disk and searchable. The **`vcc_recall`** tool searches
session history across compactions, with three scopes:

- **`lineage`** (default) — the active session lineage (the current
  compaction chain).
- **`all`** — the entire session, including off-lineage branches.
- **`compaction:N`** — within a specific compaction's message range;
  `compaction:latest` targets the most recent compaction segment.

Queries are regex; results are ranked by relevance, paginated, and
expandable (`expand:[indices]` returns full untruncated content for those
entries). Use it to recover a snippet the summarizer collapsed: "what did the
user actually say about the auth boundary before the second compaction?" is
a `vcc_recall` query, not a guess.

---

## 2. Hindsight memory — cross-session knowledge that survives restarts

**Location:** the `pi-hindsight` user-level Pi extension
(`~/.pi/agent/extensions/pi-hindsight/`), configured via `config.jsonc`
against the kneutral Hindsight server (`http://10.100.0.100:8888` on the
dev-net VLAN, no-auth on the LAN). Memory banks are namespaced per project
via dynamic bank IDs (e.g. `gt::sot-system`); a shared `shared-dev` bank
holds cross-project institutional knowledge.

Hindsight is hierarchical: raw memories consolidate into **observations**
(deduplicate and correct over time, grow slower than raw memories), and
**mental models** (cached reflections) are built on top of observations and
can be seeded at session start. The extension exposes three tools:

- **`retain`** — write a memory to a bank. Auto-retain runs on every turn;
  content stripping is configurable (the kneutral config strips thinking
  from retained assistant messages to cut tokens/cost).
- **`recall`** — fast, zero-cost, tag-filtered retrieval. Auto-recall runs
  on every prompt and injects relevant memories (ephemerally by default, or
  persisted as collapsible blocks) wrapped in `<hindsight_memories>` fences.
  The kneutral config uses project-scoped recall tags so stale banks from
  other projects do not bleed into a run.
- **`reflect`** — synthesize an answer / mental model from memories with an
  LLM. Used for deep synthesis; auto-recall is intentionally shallow and
  cheap (a low per-turn injection budget) so reflect is the deep-retrieval
  path.

The kneutral config **disables the `recall` tool** (auto-recall covers it)
and enables only `retain` and `reflect` — a deliberate choice to keep the
tool surface small and force synthesis through `reflect`.

### `memory_gardener` — map-reduce staleness auditing over the bank

A memory bank that only grows eventually rots: near-duplicates accumulate,
ephemeral CI/PR/run-status memories go stale, and contradictory
current-state claims appear as the system changes. The **`memory_gardener`**
saved workflow (`~/.pi/workflows/saved/memory_gardener.json`) is a fan-out
map-reduce gardener over the Hindsight API. It runs in five phases:

1. **Manifest** (small tier) — fetch *only* the memory id list + light
   metadata (not full bodies), shard it, write the full manifest to a file,
   and return a tiny JSON ack `{ok, path, total, fetched, shardCount}`. The
   file is the handoff — the ack carries no payload. Sampling modes:
   - **`recent`** (default) — page the list endpoint most-recent-first.
   - **`probe`** — issue a `POST .../memories/recall` per supplied probe
     query string (~40 results each), deduping ids across probes. This is
     **probe-based semantic sampling**: instead of paging the whole bank,
     you target the topics you care about.
   - **`window`** — keep only memories whose `date` falls in an inclusive
     `[from, to]` ISO window.

   In every mode, collection skips memories whose `state` is `invalidated`
   **and** memories whose `fact_type` is `observation`: observations are
   derived and regenerate from their source facts, and the Hindsight API
   only allows curation of world/experience facts — so observations are
   never gardened.
2. **Shards** (small tier, parallel) — each shard agent extracts its shard
   from the manifest, fetches those memories **fully** by id (the manifest's
   preview is truncated and is not the body), and identifies candidate
   staleness clusters among those memories only:
   - **`near_duplicate`** — 2+ memories stating essentially the same fact.
   - **`contradiction`** — 2+ memories with the same subject but
     different/incompatible claims.
   - **`expired_ephemera`** — CI/PR/run-status/ephemeral execution state
     older than 14 days.
   Each shard writes its clusters to a file and returns a tiny ack.
3. **Judge** (medium tier, batched parallel ≤4 judges) — read the candidate
   cluster files and emit one of four actions per member memory: `keep`,
   `supersede` (loser → survivor), `expire` (stale ephemera, no successor),
   or `flag_contradiction`. Writes actions to a file; tiny ack.
4. **Apply** (only if `apply=true`) — a small agent reads the action files,
   filters to `supersede`/`expire` **only**, caps at **25 PATCHes per run**,
   and executes reversible soft-invalidations
   (`PATCH .../memories/{id}` with `{state:"invalidated", reason}` — there is
   no hard delete per-memory). **Report-only by default** (`apply=false`
   performs no mutations). `flag_contradiction` rows are **never applied**,
   even when `apply=true`.
5. **Report** (small tier) — read the action files (and apply result) and
   produce a concise human-readable summary with action counts, applied
   count, notable examples, and a "Contradictions flagged (human review
   required)" section.

### The `flag_contradiction` rule — memories cannot establish present ground truth

This is the most important rule in the gardener, and it is enforced in the
judge prompt as a **critical rule**:

> Dated event memories do not prove currentness. If members disagree about
> what is **currently** true, emit `flag_contradiction` for all members
> involved — do **not** resolve it. Only a human or an external
> ground-truth check can resolve it.

Judges never pick a winner between conflicting current-state claims (model
tiers, endpoints, registrations, statuses). A memory that says "the auth
endpoint is /v1/auth" and a later memory that says "the auth endpoint is
/v2/auth" are both flagged — the gardener does not assume the newer one is
correct, because a dated memory is a claim about what was true *then*, not a
ground-truth probe of what is true *now*. Flagged contradictions surface in
the report for human review; the gardener's gated apply path will never
silently invalidate one side of a current-state dispute.

### Gated apply — report-only default, capped reversible soft-invalidations

The gardener is **report-only by default** (`apply=false`). Even with
`apply=true`, the apply path is bounded:

- **Capped** at 25 PATCHes per run (a single gardener run can never
  invalidate a whole bank).
- **Reversible** — the only mutation is `state: "invalidated"`, a
  soft-retire; the memory body and history remain retrievable. There is no
  hard delete per-memory in the Hindsight API.
- **Filtered** — `flag_contradiction` rows are always skipped, never applied
  or patched, even when `apply=true`.
- **Scoped** — `supersede`/`expire` only; `keep` is a no-op.
- **Verified** — an apply counts only after the PATCH returns HTTP 2xx *and*
  a re-GET confirms `state == "invalidated"` (verify-after-write). Failures
  are reported honestly as `failedApply` with the API's error detail — never
  folded into the applied count. (This rule exists because the first live
  apply run showed that word-matching a success phrase in response bodies
  silently counted API rejections as successes.)

This makes gardening a safe, repeatable hygiene operation: run it
report-only to see what's stale, then run with `apply=true` to retire
provably-redundant and provably-expired memories, while leaving anything
ambiguous for a human.

---

## 3. How they compose with this repo's workflows

A workflow run in this repo assumes a host session that can still reason
and a memory bank that remembers prior attempts. The three tiers stack:

- **Within a turn** — the workflow engine schedules agents; the host
  session's context window is governed by autocompactor.
- **Across compactions** — durable artifacts survive verbatim on disk and
  are re-injected as a digest; `vcc_recall` recovers anything the digest
  couldn't carry.
- **Across sessions / restarts** — Hindsight retains what was learned;
  auto-recall injects relevant memories on the next prompt; `reflect`
  synthesizes deep answers; `memory_gardener` keeps the bank from rotting.

The gardener's `flag_contradiction` rule is the same posture this repo takes
in its review workflows: reviewers do not establish ground truth by
consensus, they flag disputes for evidence. Memories are claims, not
verdicts — exactly the discipline encoded in
[`docs/prompt-guidance-style.md`](./prompt-guidance-style.md) ("Ground Claims
in Evidence") and in the adversarial-review evidence mode.
