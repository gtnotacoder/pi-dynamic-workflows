# Codex instructions for pi-dynamic-workflows

You are reviewing or editing `pi-dynamic-workflows`, a TypeScript Pi extension that implements dynamic multi-agent workflows, saved workflow slash commands, model-tier routing, context modes, task-panel/result delivery, Issue Delivery, and conductor finalization.

## Highest-priority review posture

Prioritize concrete correctness and safety issues over style. A useful finding should identify an in-scope defect with exact file/line evidence, explain the failing scenario, and suggest a bounded fix. Avoid speculative architecture commentary unless it blocks the change.

For PR reviews, use this severity bar:

- P0/P1: data loss, command execution/sandbox escape, secrets exposure, broken release/build, or repo-wide unsafe mutation.
- P2: user-visible workflow failure, wrong command/API contract, review/write-protection bypass, incorrect finalization state, resume/journal corruption, or missing tests for changed critical behavior.
- P3: non-blocking maintainability/docs nits; usually do not post unless grouped as a note.

## Repository invariants

- Workflow scripts are trusted JavaScript, but the runtime intentionally restricts nondeterminism and globals. Do not recommend using `setTimeout`, `Date.now`, `Math.random`, `new Date()`, imports, `require`, or filesystem access inside workflow scripts unless the runtime explicitly supports it.
- `agent()` options must be explicit when cost/safety matters. `opts.model` overrides `opts.tier`; global model tiers are machine-local and must not be changed to solve one workflow's cost issue.
- Saved review workflows and code-review/adversarial-review flows must be read-only by tool policy, not by prompt text alone. Repair workflows may use mutating tools only when explicitly launched as repair/mutation.
- Subagents default to focused context mode. Do not assume they inherit main-agent append rules. Use `contextMode: 'legacy'` or `inheritMainRules: true` only when deliberately required.
- Issue Delivery normal path is Scout -> Thinker -> Worker -> LocalChecks -> Verifier -> PR delivery -> finalization. Mechanical checks should run through host `stageCheck()` when available.
- Background workflow results are delivered by task notifications. Avoid duplicate foreground/background result delivery.
- Persisted run state and subagent transcripts are operator-debug artifacts; keep them useful and compact, but do not treat them as product files.

## Naming and compatibility policy

Canonical naming is Issue Delivery vocabulary:

- Canonical built-in command: `/issue-delivery`
- Canonical saved workflows: `/closed_loop_issue_delivery`, `/surgical_pr_repair`, `/pr_adversarial_review`

Legacy Fugu names are compatibility aliases only:

- `/fugu` remains a deprecated alias for `/issue-delivery`.
- `/fugu_closed_loop` and `/fugu_repair` may appear as saved-workflow aliases/replacements.
- `.fugu/` is fully retired — leftover `.fugu/` debris is visible to git and blocks finalization with an actionable path list.
- `src/fugu.ts` can remain as a compatibility export.

Do not introduce new Fugu/Trinity vocabulary in user-facing text, command names, logs, or docs unless the change is explicitly preserving deprecated compatibility. If docs or lockfiles claim a command is shipped, verify there is actual source/registration/saved-workflow support.

## Safety boundaries to review carefully

- Tool policy resolution: `tools`, `disallowedTools`, agentType definitions, and saved-workflow command registration.
- Read-only review boundaries: reviewers must not receive edit/write/bash mutation ability unless repair is explicit.
- Worktree/finalization logic: dirty paths, transient paths, pushed/remote HEAD checks, PR head SHA checks, pending/failed CI states.
- Resume/journal hashing: changed prompts/options/tool policy/context mode should invalidate the right suffix, not replay stale unsafe results.
- Context-window policy: large local-model prompts can become expensive/noisy; preserve caps and compaction semantics.
- Lean-ctx/ctx_* bridge behavior: validate paths before expensive reads, avoid directory reads, avoid noisy package internals unless intentionally enabled, and provide concise fallback hints.
- Slash-command parsing: flags like `--finish`, `--prototype`, `--dry-run=false`, `--mode`, and saved-workflow `key=value` args must parse predictably.
- Workflow catalog/lock contract: docs, lock, aliases, and actual command registration must agree.

## Preferred verification commands

Use the smallest command that proves the touched behavior:

```bash
npm run check
npm run build
npm run test:unit -- <targeted test files>
npm run check:workflow-lock
npm test
```

`npm test` is the full gate (`biome check .`, build, unit tests). Prefer targeted tests during review, but require the full gate for broad runtime changes.

## Common false positives to avoid

- Do not flag `.fugu/` references merely because Fugu is deprecated; transient cleanup compatibility is intentional.
- Do not require deleting `/fugu` alias unless the change explicitly removes deprecated compatibility and updates docs/tests/lock together.
- Do not require GPT/Codex model pins in shipped workflows. Built-ins should generally use tiers for portability; local saved workflows may pin models for one-off operator cost control.
- Do not suggest package installs or dependency lockfile rewrites for pure source/test changes unless the dependency actually changed.

## When suggesting a fix

Keep fixes surgical. Identify exact files to edit and tests to run. If a problem belongs in another repository (for example the Pi SDK or lean-ctx bridge implementation), say so and recommend filing an issue rather than editing across repos in this repo's PR.

## Memory hygiene (hindsight_retain)

Retain only **durable** facts into Hindsight: decisions, preferences, architecture contracts, hard-won lessons. **Never retain ephemeral pipeline state** — CI pass/fail, PR open/draft/merged state, "X is running". Date every retained fact (`as of YYYY-MM-DD`) and supersede explicitly (`supersedes "<prior claim>"`) so contradictory durable claims never co-exist silently. Recall is tuned cheap (`autoRecallBudget` low, `maxRecallTokens` ≈ 1200); reserve `reflect` for deep synthesis, not routine turns. Use the `memory_gardener` saved workflow (report-first, gated `apply=true`, cheap tiers) for Graphiti-style eager staleness resolution (duplicate/supersede/expire) on shared banks. Full policy + examples: [docs/memory-hygiene.md](docs/memory-hygiene.md).
