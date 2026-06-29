import type { ConductorRunStatus } from "./conductor-types.js";
import { isConductorAttentionStatus, isConductorStatusName, isConductorTerminalStatus } from "./conductor-types.js";
import type { PersistedRunState } from "./run-persistence.js";

export const ISSUE_DELIVERY_STATUS_PATH = ".issue-delivery/status.json";
export const CONDUCTOR_STATE_ENV_PATHS = ["state.env", ".issue-delivery/state.env"] as const;

export interface ConductorStateEnvSource {
  path: string;
  env: Record<string, string | undefined>;
}

export interface ConductorReconciliationSignals {
  /** Back-compat/test shorthand; treated as a single state.env source. */
  stateEnv?: Record<string, string | undefined>;
  stateEnvs?: ConductorStateEnvSource[];
  issueDeliveryStatus?: unknown;
}

export interface ConductorReconciliationDecision {
  status: PersistedRunState["status"];
  semanticStatus: ConductorRunStatus;
}

/**
 * Parse a simple KEY=value state.env file. Quoted values are unwrapped, comments
 * and blank lines are ignored, and malformed lines are skipped.
 */
export function parseConductorStateEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquoteEnvValue(line.slice(equals + 1).trim());
  }
  return values;
}

/**
 * Reconcile a persisted run that was still marked running after its owning
 * process/pane disappeared. Engine state becomes paused so resume remains
 * possible, while semanticStatus gives conductor-specific recovery guidance.
 */
export function reconcileStaleWorkflowRun(
  run: PersistedRunState,
  signals: ConductorReconciliationSignals = {},
): ConductorReconciliationDecision | null {
  if (run.status !== "running") return null;
  const preserved = preserveActionableSemanticStatus(run.semanticStatus);
  if (preserved) return { status: "paused", semanticStatus: preserved };

  const issueRun = isIssueDeliveryRun(run);
  const issueStatus =
    issueRun && sidecarMatchesRun(run, signals.issueDeliveryStatus)
      ? summarizeIssueDeliveryStatus(signals.issueDeliveryStatus)
      : undefined;
  if (issueStatus?.kind === "finalization") {
    const semanticStatus =
      issueStatus.semanticStatus.status === "finalizing"
        ? needsFinalizeStatus(run, ".issue-delivery/status.json")
        : issueStatus.semanticStatus;
    return { status: "paused", semanticStatus };
  }
  const envStatus = firstMappedStateEnvStatus(run, stateEnvSources(signals));
  if (envStatus) return { status: "paused", semanticStatus: envStatus };

  if (issueStatus?.kind === "prototype-complete") {
    return { status: "paused", semanticStatus: prototypeCompleteStatus(run, ".issue-delivery/status.json") };
  }

  if (issueRun && (looksPastLocalChecks(run) || issueStatus?.kind === "steps-complete")) {
    return { status: "paused", semanticStatus: needsFinalizeStatus(run, "workflow run-state") };
  }

  if (issueStatus?.kind === "checks-failed") {
    return {
      status: "paused",
      semanticStatus: {
        status: "needs-human",
        reason: "Recovered stale Issue Delivery run with failed local checks.",
        nextAction: staleNextAction(run.runId, "inspect the pane/status files, fix checks, then resume or finish"),
        details: "Source: .issue-delivery/status.json",
      },
    };
  }
  if (issueStatus?.kind === "finalized") {
    return {
      status: "paused",
      semanticStatus: needsFinalizeStatus(run, ".issue-delivery/status.json"),
    };
  }

  if (run.semanticStatus?.status === "workflow-complete-pane-open") {
    return { status: "paused", semanticStatus: run.semanticStatus };
  }

  return {
    status: "paused",
    semanticStatus: {
      status: "needs-human",
      reason: "Recovered stale running workflow state with no live owner process.",
      nextAction: staleNextAction(run.runId, "resume the workflow or inspect the pane/worktree"),
      details: "Engine status was reconciled from running to paused to avoid a misleading stale run.",
    },
  };
}

function preserveActionableSemanticStatus(status: ConductorRunStatus | undefined): ConductorRunStatus | undefined {
  if (!status) return undefined;
  if (isConductorAttentionStatus(status.status) || isConductorTerminalStatus(status.status)) return status;
  return undefined;
}

function mapExternalStatus(run: PersistedRunState, rawStatus: string, source: string): ConductorRunStatus | undefined {
  const normalized = rawStatus.trim().toLowerCase();
  if (["completed", "complete", "done", "success", "succeeded"].includes(normalized)) {
    return completedStatus(run, source, rawStatus);
  }
  if (["failed", "failure", "error"].includes(normalized)) {
    return failedStatus(run, source, rawStatus);
  }
  if (["needs-human", "needs_human", "blocked"].includes(normalized)) {
    return needsHumanStatus(run, source, rawStatus);
  }
  if (["finalizing", "needs-finalize", "needs_finalize", "finalize"].includes(normalized)) {
    return needsFinalizeStatus(run, source);
  }
  return undefined;
}

function completedStatus(run: PersistedRunState, source: string, rawStatus: string): ConductorRunStatus {
  return {
    status: "completed",
    reason: `Recovered stale workflow after ${source} reported ${rawStatus}.`,
    nextAction: staleNextAction(run.runId, "no recovery action is required"),
    details: `Source: ${source}`,
  };
}

function failedStatus(run: PersistedRunState, source: string, rawStatus: string): ConductorRunStatus {
  return {
    status: "failed",
    reason: `Recovered stale workflow after ${source} reported ${rawStatus}.`,
    nextAction: staleNextAction(run.runId, "inspect the pane/status files before retrying"),
    details: `Source: ${source}`,
  };
}

function needsHumanStatus(run: PersistedRunState, source: string, rawStatus: string): ConductorRunStatus {
  return {
    status: "needs-human",
    reason: `Recovered stale workflow after ${source} reported ${rawStatus}.`,
    nextAction: staleNextAction(run.runId, "inspect the pane/status files and decide whether to resume or repair"),
    details: `Source: ${source}`,
  };
}

function needsFinalizeStatus(run: PersistedRunState, source: string): ConductorRunStatus {
  return {
    status: "needs-finalize",
    reason: "Recovered stale Issue Delivery run after it progressed beyond local checks.",
    nextAction: staleNextAction(run.runId, "run the finalization gate or resume to complete PR delivery"),
    details: `Source: ${source}`,
  };
}

function prototypeCompleteStatus(run: PersistedRunState, source: string): ConductorRunStatus {
  return {
    status: "workflow-complete-pane-open",
    reason: "Recovered stale Issue Delivery prototype run after bounded prototype work completed.",
    nextAction: staleNextAction(
      run.runId,
      "inspect the prototype report/worktree; do not run PR finalization for this prototype run",
    ),
    details: `Source: ${source}`,
  };
}

function staleNextAction(runId: string, action: string): string {
  return `Run /workflows status ${runId}, then ${action}.`;
}

function stateEnvSources(signals: ConductorReconciliationSignals): ConductorStateEnvSource[] {
  const sources = signals.stateEnvs?.slice() ?? [];
  if (signals.stateEnv) sources.push({ path: "state.env", env: signals.stateEnv });
  return sources;
}

function firstMappedStateEnvStatus(
  run: PersistedRunState,
  sources: ConductorStateEnvSource[],
): ConductorRunStatus | undefined {
  const groups = [
    ["FINALIZATION_STATUS"],
    ["CONDUCTOR_STATUS", "WORKFLOW_SEMANTIC_STATUS"],
    ["WORKFLOW_STATUS"],
  ] as const;
  for (const keys of groups) {
    for (const source of sources) {
      if (!stateEnvMatchesRun(run, source.env)) continue;
      for (const key of keys) {
        const status = source.env[key];
        const mapped = status ? mapExternalStatus(run, status, source.path) : undefined;
        if (mapped) return mapped;
      }
    }
  }
  return undefined;
}

function isIssueDeliveryRun(run: PersistedRunState): boolean {
  const name = run.workflowName.toLowerCase();
  return name.includes("issue_delivery") || name.includes("closed_loop_issue_delivery") || name.includes("fugu");
}

function looksPastLocalChecks(run: PersistedRunState): boolean {
  const logs = (run.logs ?? []).join("\n").toLowerCase();
  if (["pull request creation complete", "running finalization gate"].some((needle) => logs.includes(needle))) {
    return true;
  }
  if (run.journal?.some((entry) => entry.label === "issue-pr-delivery" && entry.result !== null)) return true;
  return run.agents?.some((agent) => agent.label === "issue-pr-delivery" && agent.status === "done") ?? false;
}

type IssueDeliveryStatusSummary =
  | { kind: "checks-failed" }
  | { kind: "checks-passed" }
  | { kind: "steps-complete" }
  | { kind: "prototype-complete" }
  | { kind: "finalized" }
  | { kind: "finalization"; semanticStatus: ConductorRunStatus }
  | undefined;

function sidecarMatchesRun(run: PersistedRunState, value: unknown): boolean {
  const id = sidecarRunId(value);
  return id !== undefined && id === run.runId;
}

function stateEnvMatchesRun(run: PersistedRunState, env: Record<string, string | undefined>): boolean {
  return sidecarRunId(env) === run.runId;
}

function sidecarRunId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return firstNonEmptyString(
    record.runId,
    record.workflowRunId,
    record.WORKFLOW_RUN_ID,
    record.CONDUCTOR_RUN_ID,
    record.PI_WORKFLOW_RUN_ID,
    record.RUN_ID,
  );
}

function summarizeIssueDeliveryStatus(value: unknown): IssueDeliveryStatusSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const finalization = record.finalization;
  if (finalization && typeof finalization === "object" && !Array.isArray(finalization)) {
    const semanticStatus = semanticStatusFromFinalization(finalization as Record<string, unknown>);
    return semanticStatus ? { kind: "finalization", semanticStatus } : { kind: "finalized" };
  }

  if (sidecarShowsPrototypeComplete(record)) return { kind: "prototype-complete" };
  if (sidecarShowsAllStepsComplete(record)) return { kind: "steps-complete" };

  const localChecks = record.localChecks;
  if (localChecks && typeof localChecks === "object" && !Array.isArray(localChecks)) {
    const ok = (localChecks as Record<string, unknown>).ok;
    if (ok === false) return { kind: "checks-failed" };
    if (ok === true) return { kind: "checks-passed" };
  }

  return undefined;
}

function sidecarShowsPrototypeComplete(record: Record<string, unknown>): boolean {
  return record.prototype === true && sidecarShowsAllStepsComplete(record);
}

function sidecarShowsAllStepsComplete(record: Record<string, unknown>): boolean {
  if (record.allStepsComplete === true) return true;
  const completedSteps = record.completedSteps;
  const plannedStepCount = Number(record.plannedStepCount ?? record.selectedStepCount ?? record.totalSteps);
  return (
    Array.isArray(completedSteps) &&
    Number.isFinite(plannedStepCount) &&
    plannedStepCount > 0 &&
    completedSteps.length >= plannedStepCount
  );
}

function semanticStatusFromFinalization(record: Record<string, unknown>): ConductorRunStatus | undefined {
  const toRunStatus = record.toRunStatus;
  if (toRunStatus && typeof toRunStatus === "object" && !Array.isArray(toRunStatus)) {
    return semanticStatusFromRecord(toRunStatus as Record<string, unknown>);
  }
  return semanticStatusFromRecord(record);
}

function semanticStatusFromRecord(record: Record<string, unknown>): ConductorRunStatus | undefined {
  const status = record.status;
  if (!isConductorStatusName(status)) return undefined;
  const reason =
    typeof record.reason === "string" && record.reason.trim() ? record.reason : `Recovered ${status} status.`;
  const nextAction = typeof record.nextAction === "string" && record.nextAction.trim() ? record.nextAction : undefined;
  const details = typeof record.details === "string" && record.details.trim() ? record.details : undefined;
  return { status, reason, nextAction, details };
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
