# Deterministic Gated Authority Research

> **Status:** Design rationale (2026-06, issue #12) — the StageCheck/LocalChecks gate described here is implemented; details may lag the code.

## Goal

Issue Delivery routes mechanical verification through the `LocalChecks` phase. Earlier Fugu/Trinity prototypes used a lightweight check agent; the current design moves that hard gate into the Node orchestration boundary. A deterministic `StageCheck` layer runs known project checks directly, returns structured JSON, and lets the Verifier LLM reason over facts rather than raw terminal output.

## Proposed StageCheck boundary

> Types updated to match shipped v0.2.0 (`src/stage-check.ts`).

The shipped `StageCheck` boundary executes selected checks before LLM verification:

```ts
// Per-command result (shipped)
interface StageCheckCommandResult {
  name: string;
  command: string;
  args: string[];
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  summary: string;
}

// Top-level result (shipped)
interface StageCheckResult {
  ok: boolean;
  targetFile?: string;
  checks: StageCheckCommandResult[];
  summary: string;
}
```

The workflow engine provides `StageCheckResult` directly to the Verifier prompt/schema instead of asking an intermediate check agent to run and summarize commands.

## TypeScript and Biome checks

For this repository, the deterministic gate can start with two native checks executed from the Node orchestration layer using child processes:

1. **TypeScript compile**
   - Command: `npm run build` or direct `npx tsc --noEmit` depending on repository configuration.
   - Purpose: catch syntax, type, module-resolution, declaration, and emitted-type failures.

2. **Biome check**
   - Command: `npm run check` or direct `npx biome check .` depending on repository configuration.
   - Purpose: catch formatting, lint, import ordering, and static quality failures.

Implementation should prefer package scripts when present because projects often encode the correct flags there. If scripts are missing, StageCheck can mark the check as `skipped` with a machine-readable reason rather than guessing dangerously.

## Native child-process execution plan

Use Node's native child-process APIs rather than an LLM tool call:

```ts
import { spawn } from "node:child_process";

async function runStageCommand(command: string, args: string[], cwd: string): Promise<StageCheckCommandResult> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("close", (exitCode, signal) => {
      const ok = exitCode === 0;
      resolve({
        name: `${command} ${args.join(" ")}`,
        command,
        args,
        ok,
        exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut: false,
        stdout: stdout.slice(-20_000),
        stderr: stderr.slice(-20_000),
        summary: ok
          ? `passed: ${command} ${args.join(" ")}`
          : `failed (exit ${exitCode}): ${command} ${args.join(" ")}`,
      });
    });
  });
}
```

Recommended guardrails:

- Use explicit command arrays with `shell: false`.
- Run only allowlisted project-local checks.
- Add per-command timeouts.
- Cap captured output while preserving the tail, where compilers usually place actionable errors.
- Return JSON only; never ask the check layer to interpret the result.

## Verifier handoff

The Verifier receives a compact, deterministic payload:

```json
{
  "ok": false,
  "summary": "Stage checks failed (TypeScript compile).",
  "checks": [
    {
      "name": "TypeScript compile",
      "command": "npm",
      "args": ["exec", "--", "tsc", "--noEmit"],
      "ok": false,
      "exitCode": 2,
      "signal": null,
      "timedOut": false,
      "stdout": "...",
      "stderr": "...",
      "durationMs": 4312,
      "summary": "TypeScript compile failed (exit 2): npm exec -- tsc --noEmit"
    },
    {
      "name": "Biome check",
      "command": "npm",
      "args": ["exec", "--", "biome", "check", "."],
      "ok": true,
      "exitCode": 0,
      "signal": null,
      "timedOut": false,
      "stdout": "Checked 81 files...",
      "stderr": "",
      "durationMs": 910,
      "summary": "Biome check passed: npm exec -- biome check ."
    }
  ]
}
```

Verifier policy:

- If any deterministic check fails, return `passed: false` and include the relevant command/output tail as feedback to the Worker.
- If all deterministic checks pass, perform semantic review against the Thinker step's `instructions` and `expectedOutput`.
- The Worker feedback loop still uses `gate(..., { attempts: 3 })`, but the first-order authority for compiler/linter status becomes deterministic.

## Integration options

1. **Workflow helper**
   - Add a built-in `stageCheck()` workflow global.
   - Issue Delivery calls it from the `LocalChecks` phase.
   - Best developer experience, but expands the workflow VM API.

2. **Host tool**
   - Expose a restricted `stage_check` tool only to Issue Delivery/local-check phases.
   - Easier to audit and sandbox than arbitrary bash.

3. **Manager pre-verification hook**
   - Let `WorkflowManager` run StageCheck after selected agents complete.
   - Most deterministic, but least flexible for arbitrary generated workflows.

A good first implementation is option 2: a host-owned `stage_check` tool with a tiny allowlist for `npm run build` and `npm run check`, returning `StageCheckResult` JSON.

## Open questions

- How should StageCheck discover package-manager commands across npm, pnpm, yarn, uv, cargo, and go projects?
- Should Issue Delivery fail fast on deterministic failures, or always ask the Verifier to translate failures into Worker feedback?
- Should successful StageCheck reports be persisted in `.issue-delivery/status.json` and workflow run state?
- How do we let projects define safe custom checks without reintroducing arbitrary command execution?

## Recommendation

Implement deterministic StageCheck as a restricted host tool first. Keep the LLM Verifier, but make it consume structured facts from native TypeScript/Biome checks. This preserves the Thinker-Worker-Verifier control model while moving hard compiler/linter authority out of the model loop and into deterministic orchestration code.
