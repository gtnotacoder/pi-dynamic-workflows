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

## Operator intensity profiles

Intensity controls breadth/cost. It must not weaken read-only/edit boundaries or
context security posture; use `--mode focused|scoped|isolated|legacy` for context
posture.

| Profile | Aliases | Purpose | Default mapping |
|---|---|---|---|
| `prototype` | `minimal`, `quick` | Harness development, smoke tests, naming/catalog migration, low-risk experiments | quick depth, one wave, low candidate cap, external evidence off, Gemini/second-family passes off, no PR comments, limited repair/fix rounds |
| `standard` | `normal` | Normal issue delivery / PR review | existing adaptive defaults |
| `deep` | — | Important production changes | broader waves/refuters; external evidence for dependency/API/cloud/security surfaces |
| `paranoid` | — | High-risk/security/release gates | maximum depth, wider model diversity, stricter verification/report artifacts |

Saved workflows should accept `profile=` or `intensity=`. Explicit detailed knobs
(`reviewDepth=`, `maxWaves=`, `useGemini=`, etc.) win over profile defaults.

## Canonical workflows

| Canonical | Legacy aliases | Kind | Source | Status | Notes |
|---|---|---|---|---|---|
| `/issue-delivery` | `/fugu` | built-in command | `src/issue-delivery.ts` | active | DAG issue-to-draft-PR workflow. `/fugu` remains a deprecated alias. Supports `--profile prototype|standard|deep|paranoid`. |
| `/closed_loop_issue_delivery` | `/fugu_closed_loop` | saved workflow | `~/.pi/workflows/saved/fugu_closed_loop.json` until migrated | planned | Should pass profile/intensity through to PR review/repair/CI children. |
| `/surgical_pr_repair` | `/fugu_repair` | saved workflow | `~/.pi/workflows/saved/fugu_repair.json` until migrated | planned | Repair loop for existing PR/worktree failures. |
| `/pr_adversarial_review` | — | saved workflow | `~/.pi/workflows/saved/pr_adversarial_review.json` | active | Already exposes `reviewDepth`, `maxWaves`, `maxCandidates`, `externalEvidence`, `useGemini`, `commentPolicy`; add `profile=` wrapper mapping. |
| `/workflow_trace_analyzer` | `/workflow_trace_analyser` | saved workflow | `~/.pi/workflows/saved/workflow_trace_analyser.json` until migrated | planned | Prefer American spelling for new canonical name; keep installed alias. |
| `/evidence_adversarial_review` | — | saved workflow | `~/.pi/workflows/saved/evidence_adversarial_review.json` | active | Source-backed adversarial validation. |
| `/frontend_radix_shadcn_review` | — | saved workflow | `~/.pi/workflows/saved/frontend_radix_shadcn_review.json` | active | Frontend-specific review harness. |

## Migration guardrails

1. Add canonical commands before deleting legacy names.
2. Legacy commands should call canonical implementations and warn when practical.
3. New docs and trace metadata should use canonical names.
4. Keep transient `.fugu/` ignored until old worktrees age out; new built-ins use
   `.issue-delivery/`.
5. Use `profile=prototype` / `--profile prototype` for harness prototyping runs
   so the review system does not spend deep-gate effort on naming/catalog smoke
   tests.
