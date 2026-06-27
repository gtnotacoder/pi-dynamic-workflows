# Workflow Catalog

This catalog is the source of truth for all trusted, production-ready saved workflows in the `pi-dynamic-workflows` ecosystem. These workflows carry specialized model-tier routing, independent verification, and self-compaction logic.

---

## Canonical Saved Workflows

### 1. `closed_loop_issue_delivery`

* **Command:** `/closed_loop_issue_delivery`
* **Aliases:** `/fugu`, `/fugu_closed_loop` (deprecated)
* **Description:** Autonomous end-to-end issue delivery workflow.
* **Topology:**
  * **Thinker (Big Tier):** Analyzes the issue body and generates a Directed Acyclic Graph (DAG) of modification steps.
  * **Worker (Medium Tier):** Implements modifications sequentially or in parallel depending on file dependencies.
  * **LocalChecks (Small Tier):** Runs compile, typecheck, or linter gates on the worktree.
  * **Verifier (Big Tier):** Conducts a strict LLM evaluation of correctness and completeness. If failed, feeds back error logs to the Worker for up to 3 repair attempts.
  * **PR Delivery (Small Tier):** Pushes the branch, commits changes, and opens a draft Pull Request on GitHub.

### 2. `surgical_pr_repair`

* **Command:** `/surgical_pr_repair`
* **Aliases:** `/fugu_repair` (deprecated)
* **Description:** Specialized workflow to repair failing CI checks, compiler errors, or address review feedback within an active worktree. Focuses only on correcting the files causing failures without rewriting unaffected components.

### 3. `pr_adversarial_review`

* **Command:** `/pr_adversarial_review`
* **Description:** Skeptical multi-angle code review of PR changes.
* **Topology:**
  * **Scope:** Summarizes the PR diff, changed files, and applicable project conventions (`CLAUDE.md`, `AGENTS.md`).
  * **Find:** Launches multiple parallel finder agents (line-by-line, removed-behavior, cross-file caller/callee tracer, language-specific pitfalls, conventions checker).
  * **Verify:** Each candidate finding is verified by an independent verifier agent yielding a verdict of `CONFIRMED`, `PLAUSIBLE`, or `REFUTED`.
  * **Sweep:** (At xhigh/max effort) A fresh finder hunts only for gaps and secondary footguns missed in the first pass.
  * **Synthesize:** Merges semantic duplicates, ranks findings (correctness outranks quality/conventions), and outputs a highly polished markdown report.

### 4. `frontend_radix_shadcn_review`

* **Command:** `/frontend_radix_shadcn_review`
* **Description:** FastContext-backed PR adversarial review for React, vendored `shadcn/ui` components, and `@radix-ui` primitive contracts. Focuses heavily on accessibility (a11y), prop contracts, and component behaviors.

### 5. `evidence_adversarial_review`

* **Command:** `/evidence_adversarial_review`
* **Description:** Highly secure, source-backed adversarial review. Combines Web Search (Exa & Brave), Context7 library documentation queries, and GitHub fetch probes with a skeptical review squad to assemble a factual source ledger of evidence for/against findings.

---

## Design Principles

1. **Project-Neutral Naming:** Workflows are named for what they *do* (e.g. `closed_loop_issue_delivery` instead of arbitrary codenames).
2. **No Direct Shell Planning by Models:** To guarantee safety, all git argv, patches, and diff collections are computed by host-side code before being passed to subagents. Subagents operate with read-only tools unless explicitly designed as a Worker within an isolated worktree.
3. **Tiered Routing:** Tasks are dynamically mapped to Small, Medium, or Big model tiers to maximize performance and minimize token cost.
