/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */

import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { agentErrorText, shorten, statusIcon, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import type { RunStatus } from "./run-persistence.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowSettings } from "./workflow-settings.js";
import { shortModel } from "./workflow-ui.js";

// `tokenUsage` is included so the detailed panel's live token/s counter refreshes
// as tokens accrue (not only on agent start/end). It is harmless in compact mode —
// it redraws identical content.
const RUN_EVENTS = [
  "agentStart",
  "agentEnd",
  "phase",
  "log",
  "tokenUsage",
  "complete",
  "error",
  "stopped",
  "paused",
  "resumed",
];
/** Events after which a run is gone and its token-rate samples can be dropped. */
const RUN_END_EVENTS = ["complete", "error", "stopped"] as const;

export interface TaskPanelOptions {
  storage?: WorkflowStorage;
  cwd?: string;
  /**
   * Live settings loader. When provided, the panel reads it fresh (with a short
   * TTL cache) on each render so `/workflows-progress` takes effect without a
   * restart. Omitted in tests / minimal hosts → always detailed.
   */
  loadSettings?: () => WorkflowSettings;
}

/**
 * Pick a clean human-readable summary from a workflow result, in order of
 * preference: a `verdict`/`report`/`summary` string field, a bare string
 * result, else a truncated JSON dump.
 */
function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "null";
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    for (const key of ["verdict", "report", "summary"] as const) {
      const val = obj[key];
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  const json = JSON.stringify(result, null, 2);
  return json.length > 400 ? `${json.slice(0, 400)}\n…(truncated)` : json;
}

function fitLine(line: string, width?: number): string {
  if (typeof width !== "number" || !Number.isFinite(width)) return line;
  const maxWidth = Math.max(0, Math.floor(width));
  if (visibleWidth(line) <= maxWidth) return line;
  return truncateToWidth(line, maxWidth);
}

/**
 * Escape `&`, `<`, `>` for safe inclusion in XML element text. (Quotes are
 * left alone — we never emit these strings inside attributes.)
 */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Cap a serialized result string at 8000 chars (matches Claude Code's
 * `<result>` truncation; the full result lives in `<output-file>` when
 * present). We don't write a separate output file, so the note just reports the
 * truncation size.
 */
const RESULT_MAX_CHARS = 8000;
function truncResult(s: string): string {
  return s.length > RESULT_MAX_CHARS
    ? `${s.slice(0, RESULT_MAX_CHARS)}\n... (truncated ${s.length - RESULT_MAX_CHARS} chars)`
    : s;
}

/**
 * Build a `<task-notification>` XML block for a finished (or failed/paused) run,
 * delivered back into the conversation so the model sees a structured result.
 * Child order:
 *   `<task-id>` `<tool-use-id>`? `<output-file>`? `<status>` `<summary>`
 *   `<recovery>`? (non-completed only) `<result>`? (completed only)
 *   `<failures>`? (if non-empty) `<usage>`.
 * There is no `<outcome>` element — outcome text folds into `<summary>`.
 *
 * `overrides` lets the error/paused event handlers inject the event payload's
 * status/error/resetHint (the run object may not yet reflect them in tests).
 */
/** Render a path plus its file:// URI so TUIs/chat that linkify URIs make it
 * clickable, while staying parseable as a plain path otherwise. */
const fileLink = (p: string) => `${p} (${pathToFileURL(p).href})`;

function formatTaskNotification(
  run: ManagedRun,
  overrides: { status?: RunStatus; error?: { message?: string }; resetHint?: string } = {},
): string {
  const status = overrides.status ?? run.status ?? (run.result ? "completed" : "failed");
  const err = overrides.error ?? run.error;
  const name = run.snapshot?.name ?? "Dynamic workflow";
  const result = run.result?.result;
  const agentCount = run.result?.agentCount ?? run.snapshot?.agentCount ?? 0;
  const tokens = run.result?.tokenUsage?.total ?? run.snapshot?.tokenUsage?.total ?? 0;
  // Per-run tool-uses: sum each agent's toolCall history entries, mirroring
  // Claude Code's <usage><tool_uses>. 0 when agent history isn't captured.
  const toolUses = (run.snapshot?.agents ?? []).reduce(
    (n, a) => n + (a.history?.filter((e) => e.kind === "toolCall").length ?? 0),
    0,
  );
  const durationMs = run.result?.durationMs ?? 0;
  const failures = (run.snapshot?.agents ?? [])
    .filter((a) => a.status === "error")
    .map((a) => ({ label: a.label, error: a.error, errorCode: a.errorCode }));

  let summary: string;
  if (status === "completed") {
    summary = `${name} — ${summarizeResult(result)}`;
  } else {
    summary = err?.message ? `${name} ${status}: ${err.message}` : `${name} ${status}`;
  }

  const lines: string[] = [
    "<task-notification>",
    `<task-id>${run.runId}</task-id>`,
    `<status>${status}</status>`,
    `<summary>${xmlEscape(summary)}</summary>`,
  ];

  if (status !== "completed") {
    const resume = `/workflows resume ${run.runId}`;
    const reset = overrides.resetHint ? ` (resets: ${overrides.resetHint})` : "";
    let recovery = `To resume after editing the script, run: ${resume}${reset}. Completed agents return cached results.`;
    // Link the on-disk transcripts and run-state JSON with file:// URIs so a
    // failed run is one click from its logs in chat (Claude Code surfaces these
    // in <recovery>). runStatePath is set on ManagedRun regardless of transcript
    // persistence, so the link works even with persistSubagentTranscripts:false.
    if (run.transcriptDir) recovery += `\nAgent transcripts: ${fileLink(run.transcriptDir)}`;
    if (run.runStatePath) recovery += `\nRun state: ${fileLink(run.runStatePath)}`;
    lines.push(`<recovery>${xmlEscape(recovery)}</recovery>`);
  } else if (result !== undefined) {
    lines.push(`<result>${xmlEscape(truncResult(JSON.stringify(result)))}</result>`);
  }

  if (failures.length) {
    lines.push(`<failures>${xmlEscape(JSON.stringify(failures))}</failures>`);
  }
  lines.push(
    `<usage><agent_count>${agentCount}</agent_count><subagent_tokens>${tokens}</subagent_tokens><tool_uses>${toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`,
  );
  lines.push("</task-notification>");
  return lines.join("\n");
}

/**
 * Deliver a finished (completed) run's result as a `<task-notification>` XML
 * block. Failed/paused runs go through {@link formatTaskNotification} directly
 * from the event handlers with the event payload's status/error.
 */
export function deliverText(run: ManagedRun): string {
  return formatTaskNotification(run);
}

/**
 * When a background run finishes (or fails), deliver its result back into the
 * conversation AND continue the turn so the assistant can act on it — without
 * blocking the user meanwhile:
 *
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle, feeding the
 *    result to the model so the paused conversation continues.
 *  - `deliverAs: "followUp"` means that if the user is busy in another turn, the
 *    result is queued and picked up after that turn finishes — never interrupting.
 *
 * Set up once per extension; idempotent via an internal guard.
 */
export function installResultDelivery(pi: ExtensionAPI, manager: WorkflowManager): void {
  // Mutable holder on manager so shared across re-calls (e.g. session_start after /reload).
  const m = manager as unknown as { __deliveryInstalled?: boolean; __holder?: { pi: ExtensionAPI } };
  if (m.__deliveryInstalled) {
    // Refresh pi reference only — listeners stay registered.
    if (m.__holder) m.__holder.pi = pi;
    return;
  }
  m.__deliveryInstalled = true;
  m.__holder = { pi };

  const deliver = (content: string) => {
    try {
      const ret = m.__holder?.pi.sendMessage(
        { customType: "workflow-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      // sendMessage may return a promise; a sync try/catch can't catch its
      // rejection, so swallow the async path too. A stale ctx after /reload is
      // the expected failure — the result is still visible via /workflows.
      void Promise.resolve(ret).catch(() => {});
    } catch {
      // Synchronous failure (e.g. stale ctx) — result still visible via /workflows.
    }
  };

  manager.on("complete", ({ runId }: { runId: string }) => {
    const run = manager.getRun(runId);
    // Only background/resumed runs are delivered: a foreground (sync) run already
    // returns its result inline as the tool result, so re-delivering would dup it.
    if (run?.background) deliver(deliverText(run));
  });
  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    const run = manager.getRun(runId);
    if (!run?.background) return;
    deliver(formatTaskNotification(run, { status: "failed", error }));
  });
  // A provider usage/quota limit checkpoints the run as paused (not failed): tell the
  // user it is resumable once their budget refills, rather than letting it look dead.
  // Manual pause() also emits "paused" but with no reason — guard so only the
  // usage-limit case delivers a message.
  manager.on(
    "paused",
    ({
      runId,
      reason,
      error,
      resetHint,
    }: {
      runId: string;
      reason?: string;
      error?: { message?: string };
      resetHint?: string;
    }) => {
      if (reason !== "usage_limit") return;
      const run = manager.getRun(runId);
      if (!run?.background) return;
      deliver(formatTaskNotification(run, { status: "paused", error, resetHint }));
    },
  );
}

export function renderPanel(manager: WorkflowManager, theme: Theme, width?: number): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const rows = active.map((r) => {
    const live = manager.getRun(r.runId);
    const agents = live?.snapshot.agents ?? r.agents;
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const phase = live?.snapshot.currentPhase ? ` · ${live.snapshot.currentPhase}` : "";
    return `  ${icon} ${r.workflowName}  ${done}/${agents.length} agents${phase}`;
  });
  // Finished runs leave this live panel but are kept in the navigator. Tell the
  // user so a completed run doesn't look like it vanished.
  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  const hint = theme.fg(
    "dim",
    finished > 0
      ? `  /workflows — open navigator (${finished} finished kept in history)`
      : "  /workflows — open navigator",
  );
  return [theme.bold(`Workflows running (${active.length}):`), ...rows, hint].map((line) => fitLine(line, width));
}

// ─── Detailed mode: live token rate ────────────────────────────────────────────

/** Rolling window for the token/s rate. Older samples age out so a stall decays to 0. */
const RATE_WINDOW_MS = 10_000;
/** Per-run (timestamp, cumulative total) samples, keyed by the persisted runId so
 *  the rolling rate survives pause→resume. Cleared when a run ends. */
const tokenSamples = new Map<string, Array<{ ts: number; total: number }>>();

/** Record a token-total sample for `runId` at time `now` (ms). */
export function sampleTokens(runId: string, total: number, now: number): void {
  const samples = tokenSamples.get(runId) ?? [];
  const last = samples[samples.length - 1];
  // Collapse repeat renders within the same instant (e.g. width recalcs).
  if (last && last.ts === now && last.total === total) return;
  samples.push({ ts: now, total });
  // Drop samples beyond the rolling window, always keeping ≥2 so a rate is computable.
  while (samples.length > 2 && now - samples[0].ts > RATE_WINDOW_MS) samples.shift();
  tokenSamples.set(runId, samples);
}

/** Tokens/second over the rolling window; 0 when too few samples or totals plateau. */
export function tokensPerSecond(runId: string): number {
  const samples = tokenSamples.get(runId);
  if (!samples || samples.length < 2) return 0;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsedMs = newest.ts - oldest.ts;
  if (elapsedMs <= 0) return 0;
  const delta = newest.total - oldest.total;
  if (delta <= 0) return 0;
  return (delta / elapsedMs) * 1000;
}

/** Forget a run's samples (call when it finishes) so the map can't grow unbounded. */
export function clearTokenSamples(runId: string): void {
  tokenSamples.delete(runId);
}

/** Compact token count for the space-constrained panel: 980, 12.4K, 1.3M. */
function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export function clampMaxAgents(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 8;
  return Math.min(1000, Math.floor(value));
}

/** Per-phase + per-agent body for one run in detailed mode (mirrors renderWorkflowLines). */
function renderRunBody(
  snap: WorkflowSnapshot,
  agents: WorkflowAgentSnapshot[],
  maxAgents: number,
  theme: Theme,
): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const lines: string[] = [];
  // Group agents by phase, declared order first then discovery order (as the navigator does).
  const order = snap.phases.length ? [...snap.phases] : [];
  const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
  for (const a of agents) {
    const key = a.phase ?? "(no phase)";
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key)?.push(a);
    if (!order.includes(key)) order.push(key);
  }
  for (const title of order) {
    const phaseAgents = byPhase.get(title) ?? [];
    if (!phaseAgents.length) continue;
    const done = phaseAgents.filter((a) => a.status === "done").length;
    const running = phaseAgents.filter((a) => a.status === "running").length;
    const errors = phaseAgents.filter((a) => a.status === "error").length;
    const skipped = phaseAgents.filter((a) => a.status === "skipped").length;
    const complete = done + errors + skipped === phaseAgents.length;
    const marker = running > 0 || (!complete && snap.currentPhase === title) ? "▶" : complete ? "✓" : " ";
    const phaseTokens = phaseAgents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    const phaseMeta = [
      `${done}/${phaseAgents.length} agents`,
      running ? `${running} running` : "",
      errors ? `${errors} errors` : "",
      phaseTokens > 0 ? `${fmtTokensShort(phaseTokens)} tok` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(theme.fg("accent", `  ${marker} ${title}`) + dim(`  ${phaseMeta}`));

    const visible = phaseAgents.slice(-maxAgents);
    for (const a of visible) {
      const tok = a.tokens ? dim(` ${fmtTokensShort(a.tokens)} tok`) : "";
      const mdl = shortModel(a.model);
      const model = mdl ? dim(` · ${mdl}`) : "";
      // Show each finished agent's result preview so the panel is watchable as a
      // run progresses — the manager already populates `resultPreview` on agentEnd.
      const previewTxt = a.status === "done" && a.resultPreview ? dim(` — ${shorten(a.resultPreview, 50)}`) : "";
      // Surface why an agent failed (visibility for errored subagents): the
      // manager populates `error` on agentEnd failure — render it inline (first
      // non-empty line, surrogate-safe, no dangling dash on blank errors) so a
      // developer can see why without opening transcripts. Placed BEFORE tok/model
      // so fitLine's right-truncation cuts those before the error reason in narrow
      // terminals — the reason is the whole point of the feature.
      const errTxt = agentErrorText(a, theme);
      lines.push(`    [${a.id}] ${statusIcon(a.status)} ${shorten(a.label, 40)}${errTxt}${tok}${model}${previewTxt}`);
    }
    if (phaseAgents.length > visible.length) {
      lines.push(dim(`    … ${phaseAgents.length - visible.length} earlier agents`));
    }
  }
  return lines;
}

/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and a live token/s rate, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export function renderPanelDetailed(
  manager: WorkflowManager,
  theme: Theme,
  width: number | undefined,
  maxAgents: number,
  now: number,
): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const dim = (t: string) => theme.fg("dim", t);
  const out: string[] = [theme.bold(`Workflows running (${active.length}):`)];

  for (const r of active) {
    const live = manager.getRun(r.runId);
    const snap = live?.snapshot;
    const agents = (snap?.agents ?? r.agents) as WorkflowAgentSnapshot[];
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const usage = snap?.tokenUsage ?? r.tokenUsage;
    // The run-level tokenUsage aggregate is only finalized when the run ends, so
    // it reads 0 for the whole live run. Per-agent `tokens` update on each agent
    // completion, so sum those for a live total (and keep the header consistent
    // with the per-phase subtotals). Note: tokens land at agent-completion
    // granularity, so the rate reflects completion throughput — it decays to 0
    // during a single long-running agent or a stall (which is the intended signal).
    const total = agents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    // Sample the running total and derive the rolling token/s. Paused runs don't
    // accrue tokens, so their rate is suppressed (a stalled rate would mislead).
    sampleTokens(r.runId, total, now);
    const rate = r.status === "running" ? tokensPerSecond(r.runId) : 0;
    const meta = [
      `${done}/${agents.length} agents`,
      snap?.currentPhase || "",
      total > 0 ? `${fmtTokensShort(total)} tok` : "",
      // 2 decimals for ≥1¢, 4 for sub-cent so a real cost never shows as "$0.00".
      // (cost is only known once the run finalizes its usage.)
      usage?.cost ? `$${usage.cost.toFixed(usage.cost >= 0.01 ? 2 : 4)}` : "",
      rate > 0 ? `${Math.round(rate)} tok/s` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${icon} ${theme.bold(r.workflowName)}  ${dim(meta)}`);
    if (snap) out.push(...renderRunBody(snap, agents, maxAgents, theme));
  }

  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  out.push(
    dim(
      finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator",
    ),
  );
  return out.map((line) => fitLine(line, width));
}

/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export function installTaskPanel(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: TaskPanelOptions = {},
): void {
  // Mark the manager so the workflow tool can suppress redundant chat streaming
  // only when this panel will actually show live progress.
  manager.hasTaskPanel = true;
  // Live-read settings with a ~1s TTL: a render-path disk read every frame would
  // be wasteful, but re-reading at most once a second still makes
  // /workflows-progress take effect "immediately" (no restart).
  let cached: WorkflowSettings = {};
  let cachedAt = Number.NEGATIVE_INFINITY;
  const settings = (): WorkflowSettings => {
    if (!opts.loadSettings) return cached;
    const now = Date.now();
    if (now - cachedAt > 1000) {
      try {
        cached = opts.loadSettings() ?? {};
      } catch {
        cached = {};
      }
      cachedAt = now;
    }
    return cached;
  };
  const hasActiveRun = () => manager.hasActiveRuns();

  ui.setWidget(
    "workflow-tasks",
    (tui: TUI, theme: Theme) => {
      const onEvent = () => tui.requestRender();
      for (const ev of RUN_EVENTS) manager.on(ev, onEvent);
      const onRunEnd = ({ runId }: { runId: string }) => clearTokenSamples(runId);
      for (const ev of RUN_END_EVENTS) manager.on(ev, onRunEnd);
      // In detailed mode (the default), force a redraw every 2s while a run is active
      // so the token/s rate keeps updating between sparse token events — and decays
      // to 0 when an agent stalls. Gated + unref'd so it costs nothing when idle.
      const timer = setInterval(() => {
        if (settings().progressPanelMode !== "compact" && hasActiveRun()) tui.requestRender();
      }, 2000);
      (timer as { unref?: () => void }).unref?.();
      // Purely informational: it lists running runs and re-renders on events. To
      // open the navigator, the user runs /workflows (the panel takes no input).
      const comp: Component & { dispose?(): void } = {
        render: (width: number) => {
          const s = settings();
          // Default to the detailed per-phase/per-agent tree unless explicitly compact.
          if (s.progressPanelMode !== "compact") {
            return renderPanelDetailed(manager, theme, width, clampMaxAgents(s.progressPanelMaxAgents), Date.now());
          }
          return renderPanel(manager, theme, width);
        },
        invalidate: () => {},
        dispose: () => {
          clearInterval(timer);
          for (const ev of RUN_EVENTS) manager.off(ev, onEvent);
          for (const ev of RUN_END_EVENTS) manager.off(ev, onRunEnd);
        },
      };
      return comp;
    },
    { placement: "belowEditor" },
  );
}
