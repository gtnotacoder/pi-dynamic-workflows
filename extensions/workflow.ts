import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildContextModeRegistry,
  createEffortState,
  createWorkflowStorage,
  createWorkflowTool,
  installResultDelivery,
  installTaskPanel,
  installWorkflowEditor,
  loadWorkflowSettings,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerModesCommand,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  saveWorkflowSettingsForCwd,
  WorkflowManager,
} from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
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

  const workflowTool = createWorkflowTool({ cwd, manager, storage });
  pi.registerTool(workflowTool);
  registerWorkflowCommands(pi, manager, { storage, cwd });
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
