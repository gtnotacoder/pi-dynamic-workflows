# CONTEXT — pi-dynamic-workflows glossary

> A pure glossary (ubiquitous language) for this project. One term, one crisp
> definition — no implementation details, no file paths, no code. The intent
> is a shared vocabulary so workflow authors, reviewers, and operators mean
> the same thing by the same word.
>
> This glossary practice follows Matt Pocock's domain-modeling skill — see
> [github.com/mattpocock/skills](https://github.com/mattpocock/skills). When a
> term's meaning drifts or a new term enters common use, update it here first;
> the glossary is the source of truth for naming, not the code.

- **harness** — The runtime substrate a workflow executes in (`pi`, `opencode`,
  `hermes`). Only `pi` is wired; the others are placeholders that clean-skip.
- **harness descriptor** — A JSON document declaring how a harness is configured
  (`harness_type`, required/preferred tools, engine floor, worktree policy).
- **harness config** — A named, registered harness descriptor that a workflow
  selects at run level or per agent.
- **herdr** — A terminal workspace manager / TUI that this project uses as a
  status *sink*; workflows are the *source* of the status it renders.
- **conductor** — The orchestration layer that tracks a workflow run's lifecycle
  (engine status plus semantic status) and drives finalization.
- **fugu** — Legacy vocabulary for the issue-delivery workflow. Deprecated
  compatibility alias only; canonical name is `/issue-delivery`.
- **issue delivery** — The built-in issue-to-draft-PR coordinator workflow:
  Scout → Thinker → Worker → LocalChecks → Verifier → PR delivery.
- **closed-loop delivery** — The full plan-driven lane: an issue/plan is
  executed end-to-end with review/repair gates and a finalization check before
  the PR is delivered.
- **hopper** — The issue triage queue: issues are bucketed by readiness (Ready
  for Work / Blocked / Stale) before they enter delivery.
- **clean-skip** — The deliberate, surfaced short-circuit taken when a harness
  descriptor or required tool is unavailable — the run degrades or stops with a
  reason rather than silently falling back.
- **prototype mode** — An ad-hoc lane for harness development and small
  experiments (`--prototype` / `prototype=true`): fewer retries/reviewers, no
  PR comments unless requested. It controls breadth/cost only and must not
  weaken read-only/edit or context-security posture.
- **scout firewall** — The read-only `code-scout` agent run at the very start of
  a pipeline to produce a compact Code Map, so downstream planners receive
  targeted citations instead of large raw files.
- **model tiers** — Portable capability/cost slots (`small` / `medium` / `big`)
  that each map to one concrete model.
- **escalation ladder** — An explicit sequence of stronger tier or model choices
  across attempts; retries alone do not change routes.
- **model pin** — An exact provider/model binding used only when portability is
  intentionally traded for specialization, fallback, or model-family diversity.
- **worktree isolation** — Running a workflow in a throwaway git worktree on its
  own branch so parallel agents can edit without conflicting the main checkout.
- **workflow lock** — The contract (`docs/workflows/workflow-lock.json`) that
  records canonical command names and aliases so docs, tests, and registration
  agree.
- **agent-result channel** — What an `agent()` call returns to the workflow
  script. For verdicts, not payloads: anything over ~10KB goes to a file and the
  ack is `{ok, path, count}`.
- **effort mode** — A standing session toggle (`/effort`, `/maxeffort`) that
  auto-arms a workflow for substantive messages and nudges fan-out breadth plus
  the hard caps the model should set.
- **gardener** — The `memory_gardener` saved workflow: a map-reduce staleness
  auditor over the memory bank (manifest → shards → judge → apply → report).
- **flag_contradiction** — The gardener rule that conflicting current-state
  claims are flagged for human review, never resolved by judges; memories cannot
  establish present ground truth.
- **gated apply** — The gardener's mutation posture: report-only by default; even
  when enabled, capped at a small number of reversible soft-invalidations per run
  and never applied to `flag_contradiction` rows.
- **context mode** — Per-subagent context governance (`focused` default,
  `isolated`, `scoped`, `legacy`) controlling which channels (base, main-rules,
  `AGENTS.md`, skills) a child inherits.
- **agentType** — A reusable, named subagent definition (markdown file) binding
  tools, model, and system prompt — a real binding, not a prose hint.
- **tool policy** — The allow/deny resolution applied to a subagent's tools
  (`tools`, `disallowedTools`, agentType definitions) before execution.
- **local checks** — Host-side mechanical verification (`stageCheck()`: tsc,
  Biome) run with zero LLM tokens before the semantic Verifier.
- **verifier** — The strict semantic LLM review pass that runs only after local
  checks pass, emitting a pass/fail verdict.
- **correction delta** — A bounded, redacted summary of failed checks/verdicts
  fed back to a Worker retry so it sees only the feedback, not raw history.
- **finalization gate** — The deterministic check that a delivered run is clean,
  committed, pushed, and that the PR head SHA / GitHub checks are in a shippable
  state.
- **semantic status** — Conductor-level intent layered on the engine status
  (`spawned`, `workflow-running`, `workflow-complete-pane-open`,
  `needs-finalize`, `finalizing`, `completed`, `failed`, `needs-human`).
- **task panel** — The below-editor live-progress surface for in-flight runs
  (informational; run `/workflows` for the interactive navigator).
- **task notification** — The canonical final-status XML block delivered to
  chat when a background run finishes (`<status>`, `<usage>`, `<recovery>`).
- **saved workflow** — A finished run registered as a reusable `/<name>` slash
  command with `key=value` args, stored as JSON.
- **DAG scheduler** — The deterministic, in-VM scheduler that runs
  dependency-ready workflow steps together with `parallel()` and rejects cyclic
  plans.
- **journal / resume** — The per-`agent()`-call journal that makes a run
  resumable; changed prompts/options/tool policy/context mode invalidate the
  right suffix so stale unsafe results are not replayed.
- **autocompactor** — The user-level extension that performs automatic context
  compaction with pre-compaction accounting and durable-artifact preservation.
- **durable artifact** — Session content (initial prompts, corrections) extracted
  to disk *before* compaction and re-injected verbatim so it survives the
  summarizer.
- **hindsight** — The cross-session memory system (`retain` / `recall` /
  `reflect`) that survives compaction and process restarts.
