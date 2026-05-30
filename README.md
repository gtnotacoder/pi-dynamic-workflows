# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

Fork of [Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows), updated for `@earendil-works/*` packages with subagent settings inheritance fix.

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Install

Clone the repo and install from local path:

```bash
git clone git@github.com:QuintinShaw/pi-dynamic-workflows.git
pi install /path/to/pi-dynamic-workflows
```

Then in Pi:

```text
/reload
```

That's it. The extension registers a `workflow` tool and activates it on session start.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Press `Esc` to cancel a running workflow. Active subagents are aborted and surfaced as skipped.

## Features

### Phase 1: Stability & Safety ✅

- **Agent limit**: Maximum 1000 agents per run (configurable via `maxAgents`)
- **Agent timeout**: Default 5 minutes per agent (configurable via `agentTimeoutMs`)
- **Error classification**: Distinguishes recoverable vs non-recoverable errors
- **Log persistence**: Workflow logs saved to `.pi/workflows/runs/`

### Phase 2: Background Execution & Management ✅

- **Background mode**: Set `background: true` to run workflows asynchronously
- **Run persistence**: Run state saved to disk for pause/resume support
- **Run management**: List, pause, resume, stop running workflows

### Phase 3: Workflow Reuse ✅

- **Save workflows**: Save workflow scripts as reusable commands
- **Storage locations**: Project-local (`.pi/workflows/saved/`) or user-wide (`~/.pi/workflows/saved/`)
- **Parameterized workflows**: Support for workflow templates with parameters

### Phase 4: Enhanced Experience ✅

- **Token usage tracking**: Real-time token consumption display
- **Pre-run approval**: (Planned) Show workflow plan before execution
- **Agent detail drill-down**: (Planned) View agent prompts and results

### Phase 5: Advanced Features (Planned)

- **ultracode auto mode**: Automatically decide when to use workflows
- **Per-stage model override**: Different models for different phases
- **Adversarial review**: Agents cross-check each other's findings
- **Deep research**: Built-in `/deep-research` workflow

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text or, with `opts.schema`, a validated object. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

### Agent options

| Option | Type | Description |
| --- | --- | --- |
| `label` | string | Human-readable label for progress display |
| `phase` | string | Override the current phase for this agent |
| `schema` | object | JSON Schema for structured output |
| `model` | string | Request a specific model |
| `timeoutMs` | number | Override the default agent timeout |

### Determinism rules

Workflow scripts are evaluated inside a Node `vm` sandbox. The following are intentionally unavailable:

- `Date.now()`, `new Date()`
- `Math.random()`
- `require`, `import`, `fs`, network APIs
- spreads, computed keys, template interpolation, function calls inside `meta`

This keeps `meta` parseable, runs reproducible, and the surface area small.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under the hood this is a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call without an extra assistant turn.

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses + runs script in a vm sandbox
  → script calls agent(), parallel(), pipeline()
  → each agent() spawns an in-memory Pi subagent session
  → snapshots stream back as compact progress
  → final structured result returned to the parent assistant
```

Subagents run in fresh in-memory Pi sessions with the standard coding tools, so they can read files, run shell commands, and call structured output exactly like a normal Pi turn.

## Library modules

| File | Purpose |
| --- | --- |
| `src/workflow.ts` | AST-validated parser and sandboxed workflow runtime. |
| `src/workflow-tool.ts` | The Pi `workflow` tool, prompt guidelines, rendering, abort handling. |
| `src/agent.ts` | `WorkflowAgent`, an in-memory Pi subagent runner. |
| `src/structured-output.ts` | Terminating structured-output tool backed by TypeBox/JSON Schema. |
| `src/display.ts` | Workflow snapshots and compact text renderers. |
| `src/config.ts` | Configuration constants and limits. |
| `src/errors.ts` | Error types and classification. |
| `src/logger.ts` | Workflow logger with file persistence. |
| `src/run-persistence.ts` | Run state persistence for pause/resume. |
| `src/workflow-manager.ts` | Background execution and run management. |
| `src/workflow-saved.ts` | Save and load reusable workflow commands. |
| `extensions/workflow.ts` | The Pi extension entrypoint. |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run dev
```

Parser unit tests live in `tests/workflow-parser.test.ts` and cover both accepted and rejected script shapes.

## Status

This is an active development project. It implements the core workflow primitive (script, subagents, parallel/pipeline, phases, abort, structured output) plus Phase 1-4 features. Phase 5 features are planned.

## License

MIT
