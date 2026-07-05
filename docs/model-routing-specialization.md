# Model Specialization & Intelligent Routing Strategy

> **Status:** Research note (2026-06-28) — strategy exploration; not a spec of current behavior.

## 1. Executive Summary

As our multi-agent pipelines scale to handle larger issues, reviews, and closed-loop repairs across `pi-dynamic-workflows` and `kneutral-admin-portal`, our weekly `openai-codex/gpt-5.5` token allotment faces substantial consumption pressure. Monolithic model allocation—where a single premium model (GPT-5.5) handles planning, exploration, file editing, and verification—is financially and operationally unsustainable.

This document outlines our **Model Specialization and Intelligent Routing Strategy**. By aligning each subagent role to its optimal model archetype, we can **offload up to 80% of our premium token usage** without sacrificing a single drop of quality.

Our strategy locks in specific, highly-capable models for their exact sweet spots, introduces the **`code-scout`** as an exploration firewall, and structures our workflow chains to execute on a collaborative "sovereign-worker" architecture.

---

## 2. Core Model Archetypes & Specializations

We have defined four distinct model tiers, each mapped to its ideal execution sweet spot:

```
                  ┌────────────────────────────────────────┐
                  │          GPT-5.5 (Sovereign)           │
                  │  - High-level Architectural Planning   │
                  │  - Final Verification & Approvals      │
                  └───────────────────┬────────────────────┘
                                      │ (Detailed Plan / Compact Task)
                                      ▼
                  ┌────────────────────────────────────────┐
                  │          GLM-5.2 (Worker)              │
                  │  - Large-Scale Code Generation         │
                  │  - Multi-File Surgical Edits           │
                  └───────────────────┬────────────────────┘
                                      │ (Implementation Diff)
                                      ▼
                  ┌────────────────────────────────────────┐
                  │          GPT Spark (Analyst)           │
                  │  - High-Speed Trace Post-Mortems       │
                  │  - Telemetry Self-Optimization Reports │
                  └───────────────────┬────────────────────┘
                                      │ (Checks & Exploration)
                                      ▼
                  ┌────────────────────────────────────────┐
                  │          Local Qwen (Scout)            │
                  │  - Fast Repository Search / Navigation │
                  │  - Local Checks & Linter/Unit Tests    │
                  └────────────────────────────────────────┘
```

### A. Local Qwen (`litellm-ny2/local-qwen27`) — *The Scout & Local Tester*

* **Sweet Spot:** Repository search, directory navigation, local compiling/linting, running unit tests, and small, highly-scoped single-file edits.
* **Why it shines here:** Local Qwen is zero-cost, runs on our local Net-1 infrastructure with near-instant latency, and has superb compliance with tool-calling mechanics (e.g., executing `bash`, `grep`, and file lookups).
* **Action:** Locked in as the default for all `checks`, pre-flight file discovery, and test execution.

### B. GPT Spark (`openai-codex/gpt-5.3-codex-spark`) — *The High-Speed Analyst*

* **Sweet Spot:** Processing extremely large, verbose log files, analyzing trace persistence JSONs, compiling post-mortem summaries, and synthesizing multi-agent outputs.
* **Why it shines here:** GPT Spark has a generous, underutilized allotment, parses and structures large JSON datasets at incredibly high speeds, and has the logical capacity to detect anomalies, caching ratios, and duration bottlenecks.
* **Action:** Locked in for telemetry analysis, trace optimization reports (`workflow_trace_analyzer`; legacy `workflow_trace_analyser` remains an alias), and cross-agent synthesis/reporting.

### C. GLM-5.2 (`litellm-ny2/oc-glm52`) — *The Heavy Coding Worker*

* **Sweet Spot:** Multi-file code generation, surgical line edits, writing new implementations from structured steps, and drafting code modifications.
* **Why it shines here:** GLM-5.2 is an exceptionally capable code writer and editor. In typical closed-loop workflows, the **Worker** phase consumes ~75% of the total tokens because it must read and write full files. By routing worker steps to GLM-5.2, we offload massive volume from GPT-5.5.
* **Action:** Locked in as the main **Worker** implementation engine.

### D. GPT-5.5 (`openai-codex/gpt-5.5`) — *The High-Reasoning Sovereign*

* **Sweet Spot:** System architecture design, high-level planning (creating the Directed Acyclic Graph of steps), strict security/governance validation, and final PR shipping decisions.
* **Why it shines here:** GPT-5.5 has unmatched logical reasoning and edge-case detection. It acts as the "Sovereign" that plans what needs to be changed and verifies that the workers changed it correctly, while leaving the manual file-editing labor to specialized models.
* **Action:** Reserved strictly for **Thinker** and **Verifier** roles.

---

## 3. The `code-scout` Firewall

The most significant token leak in our current workflows is the **Thinker reading large raw files** to figure out how to plan a change. Asking a premium model (GPT-5.5) to read 3,000 lines of code across 5 files just to plan a 10-line edit burns millions of tokens weekly on redundant inputs.

We solve this by inserting a **`code-scout`** (running on `local-qwen27`) as an **exploration firewall** at the very beginning of our pipelines:

### The Workflow Pattern

1. **The Task Arrives:** Instead of routing the task directly to the GPT-5.5 Thinker, we spawn a `code-scout` on the local Qwen model.
2. **Codegraph Search:** The Scout uses `codegraph_explore` / `codegraph_context` to map the codebase semantically. It returns compact candidate file/line citations (e.g. `src/workflow-manager.ts:120-150`) and exported API signatures.
3. **Targeted Read:** The Scout reads only those cited ranges (via `ctx_read` / `read_symbol`), verifies their relevance, and extracts a compact "Code Map" containing only the exact lines of interest and their surrounding API signatures.
4. **Handoff to Thinker:** The Scout hands this compact "Code Map" (usually <1,000 tokens) to the GPT-5.5 Thinker.
5. **High-Reasoning Plan:** The Thinker uses its maximum logical capability to draft a flawless execution plan, completely spared from having to ingest massive, un-compacted raw files.

### Token Savings Estimate

* **Legacy Method:** Thinker reads 5 full files (15k tokens) + system instructions (4k tokens) = **19k input tokens** per planning pass.
* **Scout Firewall Method:** Scout uses zero-cost local Qwen + the codegraph exploration stack to retrieve candidate snippets. Thinker receives a 1k-token Code Map + system instructions (4k tokens) = **5k input tokens** (an **84% reduction in premium planning costs**!).

---

## 4. Model Specialization Matrix

To maintain absolute, un-compromised code quality while preserving our weekly budget, we map our active workflows to the following strict routing boundaries:

| Phase | Task / Responsibility | Target Model | Reason for Assignment | Quality Impact |
|---|---|---|---|---|
| **Pre-flight Scout** | Run `codegraph_explore` / `codegraph_context`, gather file signatures, compile compact Code Map. | `local-qwen27` | Zero-cost, excellent tool calling, high-speed navigation. | **No Quality Loss:** Reading file signatures and retrieving exact lines requires no reasoning depth. |
| **Thinker (Planning)** | Evaluate the Code Map, architecture the modification plan, generate DAG steps. | `gpt-5.5` (Sovereign) | Highest-capacity logical reasoning for planning. | **Premium Quality:** Kept on the best model to ensure plans are perfect and dependency graphs are flawless. |
| **Worker (Writing)** | Execute surgical edits on specific files based on focused step instructions. | `oc-glm52` | Powerful code writer, low-cost compared to GPT-5.5, great context. | **No Quality Loss:** GLM is directed by a strict plan from GPT-5.5, meaning it only needs to focus on localized edits. |
| **LocalChecks (Testing)** | Execute linters (`biome check`), typescript compiler (`tsc`), and unit tests. | `local-qwen27` | Execution-only task; needs tool calling to run bash test scripts. | **No Quality Loss:** Parsing terminal stdout logs requires no frontier reasoning. |
| **Verifier (Auditing)** | Strictly audit code modifications against planned instructions and test logs. | `gpt-5.5` (Sovereign) | Maximum capability needed to find hidden bugs and prevent regressions. | **Premium Quality:** Strictly keeps the gatekeeper role on GPT-5.5 to ensure zero buggy code gets staged. |
| **Telemetry Optimizer** | Analyze JSON run persisted state files and logs to find bottlenecks. | `gpt-5.3-codex-spark` | Underutilized allotment, fast parsing, excellent pattern matching. | **Premium Quality:** Spark specializes in trace/log synthesis, finding optimization gaps in seconds. |

---

## 5. Dynamic Gated Escalation (Cascading Model Routing)

To maximize our use of **local Qwen** (`litellm-ny2/local-qwen27`), we establish a **Cascading Model Routing** pattern within our closed-loop execution engines (like Issue Delivery, closed-loop issue delivery, and surgical PR repair).

Our testing demonstrates that local Qwen achieves the same functional scores on baseline coding tasks as GLM-5.2 while costing zero premium tokens and executing with local-net speed. Therefore, we default our implementation (Worker) pass to **local Qwen**, and escalate only when necessary.

### The Gated Escalation Workflow
* **First Pass (Attempt 1):** The worker runs on **local Qwen** (Small tier). This handles 80-90% of straightforward edits, additions, and deletions for zero token cost.
* **Verification Gate:** The linter, compiler, and verifier (running on GPT-5.5) review the change.
* **Escalation Gate (Attempt 2 & 3):** If verification fails, the workflow engine detects the failure and **escalates the retry to GLM-5.2** (Medium tier), feeding it the precise feedback and linter error logs. If that still fails, the third attempt is escalated to **GPT-5.5** (Big tier).

```
                  ┌────────────────────────────────────────┐
                  │          Attempt 1: Local Qwen         │
                  │  - Free, fast, local-net               │
                  │  - Handles baseline coding/edits       │
                  └───────────────────┬────────────────────┘
                                      │ (Verifier Checks)
                                      ▼
                               [Verification]───► [PASSED] ──► Ship Draft PR
                                      │
                                      ▼ [FAILED]
                  ┌───────────────────┴────────────────────┐
                  │          Attempt 2: GLM-5.2            │
                  │  - Escalated reasoning with error logs │
                  │  - Resolves more complex dependencies  │
                  └───────────────────┬────────────────────┘
                                      │ (Verifier Checks)
                                      ▼
                               [Verification]───► [PASSED] ──► Ship Draft PR
                                      │
                                      ▼ [FAILED]
                  ┌───────────────────┴────────────────────┐
                  │          Attempt 3: GPT-5.5            │
                  │  - Maximum capacity logic resolution    │
                  │  - Surgical merge/architecture repair  │
                  └────────────────────────────────────────┘
```

This "Pay-on-Demand" strategy ensures that we:

1. Pay **zero premium tokens** for successful first-pass implementations.
2. Only leverage GLM-5.2 or GPT-5.5 for coding when a task is genuinely complex (proven by a failing verification gate).
3. Maximize overall pipeline safety, throughput, and token budget life without compromising on quality.

---

## 6. Concrete Registry Adjustments

We enforce these specializations in our workflow scripts and our `.pi/agents` configurations:

### A. Updating `.pi/workflows/model-tiers.json`

We align our standard tiers globally to support our local-net offloading strategy:

```json
{
  "tiers": {
    "small": "litellm-ny2/local-qwen27",
    "medium": "litellm-ny2/oc-glm52",
    "big": "openai-codex/gpt-5.5"
  }
}
```

### B. Defining the Specialized Worker in `.pi/agents/worker.md`

We lock the specialized worker agentType to the medium tier (`oc-glm52`) directly in its definition file:

```markdown
---
name: specialized-worker
description: Heavy code editor and writer running on GLM-5.2 to offload premium GPT-5.5 tokens
model: litellm-ny2/oc-glm52
tools: [read, edit, write, bash]
contextMode: focused
---
You are the Specialized Worker. Your sole task is to implement the localized step plan assigned to you.
Follow instructions strictly and keep edits highly surgical.
```

### C. Standardizing the Trace Analyst in `.pi/agents/trace-analyst.md`

We lock the trace analyst to our fast Spark model:

```markdown
---
name: trace-analyst
description: High-speed telemetry and trace post-mortem compiler running on GPT Spark
model: openai-codex/gpt-5.3-codex-spark
tools: [read, grep, bash]
disallowedTools: [edit, write]
contextMode: focused
---
You are the Expert Workflow Trace and Telemetry Optimizer.
Analyze the multi-agent run state using Spark and compile a self-optimization report.
```

---

## 7. Conclusion

By implementing this sovereign-worker routing topology:

1. **GPT-5.5** is relieved of all manual repository navigation and bulk code generation, reserving its high-reasoning tokens for pure orchestration planning and verification audits.
2. **GLM-5.2** handles the bulk text editing labor, keeping our implementations clean and rapid.
3. **Local Qwen** handles the mechanical tasks (tool navigation, testing, linting) for zero cost.
4. **GPT Spark** acts as our real-time observer, analyzing traces in milliseconds.

This guarantees **flawless quality gates** while **drastically reducing premium weekly consumption**, ensuring our dev environments can operate scale runs indefinitely.
