# Docs & Glossary workstream — release 0.2.1

Commit: `8b5bf91` on `chore/0.2.1-cleanup`.

## Deliverables

### A) `docs/context-toolchain.md` (NEW)
Documents the context-handling companions that make long Pi sessions work,
framed as the context tier of the same system this repo's workflows run in.

- **Autocompactor** (`~/.pi/agent/extensions/autocompactor.ts` + Python bridge):
  modes (`advise`/`actuate`, native-auto interception OFF by default);
  pre-compaction accounting (floor / tool-output / dormant buckets, window-aware
  `SOFT_PCT_WIDE`, `/contextinventory` widget); durable-artifact preservation
  to disk (`initial_prompts` and `corrections` verbatim, priority-ordered
  re-injection digest, await-prepare data-loss guard); post-compaction
  next-step (`off`/`advisory`/`autonomous`); and the `vcc_recall` tool with its
  `lineage` / `all` / `compaction:N` scopes.
- **Hindsight memory** (`retain`/`recall`/`reflect`, kneutral `config.jsonc`:
  recall tool disabled, project-scoped auto-recall tags, hierarchical
  observations → mental models) and the **`memory_gardener`** saved workflow:
  five-phase map-reduce (Manifest → Shards → Judge → Apply → Report), three
  sampling modes (`recent`/`probe`/`window`), three cluster kinds
  (near_duplicate/contradiction/expired_ephemera), the `flag_contradiction`
  rule (judges never resolve conflicting current-state claims; memories cannot
  establish present ground truth), and gated apply (report-only default, capped
  25 reversible soft-invalidations per run, `flag_contradiction` never applied).
- Composes the three tiers: within-turn (workflow engine), across-compaction
  (autocompactor + vcc_recall), across-restarts (Hindsight + gardener).

### B) Authoring payload rule added to `docs/prompt-guidance-style.md`
New section "Verdicts, not payloads (the agent-result channel)": the
agent-result channel is for verdicts, not payloads; anything over ~10KB goes to
a file; the ack is `{ok, path, count}`. Includes the failure mode it prevents
(truncated JSON in the channel killing deterministic `extractJson`/`JSON.parse`
parsing — the agent did the work but the result never made it back intact),
anti-patterns, and "say this, not that" exemplars matching the existing
format. Placed before the "Rules for writing these" section.

### C) `CONTEXT.md` (NEW, repo root)
Pure glossary (ubiquitous language), no implementation details. One term, one
crisp definition each. Covers all requested terms — harness, harness
descriptor, herdr, conductor, fugu, issue delivery, closed-loop delivery,
hopper, clean-skip, prototype mode, scout firewall, model tiers, worktree
isolation, workflow lock, agent-result channel, effort mode, gardener — plus
others found while reading README/docs/src headers: flag_contradiction, gated
apply, context mode, agentType, tool policy, local checks, verifier,
correction delta, finalization gate, semantic status, task panel, task
notification, saved workflow, DAG scheduler, journal/resume, autocompactor,
durable artifact, hindsight. Header notes the glossary follows Matt Pocock's
domain-modeling skill (https://github.com/mattpocock/skills).

### README.md
Added a "Docs index" section near the top linking CONTEXT.md and
docs/context-toolchain.md (plus the existing architecture/context-modes/catalog
/prompt-guidance-style deep-dives).

## Verification
- No docs build/lint in this repo: biome.json ignores Markdown (only TS/JS are
  linted), so `npx biome check` on the touched `.md` files is a no-op by
  config (confirmed — "No files were processed … ignored by the configuration").
- No source files changed, so `npm run check:workflow-lock` is unaffected.
- `git add -A && git commit` clean; one commit `8b5bf91`.

## Files
- `CONTEXT.md` (new)
- `docs/context-toolchain.md` (new)
- `docs/prompt-guidance-style.md` (modified — added "Verdicts, not payloads" section)
- `README.md` (modified — added Docs index section)