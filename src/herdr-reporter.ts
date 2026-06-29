/**
 * Tier 0 herdr bridge — mirror live workflow status into the herdr TUI.
 *
 * When pi runs inside a [herdr](https://herdr.dev) pane, herdr's own pi
 * integration already reports the pane's agent state (idle/working/blocked)
 * under the source `herdr:pi`. This reporter does NOT touch that state. It
 * layers a sidecar one-line *custom status* onto the same pane via
 * `herdr pane report-metadata`, so a fan-out that would otherwise show as a
 * single opaque "working" cell instead reads e.g.
 *
 *     research_topic ▶ Synthesize 12/40 · 3.2K tok
 *
 * Design constraints (intentionally minimal — see README "Tier 0"):
 *  - Feature-detected: a no-op unless `HERDR_PANE_ID` is present. Degrades
 *    silently outside herdr or when the `herdr` CLI is missing.
 *  - Separate `--source` (`pi-workflows`) + `--applies-to-source herdr:pi`, so
 *    we annotate pi's detected agent without fighting its state machine.
 *  - Throttled: token events fire often, so updates coalesce into one push per
 *    `throttleMs`, and only when the rendered string actually changes.
 *  - Self-healing: every push carries `--ttl-ms`, so a crashed/killed workflow's
 *    status expires from the cell instead of lingering.
 *  - Best-effort: every herdr call is fire-and-forget; failures never throw into
 *    the workflow runtime.
 */

import { spawn } from "node:child_process";
import {
  CONDUCTOR_ATTENTION_STATUSES,
  CONDUCTOR_STATUS_ICONS,
  CONDUCTOR_STATUS_LABELS,
  type ConductorRunStatus,
} from "./conductor-types.js";
import type { WorkflowManager } from "./workflow-manager.js";

/** herdr `--source` namespace for our sidecar metadata (kept distinct from `herdr:pi`). */
const SOURCE = "pi-workflows";
/** The detected pi agent source our custom-status rides on. Overridable for non-standard setups. */
const APPLIES_TO_DEFAULT = "herdr:pi";
/** Coalesce bursty token events into at most one push per window. */
const THROTTLE_MS = 750;
/** Status TTL: a few throttle windows, so a dead workflow self-clears but a live one keeps it fresh. */
const TTL_MS = 20_000;
/** Keep the cell readable — herdr status cells are narrow. */
const MAX_STATUS_LEN = 120;

/** Engine statuses that count as "active" for the panel/sidecar (mirrors task-panel). */
const ACTIVE_RUN_STATUSES = new Set(["running", "paused"]);
/** Manager events after which the rendered status may have changed. */
const REPORT_EVENTS = ["agentStart", "agentEnd", "phase", "tokenUsage", "resumed", "semanticStatus"] as const;

/** Minimal view of a run needed to render the sidecar — decoupled from persistence for testability. */
export interface ActiveRunView {
  workflowName: string;
  status: string;
  currentPhase?: string;
  agents: Array<{ status: string; tokens?: number }>;
  semanticStatus?: ConductorRunStatus;
}

/** Compact token count: 980, 12.4K, 1.3M. */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function truncate(s: string, max = MAX_STATUS_LEN): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Render the one-line custom-status for the herdr cell, or `null` when nothing
 * is active (callers clear the cell on `null`). Pure — unit-tested directly.
 */
export function summarizeActiveRuns(active: ActiveRunView[]): string | null {
  if (!active.length) return null;

  if (active.length === 1) {
    const r = active[0];
    const total = r.agents.length;
    const done = r.agents.filter((a) => a.status === "done").length;
    const tokens = r.agents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    const sem = r.semanticStatus;
    const icon = sem ? CONDUCTOR_STATUS_ICONS[sem.status] : r.status === "paused" ? "⏸" : "◆";
    const phase = r.currentPhase ? ` ${r.currentPhase}` : "";
    const agentPart = total > 0 ? ` ${done}/${total}` : "";
    const tokPart = tokens > 0 ? ` · ${fmtTokens(tokens)} tok` : "";
    const semPart = sem ? ` · ${CONDUCTOR_STATUS_LABELS[sem.status]}` : "";
    return truncate(`${icon} ${r.workflowName}${phase}${agentPart}${tokPart}${semPart}`.trim());
  }

  // Multiple concurrent runs — aggregate, and surface anything needing attention.
  const done = active.reduce((n, r) => n + r.agents.filter((a) => a.status === "done").length, 0);
  const total = active.reduce((n, r) => n + r.agents.length, 0);
  const tokens = active.reduce((n, r) => n + r.agents.reduce((m, a) => m + (a.tokens ?? 0), 0), 0);
  const attention = active.filter(
    (r) => r.semanticStatus && CONDUCTOR_ATTENTION_STATUSES.has(r.semanticStatus.status),
  ).length;
  const agentPart = total > 0 ? ` · ${done}/${total} agents` : "";
  const tokPart = tokens > 0 ? ` · ${fmtTokens(tokens)} tok` : "";
  const attPart = attention > 0 ? ` · ${attention} need attention` : "";
  return truncate(`◆ ${active.length} workflows${agentPart}${tokPart}${attPart}`);
}

/**
 * Resolve the herdr pane this process should report into, or `null` to disable.
 * Disabled when not inside herdr (`HERDR_PANE_ID` unset) or via the
 * `PI_WORKFLOWS_HERDR=0` opt-out.
 */
export function herdrPaneTarget(env: NodeJS.ProcessEnv = process.env): string | null {
  const optOut = env.PI_WORKFLOWS_HERDR;
  if (optOut === "0" || optOut === "false" || optOut === "off") return null;
  const pane = env.HERDR_PANE_ID?.trim();
  return pane ? pane : null;
}

/** Fire-and-forget `herdr <args...>`; never throws, ignores all output/errors. */
function defaultRun(args: string[]): void {
  try {
    const child = spawn("herdr", args, { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // herdr binary missing / spawn failed — silently degrade.
  }
}

export interface HerdrReporterOptions {
  /** Master on/off, from the `herdrStatus` setting. `false` → no-op (default on). */
  enabled?: boolean;
  /** Override the target pane (default: `HERDR_PANE_ID`). */
  paneId?: string;
  /** Override env used for feature detection (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override the herdr invoker (tests). Receives argv after `herdr`. */
  run?: (args: string[]) => void;
  /** Source to annotate (default `herdr:pi`); set "" to attach pane-level only. */
  appliesToSource?: string;
  /** Coalescing window in ms (default 750). */
  throttleMs?: number;
  /** Status TTL in ms (default 20000). */
  ttlMs?: number;
}

/**
 * Subscribe to workflow lifecycle events and mirror an aggregate status line
 * into the host herdr pane. Idempotent per manager (safe across `session_start`
 * re-fires). No-op outside herdr.
 *
 * Does not need the `ExtensionAPI` — it talks to herdr over its own CLI/socket,
 * exactly like the conductor was designed to shell out to tmux.
 */
export function installHerdrReporter(manager: WorkflowManager, opts: HerdrReporterOptions = {}): void {
  if (opts.enabled === false) return; // disabled via the `herdrStatus: "off"` setting
  const pane = opts.paneId ?? herdrPaneTarget(opts.env);
  if (!pane) return; // not in herdr (or opted out) → no-op

  // Idempotency guard: the manager outlives session_start, which can fire more
  // than once (e.g. after /reload). Register listeners only once.
  const guard = manager as unknown as { __herdrReporterInstalled?: boolean };
  if (guard.__herdrReporterInstalled) return;
  guard.__herdrReporterInstalled = true;

  const run = opts.run ?? defaultRun;
  const appliesTo = opts.appliesToSource ?? APPLIES_TO_DEFAULT;
  const throttleMs = opts.throttleMs ?? THROTTLE_MS;
  const ttlMs = opts.ttlMs ?? TTL_MS;

  let lastStatus: string | null | undefined; // undefined = nothing pushed yet
  let seq = 0;
  const nextSeq = () => {
    seq = Math.max(seq + 1, Date.now());
    return String(seq);
  };

  const applies = appliesTo ? ["--applies-to-source", appliesTo] : [];

  const push = (status: string | null): void => {
    if (status === lastStatus) return; // dedupe identical frames (incl. null→null)
    lastStatus = status;
    const base = ["pane", "report-metadata", pane, "--source", SOURCE, ...applies, "--seq", nextSeq()];
    if (status == null) {
      run([...base, "--clear-custom-status"]);
    } else {
      run([...base, "--custom-status", status, "--ttl-ms", String(ttlMs)]);
    }
  };

  const compute = (): string | null => {
    const active: ActiveRunView[] = [];
    for (const r of manager.listRuns()) {
      if (!ACTIVE_RUN_STATUSES.has(r.status)) continue;
      // Prefer the live in-memory snapshot (fresher phase/agent state) over the
      // persisted summary, mirroring renderPanel().
      const live = manager.getRun(r.runId);
      const agents = (live?.snapshot.agents ?? r.agents ?? []) as ActiveRunView["agents"];
      active.push({
        workflowName: r.workflowName,
        status: r.status,
        currentPhase: live?.snapshot.currentPhase ?? undefined,
        agents,
        semanticStatus: r.semanticStatus,
      });
    }
    return summarizeActiveRuns(active);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        push(compute());
      } catch {
        // never let a render error escape into the workflow runtime
      }
    }, throttleMs);
    (timer as { unref?: () => void }).unref?.();
  };
  const flushNow = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      push(compute());
    } catch {
      // swallow
    }
  };

  for (const ev of REPORT_EVENTS) manager.on(ev, schedule);

  const notify = (title: string, sound: "done" | "request"): void => {
    run(["notification", "show", title, "--sound", sound]);
  };

  // Terminal/attention transitions: push immediately and raise a desktop toast.
  // Gated to background runs so a foreground run the user is actively watching
  // doesn't double-notify (it already gets the inline <task-notification>).
  manager.on("complete", ({ runId }: { runId: string }) => {
    flushNow();
    const r = manager.getRun(runId);
    if (r?.background) notify(`Workflow complete: ${r.snapshot?.name ?? "workflow"}`, "done");
  });
  manager.on("error", ({ runId }: { runId: string }) => {
    flushNow();
    const r = manager.getRun(runId);
    if (r?.background) notify(`Workflow failed: ${r.snapshot?.name ?? "workflow"}`, "request");
  });
  manager.on("paused", ({ runId, reason }: { runId: string; reason?: string }) => {
    flushNow();
    if (reason !== "usage_limit") return;
    const r = manager.getRun(runId);
    if (r?.background) notify(`Workflow paused (usage limit): ${r.snapshot?.name ?? "workflow"}`, "request");
  });
  manager.on("stopped", flushNow);
}
