import telemetryExtension from "@amaster.ai/pi-telemetry";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildContextModeRegistry,
  createEffortState,
  createWorkflowStorage,
  createWorkflowTool,
  installResultDelivery,
  installTaskPanel,
  installWorkflowEditor,
  installWorkflowLangfuseTracing,
  loadWorkflowSettings,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerModesCommand,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  registerWorkflowTelemetryReportCommand,
  saveWorkflowSettingsForCwd,
  WorkflowManager,
} from "../src/index.js";

// ── Issue #19: Stale telemetry env hardening ──────────────────────────────
export const PI_TELEMETRY_ENV_KEYS = [
  "PI_TELEMETRY_OWNER_PID",
  "PI_TELEMETRY_SESSION_ID",
  "PI_TELEMETRY_TRACE_ID",
] as const;

/** Parse a PID string, returning a positive finite integer or `null`. */
export function parsePid(value: string | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  // Must be a finite integer, strictly positive, and parse without trailing junk
  if (!Number.isFinite(n) || n <= 0 || n !== Math.trunc(n)) return null;
  // Reject strings that Number() coerces unexpectedly (e.g. "0x1", "1e2", whitespace)
  if (String(n) !== value.trim()) return null;
  return n;
}

/** Check whether a process with the given PID is live (EPERM counts as live). */
export function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "EPERM") return true;
    return false;
  }
}

/** Runtime context for telemetry env checks. */
export type TelemetryRuntime = {
  pid: number;
  ppid: number;
  /** Inject in tests to avoid relying on real PIDs. */
  isProcessLive?: (pid: number) => boolean;
};

/**
 * Return true only when the telemetry env describes a coherent, live,
 * direct-child/subagent launch of the *current* process.
 *
 * Conditions (all must hold):
 *  1. PI_TELEMETRY_OWNER_PID is a valid positive finite integer
 *  2. It is NOT the current process's own PID
 *  3. The owner PID process is still live
 *  4. Both PI_TELEMETRY_SESSION_ID and PI_TELEMETRY_TRACE_ID are non-empty
 *  5. The owner PID equals the current/runtime parent PID (ppid)
 */
export function shouldPreservePiTelemetryEnv(
  env: Record<string, string | undefined> = process.env as any,
  runtime?: TelemetryRuntime,
): boolean {
  const ownerPid = parsePid(env.PI_TELEMETRY_OWNER_PID);
  if (ownerPid == null) return false;

  const pid = runtime?.pid ?? process.pid;
  const ppid = runtime?.ppid ?? (typeof process.ppid === "number" ? process.ppid : 0);
  const checkLive = runtime?.isProcessLive ?? isProcessLive;

  // Must not be our own PID
  if (ownerPid === pid) return false;
  // Owner must still be alive (EPERM counts as alive)
  if (!checkLive(ownerPid)) return false;
  // Both session and trace IDs must be non-empty
  if (!env.PI_TELEMETRY_SESSION_ID || !env.PI_TELEMETRY_TRACE_ID) return false;
  // Owner PID must be our parent process — only direct-child launches inherit
  if (ownerPid !== ppid) return false;

  return true;
}

/**
 * Delete all three telemetry env keys whenever any key is present but the
 * env should NOT be preserved (stale / partial / unrelated owner).
 */
export function scrubStalePiTelemetryEnv(
  env: Record<string, string | undefined> = process.env as any,
  runtime?: TelemetryRuntime,
): void {
  const anyPresent = PI_TELEMETRY_ENV_KEYS.some((k) => env[k] != null && env[k] !== "");
  if (!anyPresent) return;
  if (shouldPreservePiTelemetryEnv(env, runtime)) return;
  for (const key of PI_TELEMETRY_ENV_KEYS) {
    delete env[key];
  }
}
// ── End Issue #19 ─────────────────────────────────────────────────────────

export default function extension(pi: ExtensionAPI) {
  // Stale telemetry env hardening (Issue #19)
  scrubStalePiTelemetryEnv();

  // Register runtime telemetry before workflow handlers so Pi lifecycle events can be exported.
  telemetryExtension(pi);

  // Single manager/storage shared by the workflow tool and the /workflows command,
  // so background runs started by the tool are reachable from the command.
  const cwd = process.cwd();
  const storage = createWorkflowStorage(cwd);
  const settings = loadWorkflowSettings({ cwd });
  // Built-ins + any project-defined `contextModes`, threaded into the manager so
  // tool-driven runs resolve project modes (slash commands build their own per call).
  const contextModeRegistry = buildContextModeRegistry(settings.contextModes);
  const manager = new WorkflowManager({
    cwd,
    loadSavedWorkflow: (name) => storage.load(name)?.script,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    defaultWorkflowTimeoutMs: settings.defaultWorkflowTimeoutMs,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
    contextModeRegistry,
  });
  const workflowTracing = installWorkflowLangfuseTracing(manager, { cwd });
  pi.on("session_shutdown", async () => {
    await workflowTracing.close();
  });

  const workflowTool = createWorkflowTool({ cwd, manager, storage });
  pi.registerTool(workflowTool);
  registerWorkflowCommands(pi, manager, { storage, cwd });
  registerWorkflowTelemetryReportCommand(pi, { cwd, manager });
  registerWorkflowModelsCommand(pi);
  registerModesCommand(pi, { cwd });
  registerBuiltinWorkflows(pi, { cwd, manager });
  registerAllSavedWorkflows(pi, cwd, storage, manager);
  // Standing /effort opt-in (off|high|ultra): auto-arms a workflow for substantive
  // messages, like CC's ultracode. Shared with the editor's input hook below.
  const effort = createEffortState();
  registerEffortCommand(pi, effort);
  // "Workflows mode": type `workflow-run` to arm a forced workflow (animated),
  // Backspace right after the phrase disarms it. Registers the `input` hook now;
  // the editor itself is installed once the UI is available (session_start).
  let editorInstalled = false;

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
    // Tell the manager the session's main model so "explore" agents auto-tier
    // down to a lighter same-family sibling (e.g. Claude → Haiku).
    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    // Scope the /workflows history to this session: runs persist on disk across
    // sessions, but the navigator/task panel show only the current session's runs.
    // Switching back to a previous session re-shows that session's runs.
    try {
      manager.setSessionId(ctx.sessionManager?.getSessionId());
    } catch {
      // sessionManager may be unavailable in some contexts — fall back to global history.
    }
    // Deliver a background run's result into the conversation when it finishes.
    installResultDelivery(pi, manager);
    // Live "workflows running" panel below the input (focus + enter to open).
    // Pass a live settings loader so /workflows-progress (compact|detailed) takes
    // effect without a restart.
    installTaskPanel(pi, manager, ctx.ui, { storage, cwd, loadSettings: () => loadWorkflowSettings({ cwd }) });
    if (!editorInstalled) {
      installWorkflowEditor(pi, ctx.ui, effort, {
        settingsStore: {
          load: () => loadWorkflowSettings({ cwd }),
          save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, cwd),
        },
      });
      editorInstalled = true;
    }
  });
}
