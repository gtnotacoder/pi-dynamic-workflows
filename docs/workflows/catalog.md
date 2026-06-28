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
| `/closed_loop_issue_delivery` | `/fugu_closed_loop` | saved workflow | `~/.pi/workflows/saved/closed_loop_issue_delivery.json` | active | Issue/plan-driven closed-loop delivery. Accepts `prototype=true` only for explicit harness smoke runs; legacy `/fugu_closed_loop` remains installed. |
| `/surgical_pr_repair` | `/fugu_repair` | saved workflow | `~/.pi/workflows/saved/surgical_pr_repair.json` | active | Repair loop for existing PR/worktree failures; legacy `/fugu_repair` remains installed. |
| `/pr_adversarial_review` | — | saved workflow | `~/.pi/workflows/saved/pr_adversarial_review.json` | active | Exposes detailed knobs plus `prototype=true` mapping for ad-hoc smoke reviews. Explicit `reviewDepth`, `maxWaves`, `maxCandidates`, `externalEvidence`, `useGemini`, and `commentPolicy` still override defaults. |
| `/workflow_trace_analyzer` | `/workflow_trace_analyser` | saved workflow | `~/.pi/workflows/saved/workflow_trace_analyzer.json` | active | American-spelled canonical trace analyzer; legacy `/workflow_trace_analyser` remains installed. |
| `/evidence_adversarial_review` | — | saved workflow | `~/.pi/workflows/saved/evidence_adversarial_review.json` | active | Source-backed adversarial validation. |
| `/frontend_radix_shadcn_review` | — | saved workflow | `~/.pi/workflows/saved/frontend_radix_shadcn_review.json` | active | Frontend-specific review harness. |

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
4. Keep transient `.fugu/` ignored until old worktrees age out; new built-ins use
   `.issue-delivery/`.
5. Use `prototype=true` / `--prototype` only for ad-hoc harness prototyping runs
   so the review system does not spend merge-gate effort on naming/catalog smoke
   tests. Normal delivery remains issue/plan driven.
