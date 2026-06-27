/**
 * Conductor taxonomy — shared, dependency-free types and helpers.
 *
 * This module defines the canonical status names a conductor run can be in,
 * the shape of a run status record, plus small pure helpers (guards, icon
 * and label lookups) used by the TUI renderers. It deliberately imports
 * nothing so it can be pulled into both the conductor core and the display
 * layer without creating a dependency cycle.
 */

/**
 * The lifecycle states a conductor run can occupy.
 *
 * - `spawned`                    — tmux pane created, workflow not yet started.
 * - `workflow-running`           — workflow is actively executing.
 * - `workflow-complete-pane-open`— workflow finished, pane still open awaiting finalize.
 * - `needs-finalize`             — waiting on the user (or a watcher) to finalize.
 * - `finalizing`                 — finalize step is in progress.
 * - `completed`                  — run finished successfully, torn down.
 * - `failed`                     — run failed.
 * - `needs-human`                — blocked and requires human intervention.
 */
export type ConductorStatusName =
  | "spawned"
  | "workflow-running"
  | "workflow-complete-pane-open"
  | "needs-finalize"
  | "finalizing"
  | "completed"
  | "failed"
  | "needs-human";

/**
 * A conductor run's status record, persisted alongside the run and surfaced
 * to renderers.
 */
export interface ConductorRunStatus {
  /** Canonical status name. */
  status: ConductorStatusName;
  /** Short human-readable reason for the current status. */
  reason: string;
  /** Optional suggested next action for the user. */
  nextAction?: string;
  /** Optional free-form extra details. */
  details?: string;
}

/**
 * Statuses where the conductor is actively doing work or waiting on an
 * automatic step. These are not terminal and not awaiting human attention.
 */
export const CONDUCTOR_ACTIVE_STATUSES: ReadonlySet<ConductorStatusName> = new Set<ConductorStatusName>([
  "spawned",
  "workflow-running",
  "workflow-complete-pane-open",
  "finalizing",
]);

/**
 * Statuses that require human attention (user must act to make progress).
 */
export const CONDUCTOR_ATTENTION_STATUSES: ReadonlySet<ConductorStatusName> = new Set<ConductorStatusName>([
  "needs-finalize",
  "needs-human",
]);

/**
 * Statuses that represent a finished run (no further work expected).
 */
export const CONDUCTOR_TERMINAL_STATUSES: ReadonlySet<ConductorStatusName> = new Set<ConductorStatusName>([
  "completed",
  "failed",
]);

/** All valid status names, in lifecycle order. */
export const CONDUCTOR_STATUS_NAMES: readonly ConductorStatusName[] = [
  "spawned",
  "workflow-running",
  "workflow-complete-pane-open",
  "needs-finalize",
  "finalizing",
  "completed",
  "failed",
  "needs-human",
];

/** Icon (single glyph / short string) per status name. */
export const CONDUCTOR_STATUS_ICONS: Readonly<Record<ConductorStatusName, string>> = {
  spawned: "•",
  "workflow-running": "▶",
  "workflow-complete-pane-open": "◐",
  "needs-finalize": "!",
  finalizing: "⟳",
  completed: "✓",
  failed: "✗",
  "needs-human": "?",
};

/** Short human-readable label per status name. */
export const CONDUCTOR_STATUS_LABELS: Readonly<Record<ConductorStatusName, string>> = {
  spawned: "Spawned",
  "workflow-running": "Running",
  "workflow-complete-pane-open": "Complete (pane open)",
  "needs-finalize": "Needs finalize",
  finalizing: "Finalizing",
  completed: "Completed",
  failed: "Failed",
  "needs-human": "Needs human",
};

/**
 * Type guard: true when `value` is a valid {@link ConductorStatusName}.
 */
export function isConductorStatusName(value: unknown): value is ConductorStatusName {
  return typeof value === "string" && (CONDUCTOR_STATUS_NAMES as readonly string[]).includes(value);
}

/**
 * True when `status` is an active (in-progress, non-blocking) status.
 */
export function isConductorActiveStatus(status: ConductorStatusName): boolean {
  return CONDUCTOR_ACTIVE_STATUSES.has(status);
}

/**
 * True when `status` requires human attention.
 */
export function isConductorAttentionStatus(status: ConductorStatusName): boolean {
  return CONDUCTOR_ATTENTION_STATUSES.has(status);
}

/**
 * True when `status` is terminal (the run will not make further progress).
 */
export function isConductorTerminalStatus(status: ConductorStatusName): boolean {
  return CONDUCTOR_TERMINAL_STATUSES.has(status);
}

/**
 * Return the icon for a status, or a fallback for an unknown status.
 */
export function conductorStatusIcon(status: ConductorStatusName): string {
  return CONDUCTOR_STATUS_ICONS[status] ?? "•";
}

/**
 * Return the human-readable label for a status, or a fallback for an unknown
 * status.
 */
export function conductorStatusLabel(status: ConductorStatusName): string {
  return CONDUCTOR_STATUS_LABELS[status] ?? String(status);
}
