/**
 * Configuration constants for pi-dynamic-workflows.
 */

/** Model-facing tool name. Kept stable for compatibility with existing prompts and docs. */
export const WORKFLOW_TOOL_NAME = "workflow";

/** Exact editor trigger phrase for workflows mode; plain "workflow" no longer auto-arms. */
export const WORKFLOW_TRIGGER_PHRASE = "workflow-run";

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/**
 * Maximum items accepted by a single parallel()/pipeline() fan-out call.
 * >4096 items is rejected explicitly rather than silently truncated.
 */
export const MAX_FANOUT_ITEMS = 4096;

/**
 * Maximum size of a workflow script body in bytes (524288 = 512 KB). Scripts
 * exceeding this are rejected up front as a non-recoverable validation error.
 */
export const MAX_SCRIPT_BYTES = 524_288;

/**
 * Timeout (30000 ms) for the synchronous runInContext() call that evaluates the
 * wrapped workflow script. Because the wrapper is `(async () => { body })()`,
 * runInContext returns a Promise synchronously, so this only guards *synchronous*
 * script setup. The async agent work is bounded separately by agentTimeoutMs / budget.
 */
export const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Default wall-clock timeout for an entire async workflow run. This bounds trusted
 * scripts that suspend forever (for example `await new Promise(() => {})`). It is
 * not a CPU-loop sandbox; untrusted workflow isolation requires an OS boundary.
 */
export const DEFAULT_WORKFLOW_TIMEOUT_MS = 30 * 60_000;

/** Default timeout for a single agent in milliseconds. null means no hard timeout. */
export const DEFAULT_AGENT_TIMEOUT_MS = null;

/** Maximum concurrent agents. */
export const MAX_CONCURRENCY = 16;

/** Maximum automatic retry attempts after a recoverable agent failure. */
export const MAX_AGENT_RETRIES = 3;

/** Default token budget if none specified. */
export const DEFAULT_TOKEN_BUDGET = null;

/** Legacy project-relative directory for persisted workflow run state. New writes use workflowProjectPaths(). */
export const WORKFLOW_RUNS_DIR = ".pi/workflows/runs";

/**
 * Whether per-subagent NDJSON transcripts are written to disk by default. Each
 * subagent (workflow `agent()`) gets an `agent-<id>.jsonl` transcript so a failed
 * run is debuggable. Opt out via `persistSubagentTranscripts: false` in settings.
 */
export const PERSIST_SUBAGENT_TRANSCRIPTS_DEFAULT = true;

/** Legacy project-relative directory for saved workflow commands. New writes use workflowProjectPaths(). */
export const WORKFLOW_SAVED_DIR = ".pi/workflows/saved";

/** User-level saved workflows directory. */
export const USER_WORKFLOW_SAVED_DIR = "~/.pi/workflows/saved";

/** User-level model tiers config file, relative to the home directory. */
export const MODEL_TIERS_FILE = ".pi/workflows/model-tiers.json";

/** User-level workflow extension settings file, relative to the home directory. */
export const WORKFLOW_SETTINGS_FILE = ".pi/workflows/settings.json";

/**
 * Named workflow subagent definitions directory. Resolved both project-relative
 * (cwd/.pi/agents) and home-relative (~/.pi/agents); project entries win on name
 * collision. Each `*.md` file is an agent definition (frontmatter + body prompt).
 */
export const AGENTS_DIR = ".pi/agents";
