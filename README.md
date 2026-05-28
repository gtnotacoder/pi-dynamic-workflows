# pi-dynamic-workflows

Claude-Code-style dynamic workflow orchestration for Pi.

This package adds a `workflow` tool that lets the model run deterministic JavaScript workflows with subagents, phases, parallel fan-out, pipelines, structured results, abort handling, and compact progress rendering in Pi.

## Install from disk

```bash
pi install /Users/michael/projects/pi-dynamic-workflows
```

Then reload Pi:

```text
/reload
```

## Pi extension

The package manifest loads:

```json
{
  "pi": {
    "extensions": ["extensions/workflow.ts"]
  }
}
```

The extension registers and activates the `workflow` tool.

## Workflow script shape

A workflow is raw JavaScript. The first statement must export literal metadata:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [{ title: 'Scan' }, { title: 'Analyze' }]
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', { label: 'repo inventory' })

phase('Analyze')
const summary = await agent('Summarize the main modules from this inventory:\n' + inventory, {
  label: 'module summary'
})

return { inventory, summary }
```

Available globals inside the sandbox:

- `agent(prompt, opts)`
- `parallel(thunks)`
- `pipeline(items, ...stages)`
- `phase(title)`
- `log(message)`
- `args`
- `cwd` / `process.cwd()`
- `budget`

The sandbox intentionally does not expose Node APIs like `fs`, `require`, or imports.

## Library modules

- `src/workflow.ts` — parser and sandboxed workflow runtime.
- `src/workflow-tool.ts` — Pi tool wrapper, progress updates, rendering, abort normalization.
- `src/agent.ts` — `WorkflowAgent`, an in-memory Pi subagent runner.
- `src/structured-output.ts` — terminating structured-output tool backed by TypeBox schemas.
- `src/display.ts` — workflow snapshots and compact renderers.
- `extensions/workflow.ts` — production Pi extension entrypoint.

## Development

```bash
npm install
npm test
```
