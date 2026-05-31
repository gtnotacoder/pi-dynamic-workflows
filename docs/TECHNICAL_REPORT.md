# pi-dynamic-workflows — Technical Reference

> **Version:** `@quintinshaw/pi-dynamic-workflows`  
> **Runtime:** [Pi](https://github.com/earendil-works/pi) coding agent  
> **License:** MIT  
> **Status:** 59 tests passing across 11 test files

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [API Reference Summary](#2-api-reference-summary)
3. [Key Implementation Patterns](#3-key-implementation-patterns)
4. [Integration Checklist](#4-integration-checklist)
5. [Testing Strategy](#5-testing-strategy)
6. [Known Limitations & Tradeoffs](#6-known-limitations--tradeoffs)

---

## 1. Architecture Overview

### System Context

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Pi Host Process                            │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────────────────────────────┐   │
│  │   User CLI   │───▶│  /workflows  /deep-research  /adv-review │   │
│  │   + TUI      │    │         (registered commands)            │   │
│  └──────────────┘    └────────────────────┬─────────────────────┘   │
│                                           │                         │
│                                           ▼                         │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    WorkflowManager                             │ │
│  │  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐    │ │
│  │  │  Scheduler   │ │  Persistence │ │  Event Bus (EE)      │    │ │
│  │  │  (run/pause/ │ │  (.workflow- │ │  (progress/status)   │    │ │
│  │  │   stop)      │ │   runs/*.json)│ │                      │    │ │
│  │  └──────┬──────┘ └──────────────┘ └──────────┬───────────┘    │ │
│  └─────────┼─────────────────────────────────────┼────────────────┘ │
│            │                                     │                   │
│            ▼                                     ▼                   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   WorkflowEngine (workflow.ts)                │   │
│  │                                                              │   │
│  │  ┌────────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐  │   │
│  │  │   Parser    │  │   VM     │  │  Budget   │  │  Model   │  │   │
│  │  │ (static    │  │ (sandbox │  │  Tracker  │  │  Router  │  │   │
│  │  │  analysis) │  │  exec)   │  │           │  │          │  │   │
│  │  └────────────┘  └─────┬────┘  └───────────┘  └──────────┘  │   │
│  │                        │                                     │   │
│  │              ┌─────────┼──────────┐                          │   │
│  │              ▼         ▼          ▼                          │   │
│  │         ┌────────┐ ┌────────┐ ┌────────┐                    │   │
│  │         │ agent()│ │parallel│ │pipeline│  ← Script Globals  │   │
│  │         └───┬────┘ └───┬────┘ └───┬────┘                    │   │
│  │             │          │          │                          │   │
│  └─────────────┼──────────┼──────────┼──────────────────────────┘   │
│                ▼          ▼          ▼                               │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Pi Subagent Runtime (pi SDK)                     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │   │
│  │  │ Subagent │  │ Subagent │  │ Subagent │  │ Subagent │     │   │
│  │  │  (model  │  │  (model  │  │  (model  │  │  (model  │     │   │
│  │  │  routed) │  │  routed) │  │  routed) │  │  routed) │     │   │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │   │
│  │       │             │             │             │             │   │
│  │       ▼             ▼             ▼             ▼             │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │   │
│  │  │  Tools:  │  │  Tools:  │  │  Tools:  │  │  Tools:  │     │   │
│  │  │ web_search│  │ web_search│  │ bash     │  │ read     │     │   │
│  │  │ web_fetch │  │ web_fetch │  │ edit     │  │ write    │     │   │
│  │  │ structured│  │ structured│  │ ...      │  │ ...      │     │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   Display Layer                               │   │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐    │   │
│  │  │  Snapshot   │  │  TUI Nav   │  │  Task Panel          │    │   │
│  │  │  Renderer   │  │  (drill-   │  │  (background status) │    │   │
│  │  │             │  │   down)    │  │                      │    │   │
│  │  └────────────┘  └────────────┘  └──────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   Worktree Isolation                          │   │
│  │  createWorktree() ←── parallel agents ──▶ removeWorktree()   │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow: Script → Execution → Result

```
 User types script
        │
        ▼
┌─────────────────┐     ┌──────────────────┐
│ parseWorkflow-  │────▶│  Validated AST   │
│ Script()        │     │  (meta extracted) │
└─────────────────┘     └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  runWorkflow()   │
                        │                  │
                        │  1. Resolve model│
                        │     routing      │
                        │  2. Check budget │
                        │  3. Execute in   │
                        │     VM sandbox   │
                        └────────┬─────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
        ┌──────────┐      ┌──────────┐       ┌──────────┐
        │ agent()  │      │parallel()│       │pipeline()│
        │ spawn    │      │ fan-out  │       │ stages   │
        └────┬─────┘      └────┬─────┘       └────┬─────┘
             │                 │                   │
             ▼                 ▼                   ▼
        ┌──────────────────────────────────────────────┐
        │         Pi Subagent Session                   │
        │   (model resolved, tools injected,            │
        │    budget checked, timeout armed)              │
        └──────────────────┬───────────────────────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │  Persist state   │
                  │  (journal entry) │
                  └────────┬─────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │  Return result   │
                  │  to workflow     │
                  │  script scope    │
                  └────────┬─────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │  Final return    │
                  │  → delivered to  │
                  │    user / stored │
                  └──────────────────┘
```

### Module Dependency Graph

```
index.ts (barrel)
  ├── workflow.ts          ← Core engine (parser + runtime)
  │     ├── config.ts      ← Constants (caps, timeouts, paths)
  │     ├── errors.ts      ← WorkflowError, error codes
  │     ├── model-routing.ts ← resolveModelForPhase()
  │     └── logger.ts      ← Structured logging
  │
  ├── workflow-manager.ts  ← Lifecycle management (run/pause/stop/resume)
  │     ├── run-persistence.ts ← JSON file persistence (.workflow-runs/)
  │     └── workflow.ts
  │
  ├── agent.ts             ← WorkflowAgent abstraction
  ├── display.ts           ← Snapshot/rendering utilities
  ├── workflow-ui.ts       ← TUI Navigator (drill-down)
  ├── workflow-editor.ts   ← Input box "workflows" trigger
  ├── task-panel.ts        ← Background run status widget
  ├── workflow-tool.ts     ← Expose workflow as a callable tool
  ├── workflow-commands.ts ← /workflows slash command
  ├── saved-commands.ts    ← /<name> saved workflow commands
  ├── workflow-saved.ts    ← Storage for saved workflows
  │
  ├── auto-workflow.ts     ← AI-assisted workflow suggestion
  ├── deep-research.ts     ← /deep-research generator
  ├── adversarial-review.ts← /adversarial-review generator
  ├── web-tools.ts         ← web_search + web_fetch tools
  ├── structured-output.ts ← JSON Schema validated output
  └── worktree.ts          ← Git worktree isolation
```

---

## 2. API Reference Summary

### Core Workflow Execution

| Export | Type | Signature | Description |
|---|---|---|---|
| `runWorkflow` | fn | `(script: string, options: WorkflowRunOptions) → Promise<WorkflowRunResult>` | Main entry point. Parses, validates, and executes a workflow script. |
| `parseWorkflowScript` | fn | `(script: string) → { meta, body }` | Static parser — extracts `meta` and validates no dynamic APIs. |
| `WorkflowManager` | class | `new WorkflowManager(opts)` | Manages lifecycle of multiple concurrent runs. Methods: `run()`, `runSync()`, `pause()`, `resume()`, `stop()`, `listRuns()`, `deleteRun()`. |
| `WorkflowAgent` | class | `new WorkflowAgent(opts)` | The agent abstraction used inside workflows. Wraps pi's subagent API with budget/model/timeout integration. |

### Workflow Configuration & Meta

| Export | Type | Description |
|---|---|---|
| `WorkflowMeta` | type | `{ name, description, phases: WorkflowMetaPhase[] }` |
| `WorkflowMetaPhase` | type | `{ title: string, model?: string }` |
| `WorkflowRunOptions` | type | Options passed to `runWorkflow()` — `tokenBudget`, `defaultModel`, `onTokenUsage`, `cwd`, etc. |
| `WorkflowRunResult` | type | Return value — `{ result, tokenUsage, durationMs, agents[] }` |
| `AgentOptions` | type | Per-agent options — `label`, `model`, `schema`, `isolation`, `timeoutMs` |
| `JournalEntry` | type | `{ index, hash, result }` — resume cache entry |
| `SharedRuntime` | type | Shared state across nested calls — `spent`, `tokenUsage`, `agentCount`, `limiter`, `depth` |

### Configuration Constants (`config.ts`)

| Constant | Value | Purpose |
|---|---|---|
| `MAX_AGENTS_PER_RUN` | `1000` | Hard cap on agents per workflow run |
| `DEFAULT_AGENT_TIMEOUT_MS` | `300000` (5 min) | Default per-agent timeout |
| `MAX_CONCURRENCY` | `16` | Max parallel agents (matches pi's limit) |
| `DEFAULT_TOKEN_BUDGET` | `null` | Disabled by default (unlimited) |
| `WORKFLOW_RUNS_DIR` | `.pi/workflows/runs` | Persistence directory |
| `WORKFLOW_SAVED_DIR` | `.pi/workflows/saved` | Project-level saved workflows |
| `USER_WORKFLOW_SAVED_DIR` | `~/.pi/workflows/saved` | User-level saved workflows |

### Display & UI

| Export | Type | Description |
|---|---|---|
| `createWorkflowSnapshot` | fn | Snapshot current workflow state for display |
| `recomputeWorkflowSnapshot` | fn | Recalculate snapshot after state change |
| `renderWorkflowText` / `renderWorkflowLines` | fn | Render workflow as text/lines for TUI |
| `preview` | fn | Preview workflow output |
| `createToolUpdateWorkflowDisplay` | fn | Display updater for tool-based updates |
| `createWidgetWorkflowDisplay` | fn | Widget-based display adapter |
| `WorkflowEditor` | class | Interactive workflow script editor |
| `installWorkflowEditor` | fn | Install the editor into the pi runtime |
| `openWorkflowNavigator` | fn | Open TUI navigator for workflow selection |
| `NavigatorModel` / `NavigatorState` | class | TUI navigator state machine |

### Model Routing

| Export | Type | Description |
|---|---|---|
| `resolveModelForPhase` | fn | `(phase: string, config: ModelRoutingConfig) → string \| undefined` |
| `parseModelRoutingFromMeta` | fn | `(phases: WorkflowMetaPhase[]) → ModelRoutingConfig` |
| `buildModelRoutingInstructions` | fn | `(phase: string, config: ModelRoutingConfig) → string` |

**Resolution precedence:** matched route → `config.defaultModel` → `undefined` (agent decides)

### Persistence & Resume

| Export | Type | Description |
|---|---|---|
| `createRunPersistence` | fn | Creates CRUD layer for run state files |
| `generateRunId` | fn | Generates `timestamp36-random36` IDs |
| `createWorkflowStorage` | fn | Storage for saved workflow definitions |
| `PersistedRunState` | type | Full lifecycle snapshot — status, phases, agents, logs, timestamps, token usage |
| `RunPersistence` | type | `{ save, load, list, delete }` interface |

**Resume mechanism:** Journal entries (`{ index, hash, result }`) enable deterministic replay — hash mismatch after script edits forces re-execution from that point.

### Built-in Tools

| Export | Type | Description |
|---|---|---|
| `createWebTools` | fn | Returns `[web_search, web_fetch]` as `ToolDefinition[]` |
| `createWebFetchTool` | fn | Single URL fetch tool — strips HTML, returns plaintext |
| `createWebSearchTool` | fn | Bing search scraper — returns `{url, title}[]` |
| `createStructuredOutputTool` | fn | JSON Schema-validated agent output capture |
| `createWorkflowTool` | fn | Expose a workflow as a callable tool |

### Error Handling

| Export | Type | Description |
|---|---|---|
| `WorkflowError` | class | Typed error with `code` and `recoverable` flag |
| `WorkflowErrorCode` | enum | `TOKEN_BUDGET_EXHAUSTED`, `TIMEOUT`, `ABORTED`, etc. |
| `isAbortError` / `isTimeoutError` / `isWorkflowError` | fn | Error classification helpers |
| `wrapError` | fn | Wrap unknown errors into `WorkflowError` |

### Total Export Surface

**~80+ exports** across 18 modules covering execution, configuration, display, editor, commands, persistence, routing, tools, worktrees, and errors.

---

## 3. Key Implementation Patterns

### 3.1 Script Sandboxing

Workflow scripts execute inside a **restricted VM context** with only the allowed globals exposed:

```
Allowed:        agent, parallel, pipeline, phase, workflow, log, args, budget, cwd
Forbidden:      Date.now, Math.random, new Date, require, import, fs, process
```

The parser enforces this statically **before execution** — any nondeterministic API or dangerous construct (spread operators, computed keys, `__proto__`, accessors in meta) throws a clear error. This guarantees **deterministic replay** for resume.

### 3.2 Concurrency Model

```
MAX_CONCURRENCY = 16  (semaphore-based limiter)
MAX_AGENTS_PER_RUN = 1000  (counter check)

parallel([a, b, c, d])  →  up to 16 run at once
                               remaining queue and wait
```

The `SharedRuntime.limiter` is a concurrency semaphore. Nested `workflow()` calls share the same limiter and counters — the 16-concurrency / 1000-agent caps hold across one level of nesting.

### 3.3 Budget Tracking

```
budget = {
  total:     options.tokenBudget ?? null,   // null = unlimited
  spent:     () => shared.spent,            // accumulated after each agent
  remaining: () => total == null ? Infinity : Math.max(0, total - spent)
}

// Pre-flight check before each agent:
if (budget.total !== null && budget.remaining() <= 0) {
  throw new WorkflowError("budget exhausted", TOKEN_BUDGET_EXHAUSTED, { recoverable: false })
}

// Post-flight accumulation:
shared.spent += actualTokens
shared.tokenUsage.input  += usage.input
shared.tokenUsage.output += usage.output
```

Key points:
- **Real accounting** — reads actual token counts from subagent sessions, not estimates
- **Non-recoverable** — `TOKEN_BUDGET_EXHAUSTED` has `recoverable: false`
- **Exposed to scripts** — `budget.total`, `budget.spent()`, `budget.remaining()` are available in the VM

### 3.4 Model Routing (First-Match-Wins)

```typescript
function resolveModelForPhase(phase: string, config: ModelRoutingConfig): string | undefined {
  // 1. Early exit
  if (!phase || !config.routes?.length) return config.defaultModel

  // 2. Route iteration (array order)
  for (const route of config.routes) {
    const matched = route.useRegex
      ? new RegExp(route.phasePattern, 'i').test(phase)
      : phase.toLowerCase().includes(route.phasePattern.toLowerCase())
    if (matched) return route.model
  }

  // 3. Fallback
  return config.defaultModel
}
```

Two entry points:
- `parseModelRoutingFromMeta(phases)` — extracts routes from phase `model` fields
- `buildModelRoutingInstructions(phase, config)` — returns `"Use model: xyz"` for agent prompts

### 3.5 Journal-Based Resume

```
Execution order:  agent₀  agent₁  agent₂  agent₃  agent₄
                       ↓       ↓       ↓       ↓       ↓
Journal:          [ {0,h₀,r₀}, {1,h₁,r₁}, {2,h₂,r₂} ]
                                                  ↑
                                          run interrupted here

Resume:
  1. load(runId) → status: "paused"
  2. For each journal entry:
     if hash(current_call) === journal.hash → replay result (no token cost)
     else → re-execute
  3. Continue from first un-cached index
```

The **deterministic `callSeq` counter** ensures consistent indexing across runs, even under `parallel()` (which resolves in completion order, not submission order).

### 3.6 Worktree Isolation

```
Base repo: /project (main branch)
    │
    ├── Worktree A: /project/.worktrees/agent-auth  (branch: wf/agent-auth)
    │     └── agent edits auth.ts freely
    │
    └── Worktree B: /project/.worktrees/agent-routes (branch: wf/agent-routes)
          └── agent edits routes.ts freely

After completion:
  → merge branches back to main
  → removeWorktree() cleans up directories and branches
```

### 3.7 Web Tool Pipeline

```
Agent needs research
        │
        ▼
   web_search(query, count)
        │
        ▼
   Returns: [{url, title}, ...]  (Bing HTML scrape)
        │
        ▼
   web_fetch(url)
        │
        ▼
   Returns: HTTP status + cleaned plaintext (max 6000 chars)
        │
        ▼
   Agent synthesizes from real sources
```

Both tools execute in the **extension host process** (not sandboxed), with real network access and Chrome-like User-Agent headers.

### 3.8 Command Registration Pattern

```typescript
function registerWorkflowCommands(pi, opts) {
  // Idempotent — check if already registered
  if (pi.getCommands().some(c => c.name === 'workflows')) return

  pi.registerCommand('workflows', {
    description: 'Manage workflow runs',
    handler: async (args, ctx) => {
      const subcommand = args[0] || 'list'
      switch (subcommand) {
        case 'list':   ...
        case 'status': ...
        case 'stop':   ...
        case 'pause':  ...
        case 'resume': ...
        case 'save':   ...
      }
    }
  })
}
```

Saved workflows register as separate commands via `registerSavedWorkflow()`, enabling a `/<name>` invocation pattern.

---

## 4. Integration Checklist

### 4.1 Installation

```bash
# Install the extension
pi install @quintinshaw/pi-dynamic-workflows

# Reload to register commands
/reload
```

Verify: `/workflows` should list available runs (empty on first use).

### 4.2 Writing a Production Workflow

```
✅  Checklist for a well-structured workflow:

□  meta is the FIRST statement
□  name is snake_case (becomes the command name)
□  description is non-empty (shown in /workflows list)
□  phases[] defined if multi-phase (shown in TUI)
□  No Date.now(), Math.random(), require(), import, fs
□  agent() calls have descriptive labels
□  Return a plain JSON-serializable object
□  Use phase() to mark progress boundaries
```

### 4.3 Model Routing Setup

```javascript
// In meta — per-phase routing
export const meta = {
  name: 'my_audit',
  description: 'Cost-optimized codebase audit',
  phases: [
    { title: 'Inventory', model: 'anthropic/claude-3-haiku' },   // cheap
    { title: 'Analysis',  model: 'anthropic/claude-3-sonnet' },  // mid-tier
    { title: 'Report' },                                          // default
  ],
}
```

Or per-agent:
```javascript
const data = await agent('List all modules', {
  label: 'inventory',
  model: 'anthropic/claude-3-haiku'
})
```

### 4.4 Budget Configuration

```javascript
// Via the workflow tool options
{
  "script": "...",
  "budget": 200000
}

// Or check inside the script
if (budget.remaining() < 5000) {
  return { partial: true, data: accumulatedSoFar }
}
```

### 4.5 Enabling Worktree Isolation

```javascript
// For agents that edit files
const result = await agent('Refactor auth module', {
  label: 'auth refactor',
  isolation: 'worktree'  // creates own git branch
})
```

**Prerequisite:** Must be inside a git repository. Non-git directories silently fall back to no isolation.

### 4.6 Structured Output

```javascript
const analysis = await agent('Analyze security risks', {
  label: 'security',
  schema: {
    type: 'object',
    properties: {
      risks: { type: 'array', items: { type: 'string' } },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    },
    required: ['risks', 'severity'],
  },
})
// analysis is a validated JS object, not prose
```

### 4.7 Saving & Reusing

```bash
# Save a run as a reusable command
/workflows save my_audit

# Invoke anytime
/my_audit

# Or from inside another workflow
const result = await workflow('my_audit', { scope: 'src/' })
```

### 4.8 Background Execution & Monitoring

```bash
# Workflows run in background by default
# Check status:
/workflows status <run-id>

# Watch live:
/workflows watch <run-id>

# Pause/stop:
/workflows pause <run-id>
/workflows stop <run-id>

# Resume:
/workflows resume <run-id>
```

The task panel shows running workflows beneath the input bar. Results auto-deliver when complete.

---

## 5. Testing Strategy

### Current Coverage

| Test File | Tests | Module(s) Covered |
|---|---|---|
| `workflow-parser.test.ts` | 9 | `workflow.ts` (parser) |
| `workflow-runtime.test.ts` | 8 | `workflow.ts` (runtime) |
| `workflow-editor.test.ts` | 11 | `workflow-editor.ts` |
| `workflow-commands.test.ts` | 7 | `workflow-commands.ts` |
| `workflow-ui.test.ts` | 5 | `workflow-ui.ts` |
| `task-panel.test.ts` | 5 | `task-panel.ts` |
| `saved-commands.test.ts` | 4 | `saved-commands.ts`, `workflow-commands.ts` |
| `workflow-manager.test.ts` | 3 | `workflow-manager.ts` |
| `builtin-workflows.test.ts` | 3 | `deep-research.ts`, `adversarial-review.ts`, `web-tools.ts` |
| `worktree.test.ts` | 2 | `worktree.ts` |
| `workflow-tool.test.ts` | 1 | `workflow-tool.ts` |
| **Total** | **59** | **11 of 24 source modules** |

### Test Patterns Used

| Pattern | Example | Used In |
|---|---|---|
| **Pure validation** | `assert.throws(() => parseWorkflowScript(bad), /error msg/)` | Parser tests |
| **Fake pi harness** | Captured `registerCommand`, `sendMessage` calls | Command tests |
| **Counting agent** | Tracks `invokeCount` to verify parallel ordering | Runtime tests |
| **EventEmitter mock** | Simulates `manager.on/off` for live-watching | Command tests |
| **Temp directory** | `withTempCwd()` for file-system isolation | Manager, worktree tests |
| **Journal replay** | Pre-populated journal entries, verify no re-execution | Resume tests |

### Well-Tested Areas ✅

- **Script parser** — all error paths, security hazards (proto pollution, spreads, nondeterminism)
- **Workflow runtime** — execution, model routing, resume/journal, parallel ordering, budget gating, nesting limits
- **Command layer** — `/workflows` subcommands, idempotent registration, live watching
- **Editor** — trigger detection, ANSI handling, slash-command exclusion, state machine
- **UI/Navigator** — drill-down navigation, key mappings, rendering
- **Task panel** — result delivery, idempotent install, error reporting
- **Worktree** — git and non-git paths, cleanup verification

### Coverage Gaps ⚠️

| Module | Gap |
|---|---|
| `agent.ts` | No dedicated tests — only exercised indirectly |
| `auto-workflow.ts` | Zero tests — AI-assisted workflow suggestion |
| `config.ts` | No tests for constant values |
| `display.ts` | No tests for snapshot/rendering utilities |
| `errors.ts` | No tests for custom error classes |
| `logger.ts` | No tests for logging infrastructure |
| `model-routing.ts` | Only indirect coverage via runtime tests |
| `run-persistence.ts` | No direct tests for format, corruption, or migration |
| `structured-output.ts` | No tests for JSON Schema validation |
| `workflow-saved.ts` | No direct tests |
| `deep-research.ts` / `adversarial-review.ts` | Only parseability tested, not execution |
| `workflow-tool.ts` | Only 1 test for text output |

---

## 6. Known Limitations & Tradeoffs

### 6.1 Nesting Depth

**Limit:** One level of nesting only. A workflow can call `workflow('child', args)`, but a child cannot call `workflow('grandchild')`.

**Why:** Prevents runaway resource consumption and simplifies the shared runtime model (budget, concurrency, agent count all share across exactly one level).

**Workaround:** Use `parallel()` within a single workflow to achieve multi-level fan-out.

### 6.2 Concurrency Cap

**Limit:** `MAX_CONCURRENCY = 16` concurrent subagents. Hard-coded to match pi's underlying limit.

**Impact:** Large fan-outs (>16 items) queue and execute in batches. No priority ordering — first-come-first-served within the semaphore.

### 6.3 Budget Granularity

**Limit:** Budget checks happen **before** agent execution, not during. An agent that consumes more tokens than `remaining()` will complete before the next check catches the overrun.

**Impact:** Actual spend may exceed `budget.total` by up to one agent's worth of tokens.

### 6.4 Resume Hash Sensitivity

**Limit:** The journal hash includes the full prompt and options. Any change to a prompt — even whitespace — invalidates the hash and forces re-execution.

**Impact:** Minor prompt tweaks cause full re-runs of that agent and all downstream agents. This is by design (correctness) but can surprise users editing prompts mid-resume.

### 6.5 Web Tools Limitations

**Limitation** | **Detail**
---|---
`web_search` scrapes Bing HTML | Fragile to Bing layout changes; limited to ~10 results
`web_fetch` strips all HTML | Loses images, tables, code blocks; 6000 char default truncation
No JavaScript rendering | Single-page apps and JS-heavy sites return empty/broken content
No authentication | Cannot access pages behind logins or paywalls

**Mitigation:** For complex research, the built-in `/deep-research` workflow uses multiple search angles and cross-checks claims across sources.

### 6.6 Script Restrictions

**Forbidden APIs** (enforced by parser):
- `Date.now()`, `new Date()`, `Math.random()` — nondeterministic
- `require()`, `import` — no module loading
- `fs`, `process` — no filesystem/process access
- Computed keys, spread operators, `__proto__`, accessors in `meta` — security hazards

**Impact:** Scripts cannot do their own I/O, time-based logic, or module imports. All side effects go through `agent()` and `workflow()`.

### 6.7 Display Rendering

**Limit:** ANSI-based rendering only. No true graphical UI — the TUI navigator is terminal-based with keyboard navigation.

**Impact:** Complex nested state (deep agent hierarchies) may not render cleanly in narrow terminals.

### 6.8 Persistence Format

**Limit:** Runs are stored as individual JSON files in `.pi/workflows/runs/`. No database, no indexing beyond filesystem sort.

**Impact:** `list()` reads and parses all `.json` files on every call. Performance degrades with hundreds of persisted runs. No automatic cleanup — stale runs accumulate.

### 6.9 Auto-Workflow Heuristics

**Limit:** `shouldUseWorkflow()` and `suggestWorkflowScript()` are AI-assisted heuristics with no test coverage.

**Impact:** May suggest unnecessary workflows for simple tasks or miss complex tasks that would benefit from orchestration.

### 6.10 Worktree Isolation

**Limit:** Requires being inside a git repository. Non-git directories silently fall back to no isolation (no error).

**Impact:** Users may not realize their parallel agents are clobbering each other's files if they forgot to `git init`.

---

## Appendix: File Inventory

```
src/                          24 TypeScript source files
├── index.ts                  Barrel exports (~80+ exports)
├── workflow.ts               Core engine (parser + runtime)
├── workflow-manager.ts       Lifecycle management
├── workflow-commands.ts      /workflows slash command
├── workflow-editor.ts        Input trigger editor
├── workflow-ui.ts            TUI Navigator
├── workflow-tool.ts          Workflow-as-tool wrapper
├── workflow-saved.ts         Saved workflow storage
├── saved-commands.ts         /<name> command registration
├── task-panel.ts             Background status widget
├── agent.ts                  WorkflowAgent abstraction
├── auto-workflow.ts          AI-assisted generation
├── config.ts                 Constants and paths
├── display.ts                Snapshot/rendering
├── errors.ts                 Error types and codes
├── logger.ts                 Structured logging
├── model-routing.ts          Phase→model resolution
├── run-persistence.ts        JSON file persistence
├── structured-output.ts      JSON Schema output
├── web-tools.ts              web_search + web_fetch
├── worktree.ts               Git worktree isolation
├── deep-research.ts          /deep-research generator
├── adversarial-review.ts     /adversarial-review generator
└── builtin-commands.ts       Built-in workflow commands

tests/                        11 test files, 59 tests
├── builtin-workflows.test.ts (3)
├── saved-commands.test.ts    (4)
├── task-panel.test.ts        (5)
├── workflow-commands.test.ts (7)
├── workflow-editor.test.ts   (11)
├── workflow-manager.test.ts  (3)
├── workflow-parser.test.ts   (9)
├── workflow-runtime.test.ts  (8)
├── workflow-tool.test.ts     (1)
├── workflow-ui.test.ts       (5)
└── worktree.test.ts          (2)
```

---

*Generated from source analysis of `@quintinshaw/pi-dynamic-workflows`. All code references are to the TypeScript source in `src/`.*
