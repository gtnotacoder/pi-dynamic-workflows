/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a
 * command that runs its script, passing parsed arguments through as `args`.
 */

import {
  createCodingTools,
  createReadOnlyTools,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { buildRegistryForCwd, extractModeFlag } from "./modes-command.js";
import { runWorkflow, type WorkflowRunOptions, type WorkflowRunResult } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";

/**
 * Build the command description for a saved workflow. The workflow's own
 * `description` is preserved when present; a concise `[--mode <name>]` hint is
 * appended so users discover the run-level context-mode flag — unless the
 * description already mentions `--mode` (or `contextMode`).
 */
function describeSavedWorkflowCommand(wf: SavedWorkflow): string {
  const base = wf.description?.trim() || `Saved workflow: ${wf.name}`;
  if (/--mode\b|contextMode/i.test(base)) return base;
  return `${base} [--mode <name>]`;
}

function isRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

function reportText(result: WorkflowRunResult): string {
  const r = result.result as { report?: unknown } | undefined;
  if (r && typeof r.report === "string" && r.report.trim()) return r.report;
  return JSON.stringify(result.result, null, 2);
}

function backgroundStartedText(name: string, runId: string, transcriptDir?: string): string {
  const lines = [`Workflow /${name} started in the background.`, `Run ID: ${runId}`];
  if (transcriptDir) lines.push(`Transcript dir: ${transcriptDir}`);
  lines.push(
    `Live progress should appear in the workflow task panel.`,
    `Use /workflows status ${runId} or /workflows watch ${runId} for status, and /workflows stop ${runId} to cancel.`,
    `The final result will be delivered back into this conversation automatically when it finishes.`,
  );
  return lines.join("\n");
}

function truthyArg(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function isExplicitRepairRun(wf: SavedWorkflow, args: Record<string, unknown>): boolean {
  if (/(^|[-_])repair([-_]|$)/i.test(wf.name)) return true;
  if (truthyArg(args.repair) || truthyArg(args.repairMode) || truthyArg(args.allowMutation)) return true;
  return (
    String(args.mode ?? "")
      .trim()
      .toLowerCase() === "repair"
  );
}

function isReviewWorkflow(wf: SavedWorkflow): boolean {
  const haystack = `${wf.name}\n${wf.description ?? ""}`;
  return /(^|[-_\s])(review|adversarial[-_\s]*review|code[-_\s]*review|pr[-_\s]*review)([-_\s]|$)/i.test(haystack);
}

function savedWorkflowExecutionPolicy(
  cwd: string,
  wf: SavedWorkflow,
  args: Record<string, unknown>,
): { tools: WorkflowRunOptions["tools"]; awaitCompletion: boolean } {
  const readOnlyReview = isReviewWorkflow(wf) && !isExplicitRepairRun(wf, args);
  return {
    tools: readOnlyReview ? createReadOnlyTools(cwd) : createCodingTools(cwd),
    // One-shot tmux review panes should not drop back into an interactive Pi
    // prompt while/after the review workflow is running. Awaiting the managed
    // promise keeps the command active until installResultDelivery posts the
    // final result; terminal-launched Pi then exits instead of leaving an
    // autonomous editing-capable review pane behind.
    awaitCompletion: readOnlyReview,
  };
}

/**
 * Parse a command argument string into an `args` object for the script.
 * Supports `key=value` tokens; everything else collects into `_` (and `_raw`).
 * Declared parameter defaults fill in missing keys.
 */
export function parseCommandArgs(raw: string, parameters?: SavedWorkflow["parameters"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const positional: string[] = [];
  for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
    else positional.push(tok);
  }
  out._ = positional.join(" ");
  out._raw = raw.trim();
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (out[key] === undefined && spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

/** Register one saved workflow as a `/<name>` command (idempotent).
 * When a WorkflowManager is provided, the workflow runs through it (visible in
 * /workflows TUI, background execution, task panel). Otherwise falls back to
 * the inline runWorkflow() (foreground, no TUI tracking).
 *
 * Pi has no `unregisterCommand`, so a command cannot be removed mid-session
 * after its workflow is deleted (it is correctly gone on next launch, since
 * registerAllSavedWorkflows only registers what's in storage). The optional
 * `exists` predicate lets the handler detect that case at invocation time and
 * tell the user to reload rather than silently re-running a deleted workflow. */
export function registerSavedWorkflow(
  pi: ExtensionAPI,
  cwd: string,
  wf: SavedWorkflow,
  manager?: WorkflowManager,
  exists?: () => boolean,
): void {
  if (isRegistered(pi, wf.name)) {
    // Collision policy: builtins register first, saved workflows register
    // second. A saved workflow whose name collides with an existing command
    // is skipped (not silently shadowed) and the user gets a deterministic
    // warning suggesting they rename the saved workflow. Registration stays
    // non-blocking: pi.sendMessage is optional in the type and may be absent
    // in minimal test doubles, so guard defensively.
    const msg = {
      customType: "workflow:saved-command-collision",
      content: `Saved workflow /${wf.name} was not registered because a command with that name already exists. Rename the saved workflow to avoid the collision.`,
      display: true,
    };
    void pi.sendMessage?.(msg);
    return;
  }
  pi.registerCommand(wf.name, {
    description: describeSavedWorkflowCommand(wf),
    async handler(args: string, ctx: ExtensionCommandContext) {
      if (exists && !exists()) {
        ctx.ui.notify(`/${wf.name} was deleted — reload the session to remove this command.`, "warning");
        return;
      }
      // Pull a run-level `--mode <name>` out of the args (e.g. `--mode isolated`)
      // so e.g. `/my-flow --mode isolated` sets the LOWEST-precedence posture for
      // every subagent in this run without editing any agentType `.md`. The
      // remaining args (with the flag removed) are parsed as usual.
      const { mode, rest } = extractModeFlag(args);
      // Parse the remaining args (with `--mode` stripped) once and reuse for
      // both the manager and inline execution paths. `mode=value` is still a
      // normal saved-workflow argument; only `--mode` / `--mode=<name>` is
      // reserved for run-level context.
      const parsedArgs = parseCommandArgs(rest, wf.parameters);
      const executionPolicy = savedWorkflowExecutionPolicy(cwd, wf, parsedArgs);
      try {
        ctx.ui.notify(`Starting /${wf.name}…`, "info");

        if (manager) {
          // Run through the WorkflowManager. Most saved workflows return
          // immediately after the started notification. Read-only review
          // workflows deliberately keep the slash-command handler alive until the
          // managed promise settles so one-shot tmux review panes exit or remain
          // non-interactive instead of returning to an editing-capable Pi prompt.
          const { runId, promise } = manager.startInBackground(wf.script, parsedArgs, {
            contextMode: mode,
            tools: executionPolicy.tools,
          });
          const key = `wf:${wf.name}`;
          ctx.ui.setStatus(key, `${wf.name}: running (${runId})`);
          void promise.finally(() => ctx.ui.setStatus(key, undefined)).catch(() => {});
          const transcriptDir = manager.getRun(runId)?.transcriptDir;
          await pi.sendMessage({
            customType: `workflow:${wf.name}:started`,
            content: backgroundStartedText(wf.name, runId, transcriptDir),
            display: true,
          });
          if (executionPolicy.awaitCompletion) await promise;
          return;
        }

        // Fallback: inline runWorkflow (foreground, no TUI tracking).
        const result = await runWorkflow(wf.script, {
          cwd,
          args: parsedArgs,
          tools: executionPolicy.tools,
          contextMode: mode,
          contextModeRegistry: buildRegistryForCwd(cwd),
          onPhase: (title) => ctx.ui.setStatus(`wf:${wf.name}`, `${wf.name}: ${title}`),
        });

        ctx.ui.setStatus(`wf:${wf.name}`, undefined);
        await pi.sendMessage({ customType: `workflow:${wf.name}`, content: reportText(result), display: true });
      } catch (error) {
        ctx.ui.setStatus(`wf:${wf.name}`, undefined);
        ctx.ui.notify(`/${wf.name} failed: ${error instanceof Error ? error.message : error}`, "error");
      }
    },
  });
}

/** Register every saved workflow found in storage.
 * When a WorkflowManager is provided, workflows run through it (visible in
 * /workflows TUI, background execution, task panel). */
export function registerAllSavedWorkflows(
  pi: ExtensionAPI,
  cwd: string,
  storage: WorkflowStorage,
  manager?: WorkflowManager,
): void {
  for (const wf of storage.list()) {
    registerSavedWorkflow(pi, cwd, wf, manager, () => storage.list().some((w) => w.name === wf.name));
  }
}
