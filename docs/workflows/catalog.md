# Workflow catalog and naming lock

This catalog is the operator-facing source of truth for workflow names while the
legacy Fugu/Trinity vocabulary is migrated to descriptive Issue Delivery terms.
Fugu/Trinity remain historical inspirations only; canonical command names should
say what the workflow does.

## Naming rules

| Surface | Convention | Example |
|---|---|---|
| Built-in slash command | kebab-case verb/noun | `/issue-delivery` |
| Saved workflow command/file | snake_case noun phrase | `/closed_loop_issue_delivery` |
| Agent type | kebab-case markdown file | `specialized-worker` |
| Script filename | kebab-case | `tmux-conductor-batch.sh` |
| TypeScript symbol | descriptive Pascal/camel case | `generateIssueDeliveryWorkflow` |

Legacy names stay as compatibility aliases for one migration window and should
warn or document that they are deprecated.

## Prototype / ad-hoc operating lane

The normal production path is issue/plan driven: a GitHub issue has an associated
plan markdown file, the closed-loop delivery workflow executes that plan, and PR
review/repair gates validate the result. Do not turn this into a broad
"intensity ladder" for normal work.

`prototype` is a separate ad-hoc lane for harness development, smoke tests, and
small repo-local experiments that are not yet worth formalizing as an issue plan.
It controls breadth/cost only. It must not weaken read-only/edit boundaries or
context security posture; use `--mode focused|scoped|isolated|legacy` for context
posture.

| Lane | Invocation | Purpose | Mapping |
|---|---|---|---|
| Plan-driven | issue + plan markdown through closed-loop delivery | Normal feature/bug delivery | Existing adaptive review/repair defaults. |
| Prototype/ad-hoc | `/issue-delivery --prototype ...` or saved workflow `prototype=true` | Harness development and small experiments | Fewer retries/reviewers, lower verifier tier where safe, no PR comments unless explicitly requested. |

Explicit detailed knobs (`reviewDepth=`, `maxWaves=`, `useGemini=`, etc.) still win
over the prototype default when a saved workflow exposes them.

## Canonical workflows

| Canonical | Legacy aliases | Kind | Source | Status | Notes |
|---|---|---|---|---|---|
| `/issue-delivery` | `/fugu` | built-in command | `src/issue-delivery.ts` | active | DAG issue-to-draft-PR workflow. `/fugu` remains a deprecated alias. Supports the ad-hoc `--prototype` lane. |
| `/deep-research` | — | built-in command | `src/builtin-commands.ts` | active | Multi-agent web research with cross-checked sources. Read-only + web-only: every agent runs against read-only repo tools plus `web_search`/`web_fetch` and no agent receives `write`. Verify returns bounded supported claims (max 3, each claim ≤140 chars, ≤2 source URLs each ≤200 chars) and discards citations not present in Gather evidence; empty pages do not consume source slots and overlong URLs are rejected rather than truncated. worst-case four-byte Unicode payloads remain below 10KB. Report returns one bounded candidate summary, but the host acknowledgement derives its summary from retained cited evidence. The host re-fetches retained citations, drops failed/empty responses, flattens/escapes claims, and deterministically renders cited Markdown into a fresh private `tmpdir` directory via an injectable writer, and returns the absolute path; no `.pi/workflows/research` writes and no model-controlled path. Workflow script in `src/deep-research.ts`. |
| `/adversarial-review` | — | built-in command | `src/builtin-commands.ts` | active | Investigate a task, then cross-check each finding with skeptical reviewers. Workflow script in `src/adversarial-review.ts`. |
| `/code-review` | — | built-in command | `src/builtin-commands.ts` | active | Multi-angle code review with independent verification and synthesis. Workflow script in `src/code-review.ts`. |
| `/workflow-telemetry-report` | — | built-in command | `src/workflow-telemetry-command.ts` | active | Summarize workflow cache, cost, context, trace, and compaction telemetry. Report engine in `src/workflow-telemetry-report.ts`. |
| `/issue_delivery` | — | saved workflow | `~/.pi/workflows/saved/issue_delivery.json` | active | Saved implementation engine (Scout→Thinker→Worker→LocalChecks→Verifier→Telemetry) invoked inline by `/closed_loop_issue_delivery` via `workflow('issue_delivery')`. Promoted from `issue-delivery-lc`, which remains installed as a local variant. |
| `/closed_loop_issue_delivery` | `/fugu_closed_loop` | saved workflow | `~/.pi/workflows/saved/closed_loop_issue_delivery.json` | active | Issue/plan-driven closed-loop delivery. Implementation delegates to the saved `issue_delivery` engine (no dependence on the deprecated `/fugu` alias). Accepts `prototype=true` only for explicit harness smoke runs; legacy `/fugu_closed_loop` remains installed. |
| `/surgical_pr_repair` | `/fugu_repair` | saved workflow | `~/.pi/workflows/saved/surgical_pr_repair.json` | active | Repair loop for existing PR/worktree failures; legacy `/fugu_repair` remains installed. |
| `/pr_adversarial_review` | — | saved workflow | `~/.pi/workflows/saved/pr_adversarial_review.json` | active | Exposes detailed knobs plus `prototype=true` mapping for ad-hoc smoke reviews. Explicit `reviewDepth`, `maxWaves`, `maxCandidates`, `externalEvidence`, `useGemini`, and `commentPolicy` still override defaults. |
| `/workflow_trace_analyzer` | `/workflow_trace_analyser` | saved workflow | `~/.pi/workflows/saved/workflow_trace_analyzer.json` | active | American-spelled canonical trace analyzer; legacy `/workflow_trace_analyser` remains installed. |
| `/evidence_adversarial_review` | — | saved workflow | `~/.pi/workflows/saved/evidence_adversarial_review.json` | active | Source-backed adversarial validation. |
| `/frontend_radix_shadcn_review` | — | saved workflow | `~/.pi/workflows/saved/frontend_radix_shadcn_review.json` | active | Frontend-specific review harness. |
| `/foundation_ui_compliance` | — | saved workflow | `~/.pi/workflows/saved/foundation_ui_compliance.json` | active | Universal design-system compliance delivery engine: Gate-Diagnose → scoped Fix ↔ Re-gate → frontier visual verify → Deliver (opt-in) → Receipt. **Generic template: [`templates/foundation_ui_compliance.workflow.mjs`](templates/foundation_ui_compliance.workflow.mjs)**; setup guide + the Foundation Gate Contract any design-system repo can implement: [`foundation-ui-compliance.md`](foundation-ui-compliance.md). Gates run only through the single entrypoint in the app's **vendored** foundation (`<foundation>/scripts/run-foundation-gates.mjs`) — the foundation owns the gate list, so foundation changes propagate with zero workflow edits. All app/org specifics arrive via `args`/per-repo harness JSON, never in the engine; orgs keep a pinned, CI-gated template of record in their own foundation repo and reinstall after updates. |

## Drift check

Run the warning-mode lock checker after changing workflow names, aliases, or
repo-local workflow sources:

```text
npm run check:workflow-lock
```

It validates lock shape, duplicate commands, alias metadata, and sha256 drift for
repo-local sources. External saved workflows under `~/.pi/workflows/saved/` are
recorded for operator visibility but are warning-only because they are local
installation state.

## Migration guardrails

1. Add canonical commands before deleting legacy names.
2. Legacy commands should call canonical implementations and warn when practical.
3. New docs and trace metadata should use canonical names.
4. Transient workflow scratch state lives under `.issue-delivery/` only.
   `.fugu/` is fully retired (#104): nothing writes it, it is no longer
   git-ignored or lint-excluded, and a worktree still containing it blocks
   finalization until cleaned. The discontinued Microsoft exploration tool
   is no longer referenced by this project; the Scout phase now uses the
   codegraph exploration stack (codegraph_*, ffgrep/fffind, ctx_read) instead.
5. Use `prototype=true` / `--prototype` only for ad-hoc harness prototyping runs
   so the review system does not spend merge-gate effort on naming/catalog smoke
   tests. Normal delivery remains issue/plan driven.

## Lock schema notes

The companion `docs/workflows/workflow-lock.json` records canonical names,
commands, kinds, sources, aliases, and (for repo-local sources) sha256 hashes.
The following schema and policy rules keep the catalog deterministic across
installs:

- **Registration order:** built-in commands register before saved workflows.
  This is codified in `collisionPolicy.registrationOrder`.
- **Saved workflow command collisions** are not silently shadowed: when a saved
  workflow's name collides with an already-registered command, the saved
  workflow is skipped and the user gets a warning
  (`collisionPolicy.savedWorkflowCommandCollision = "skip-and-warn"`).
- **Deprecated aliases** are compatibility metadata only. They must not silently
  shadow saved workflows; alias collisions surface as warnings
  (`collisionPolicy.aliasCollisionSeverity = "warning"`).
- **`version`** is only expected for `builtin-command` (package-shipped) entries.
  A `version` on a non-`builtin-command` entry is flagged as a warning by the
  lock checker.
- **Reserved `kind` values:** `builtin-command`, `bundled-template`,
  `saved-workflow`, `harness-metadata`, and `deprecated-alias`. The lock
  checker rejects entries whose `kind` is outside this set.
  `bundled-template`, `harness-metadata`, and `deprecated-alias` are reserved
  for future use and not necessarily populated today.
- **External saved workflows** under `~/.pi/workflows/saved/*.json` are
  declarative/operator-visibility only, not package-shipped APIs. Their sources
  are recorded in the lock with `sha256: null` and are warning-only in the drift
  checker, because their contents are local installation state.
