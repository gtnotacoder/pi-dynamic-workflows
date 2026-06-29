import type { AgentUsage } from "./agent.js";
import {
  type CompactionEventSummary,
  type CompactionTelemetryEvent,
  readCompactionEvents,
  summarizeCompactionEvents,
} from "./compaction-telemetry.js";
import { workflowLangfuseTraceId } from "./langfuse-tracing.js";
import { createRunPersistence, type PersistedAgentState, type PersistedRunState } from "./run-persistence.js";
import type { JournalEntry } from "./workflow.js";

export { workflowLangfuseTraceId } from "./langfuse-tracing.js";

export interface WorkflowTelemetryReportOptions {
  cwd?: string;
  runs?: PersistedRunState[];
  compactionEvents?: CompactionTelemetryEvent[];
  since?: Date;
  until?: Date;
  runId?: string;
  sessionId?: string;
  compactionEventsPath?: string;
  lowCacheInputThreshold?: number;
}

export interface UsageRollup {
  calls: number;
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  cacheReadPct: number;
}

export interface UsageAnomaly {
  kind: "large_low_cache" | "missing_usage" | "context_overrun";
  runId?: string;
  workflowName?: string;
  agentLabel?: string;
  model?: string;
  message: string;
  input?: number;
  cacheRead?: number;
  cacheReadPct?: number;
  occupancy?: number;
  traceId?: string;
  runStatePath?: string;
}

export interface WorkflowTelemetryReport {
  generatedAt: string;
  window: { since?: string; until?: string };
  filters: { runId?: string; sessionId?: string };
  totals: UsageRollup & { runs: number; agents: number };
  byModel: Record<string, UsageRollup>;
  byAgentLabel: Record<string, UsageRollup>;
  anomalies: UsageAnomaly[];
  compaction: CompactionEventSummary;
  traceLinks: Array<{ runId: string; workflowName: string; traceId: string; runStatePath?: string }>;
}

const DEFAULT_LOW_CACHE_INPUT_THRESHOLD = 50_000;
const REPORT_COMPACTION_MAX_BYTES = 64 * 1024 * 1024;

export function parseTelemetryWindow(value: string | undefined, now = new Date()): Date | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();
  const relative = text.match(/^(\d+)(m|h|d)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms = unit === "m" ? amount * 60_000 : unit === "h" ? amount * 3_600_000 : amount * 86_400_000;
    return new Date(now.getTime() - ms);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

export function buildWorkflowTelemetryReport(options: WorkflowTelemetryReportOptions = {}): WorkflowTelemetryReport {
  const cwd = options.cwd ?? process.cwd();
  const since = options.since;
  const until = options.until;
  const lowCacheInputThreshold = options.lowCacheInputThreshold ?? DEFAULT_LOW_CACHE_INPUT_THRESHOLD;
  const runs = (options.runs ?? createRunPersistence(cwd).list()).filter((run) => matchesRun(run, options));
  const rawCompactionEvents = options.compactionEvents
    ? filterSuppliedCompactionEvents(options.compactionEvents, options)
    : readCompactionEvents({
        filePath: options.compactionEventsPath,
        since,
        until,
        sessionId: options.sessionId,
        workflowRunId: options.runId,
        limit: Number.MAX_SAFE_INTEGER,
        maxBytes: REPORT_COMPACTION_MAX_BYTES,
      });
  const compactionEvents = tailEvents(filterCompactionEvents(rawCompactionEvents, runs), 1_000);
  const totals = emptyRollup() as UsageRollup & { runs: number; agents: number };
  totals.runs = runs.length;
  totals.agents = runs.reduce((sum, run) => sum + run.agents.length, 0);

  const byModel = createRollupMap();
  const byAgentLabel = createRollupMap();
  const anomalies: UsageAnomaly[] = [];
  const traceLinks: WorkflowTelemetryReport["traceLinks"] = [];

  for (const run of runs) {
    traceLinks.push({
      runId: run.runId,
      workflowName: run.workflowName,
      traceId: workflowLangfuseTraceId(run.runId),
      runStatePath: runStatePathFromRun(run),
    });

    const agentJournals = [...(run.journal ?? [])].filter(isAgentJournalEntry).sort((a, b) => a.index - b.index);
    const unusedAgentJournals = [...agentJournals];
    const perRunUsage = emptyRollup();
    for (let index = 0; index < run.agents.length; index++) {
      const agent = run.agents[index];
      const journal = takeJournalForAgent(unusedAgentJournals, agent, run.agents.slice(index + 1));
      const usage = journal?.usage;
      const model = agent.model ?? journal?.model ?? "unknown";
      const label = agent.label || "unknown";
      const rollupUsage = effectiveAgentUsage(usage, agent);
      if (!usage && !agent.tokens && shouldReportMissingUsage(agent)) {
        anomalies.push({
          kind: "missing_usage",
          runId: run.runId,
          workflowName: run.workflowName,
          agentLabel: label,
          model,
          message: `No usage/tokens recorded for ${label}`,
          traceId: workflowLangfuseTraceId(run.runId),
          runStatePath: runStatePathFromRun(run),
        });
      }
      if (!rollupUsage) continue;

      addUsage(totals, rollupUsage);
      addUsage(perRunUsage, rollupUsage);
      if (!byModel[model]) byModel[model] = emptyRollup();
      addUsage(byModel[model], rollupUsage);
      if (!byAgentLabel[label]) byAgentLabel[label] = emptyRollup();
      addUsage(byAgentLabel[label], rollupUsage);

      maybePushLowCacheAnomaly(anomalies, run, label, model, rollupUsage, lowCacheInputThreshold);
    }
    reconcileRunAggregateUsage(run, perRunUsage, totals, byModel, anomalies, lowCacheInputThreshold);
  }

  finalizeRollup(totals);
  for (const rollup of Object.values(byModel)) finalizeRollup(rollup);
  for (const rollup of Object.values(byAgentLabel)) finalizeRollup(rollup);

  for (const event of compactionEvents) {
    const occupancy = event.occupancy;
    if (occupancy !== undefined && occupancy >= 1) {
      anomalies.push({
        kind: "context_overrun",
        message: `Compaction telemetry reported ${(occupancy * 100).toFixed(1)}% context occupancy`,
        occupancy,
        runId: event.workflowRunId,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    window: { since: since?.toISOString(), until: until?.toISOString() },
    filters: { runId: options.runId, sessionId: options.sessionId },
    totals,
    byModel: sortRollups(byModel),
    byAgentLabel: sortRollups(byAgentLabel),
    anomalies,
    compaction: summarizeCompactionEvents(compactionEvents),
    traceLinks,
  };
}

export function renderWorkflowTelemetryReport(report: WorkflowTelemetryReport): string {
  const lines = ["# Workflow telemetry self-optimization report", ""];
  lines.push(`Generated: ${report.generatedAt}`);
  if (report.window.since || report.window.until) {
    lines.push(`Window: ${report.window.since ?? "beginning"} → ${report.window.until ?? "now"}`);
  }
  if (report.filters.runId || report.filters.sessionId) {
    lines.push(`Filters: runId=${report.filters.runId ?? "*"}, sessionId=${report.filters.sessionId ?? "*"}`);
  }
  lines.push("");
  lines.push("## Totals");
  lines.push(
    `Runs: ${report.totals.runs}, agents: ${report.totals.agents}, tokens: ${formatNumber(
      report.totals.total,
    )}, input: ${formatNumber(report.totals.input)}, output: ${formatNumber(report.totals.output)}, cache read: ${formatNumber(
      report.totals.cacheRead,
    )} (${formatPct(report.totals.cacheReadPct)}), cost: $${report.totals.cost.toFixed(4)}`,
  );
  lines.push("");
  lines.push("## By model");
  pushRollupTable(lines, report.byModel, "No model usage in the selected local data.");
  lines.push("");
  lines.push("## By agent label");
  pushRollupTable(lines, report.byAgentLabel, "No agent-label usage in the selected local data.");
  lines.push("");
  lines.push("## High-signal anomalies");
  if (!report.anomalies.length) lines.push("No anomalies detected in the selected local data.");
  else {
    for (const anomaly of report.anomalies.slice(0, 20)) {
      const loc = [anomaly.workflowName, anomaly.agentLabel].filter(Boolean).join(" / ");
      lines.push(`- ${anomaly.kind}: ${loc ? `${loc}: ` : ""}${anomaly.message}`);
    }
  }
  lines.push("");
  lines.push("## Compaction decisions");
  const compactionTypes = Object.entries(report.compaction.byType)
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
  lines.push(
    `Events: ${report.compaction.total}${compactionTypes ? ` (${compactionTypes})` : ""}; recommended: ${report.compaction.recommended}; cache-hot: ${report.compaction.cacheHot}; suppressed-by-cache-hot: ${report.compaction.suppressedByCacheHot}; over-window: ${report.compaction.overEffectiveWindow}`,
  );
  if (report.compaction.maxOccupancy !== undefined)
    lines.push(`Max occupancy: ${formatPct(report.compaction.maxOccupancy)}`);
  if (report.compaction.maxEstReclaim !== undefined) {
    lines.push(`Max estimated reclaim: ${formatNumber(report.compaction.maxEstReclaim)} tokens`);
  }
  lines.push("");
  lines.push("## Trace/run references");
  if (!report.traceLinks.length) lines.push("No workflow runs in the selected window.");
  else {
    for (const link of report.traceLinks.slice(0, 20)) {
      lines.push(
        `- ${link.workflowName} ${link.runId}: trace=${link.traceId}${link.runStatePath ? ` state=${link.runStatePath}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function matchesRun(run: PersistedRunState, options: WorkflowTelemetryReportOptions): boolean {
  if (options.runId && run.runId !== options.runId) return false;
  if (options.sessionId && run.sessionId !== options.sessionId) return false;
  const updated = Date.parse(run.updatedAt || run.startedAt);
  if (options.since && Number.isFinite(updated) && updated < options.since.getTime()) return false;
  if (options.until && Number.isFinite(updated) && updated > options.until.getTime()) return false;
  return true;
}

function emptyRollup(): UsageRollup {
  return { calls: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheReadPct: 0 };
}

function createRollupMap(): Record<string, UsageRollup> {
  return Object.create(null) as Record<string, UsageRollup>;
}

function tailEvents(events: CompactionTelemetryEvent[], limit: number): CompactionTelemetryEvent[] {
  return events.slice(Math.max(0, events.length - limit));
}

function filterSuppliedCompactionEvents(
  events: CompactionTelemetryEvent[],
  options: WorkflowTelemetryReportOptions,
): CompactionTelemetryEvent[] {
  return events.filter((event) => matchesCompactionReportFilter(event, options));
}

function matchesCompactionReportFilter(
  event: CompactionTelemetryEvent,
  options: WorkflowTelemetryReportOptions,
): boolean {
  if (options.sessionId && event.sessionId !== options.sessionId) return false;
  const ts = event.timestamp ? Date.parse(event.timestamp) : undefined;
  if (options.since && ts !== undefined && ts < options.since.getTime()) return false;
  if (options.until && ts !== undefined && ts > options.until.getTime()) return false;
  return true;
}

function filterCompactionEvents(
  events: CompactionTelemetryEvent[],
  runs: PersistedRunState[],
): CompactionTelemetryEvent[] {
  const selectedRunIds = new Set(runs.map((run) => run.runId));
  if (selectedRunIds.size === 0) return [];
  return events.filter((event) => event.workflowRunId !== undefined && selectedRunIds.has(event.workflowRunId));
}

function isAgentJournalEntry(entry: JournalEntry): boolean {
  // checkpoint() uses the same call sequence/journal array as agent(), but it
  // has no label/model/token/usage metadata and no matching persisted agent row.
  // Filter it out before matching so agent A -> checkpoint -> agent B attributes
  // B's usage to B, not to the checkpoint entry.
  return Boolean(entry.label || entry.model || entry.usage || entry.tokens !== undefined);
}

function takeJournalForAgent(
  journals: JournalEntry[],
  agent: PersistedAgentState,
  laterAgents: PersistedAgentState[],
): JournalEntry | undefined {
  if (agent.status !== "done") return undefined;
  const labelIndex = journals.findIndex((journal) => journal.label === agent.label);
  if (labelIndex >= 0) {
    const [journal] = journals.splice(labelIndex, 1);
    return journal;
  }
  const legacyIndex = journals.findIndex((journal) => !journal.label);
  if (legacyIndex >= 0) {
    const [journal] = journals.splice(legacyIndex, 1);
    return journal;
  }
  const laterDoneLabels = new Set(
    laterAgents.flatMap((candidate) => (candidate.status === "done" ? [candidate.label] : [])),
  );
  const orphanLabelIndex = journals.findIndex((journal) => journal.label && !laterDoneLabels.has(journal.label));
  if (orphanLabelIndex < 0) return undefined;
  const [journal] = journals.splice(orphanLabelIndex, 1);
  return journal;
}

function shouldReportMissingUsage(agent: PersistedAgentState): boolean {
  return agent.status === "done" || agent.status === "error";
}

function effectiveAgentUsage(usage: AgentUsage | undefined, agent: PersistedAgentState): AgentUsage | undefined {
  if (usage && usage.total > 0) return usage;
  const fallback = usageFromAgentFallback(agent);
  if (!fallback) return usage;
  if (!usage) return fallback;
  return { ...usage, total: fallback.total };
}

function usageFromAgentFallback(agent: PersistedAgentState): AgentUsage | undefined {
  if (!agent.tokens) return undefined;
  return { input: 0, output: 0, total: agent.tokens, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(target: UsageRollup, usage: AgentUsage): void {
  target.calls++;
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.total += usage.total ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.cost += usage.cost ?? 0;
}

function reconcileRunAggregateUsage(
  run: PersistedRunState,
  perRunUsage: UsageRollup,
  totals: UsageRollup,
  byModel: Record<string, UsageRollup>,
  anomalies: UsageAnomaly[],
  lowCacheInputThreshold: number,
): void {
  const aggregate = usageFromRunAggregate(run);
  if (!aggregate) return;
  const delta: AgentUsage = {
    input: Math.max(0, aggregate.input - perRunUsage.input),
    output: Math.max(0, aggregate.output - perRunUsage.output),
    total: Math.max(0, aggregate.total - perRunUsage.total),
    cacheRead: Math.max(0, aggregate.cacheRead - perRunUsage.cacheRead),
    cacheWrite: Math.max(0, aggregate.cacheWrite - perRunUsage.cacheWrite),
    cost: Math.max(0, aggregate.cost - perRunUsage.cost),
  };
  if (!hasUsage(delta)) return;
  addUsage(totals, delta);
  const model = "unattributed run aggregate";
  if (!byModel[model]) byModel[model] = emptyRollup();
  addUsage(byModel[model], delta);
  maybePushLowCacheAnomaly(anomalies, run, model, model, delta, lowCacheInputThreshold);
}

function usageFromRunAggregate(run: PersistedRunState): AgentUsage | undefined {
  const usage = run.tokenUsage;
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost ?? 0,
  };
}

function hasUsage(usage: AgentUsage): boolean {
  return (
    usage.input > 0 ||
    usage.output > 0 ||
    usage.total > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.cost > 0
  );
}

function finalizeRollup(rollup: UsageRollup): void {
  rollup.cacheReadPct = rollup.input > 0 ? rollup.cacheRead / rollup.input : 0;
}

function usageCacheReadPct(usage: AgentUsage): number {
  const input = usage.input ?? 0;
  return input > 0 ? (usage.cacheRead ?? 0) / input : 0;
}

function maybePushLowCacheAnomaly(
  anomalies: UsageAnomaly[],
  run: PersistedRunState,
  label: string,
  model: string,
  usage: AgentUsage,
  lowCacheInputThreshold: number,
): void {
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheReadPct = usageCacheReadPct(usage);
  if (input < lowCacheInputThreshold || cacheReadPct >= 0.05) return;
  anomalies.push({
    kind: "large_low_cache",
    runId: run.runId,
    workflowName: run.workflowName,
    agentLabel: label,
    model,
    message: `${label} used ${input.toLocaleString()} input tokens with ${(cacheReadPct * 100).toFixed(1)}% cache read`,
    input,
    cacheRead,
    cacheReadPct,
    traceId: workflowLangfuseTraceId(run.runId),
    runStatePath: runStatePathFromRun(run),
  });
}

function sortRollups(input: Record<string, UsageRollup>): Record<string, UsageRollup> {
  const sorted = createRollupMap();
  for (const [name, rollup] of Object.entries(input).sort(
    (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
  )) {
    sorted[name] = rollup;
  }
  return sorted;
}

function pushRollupTable(lines: string[], rollups: Record<string, UsageRollup>, emptyMessage: string): void {
  const entries = Object.entries(rollups).slice(0, 12);
  if (!entries.length) {
    lines.push(emptyMessage);
    return;
  }
  for (const [name, rollup] of entries) {
    lines.push(
      `- ${name}: ${rollup.calls} calls, ${formatNumber(rollup.total)} tok, input ${formatNumber(
        rollup.input,
      )}, cache read ${formatNumber(rollup.cacheRead)} (${formatPct(rollup.cacheReadPct)}), cost $${rollup.cost.toFixed(
        4,
      )}`,
    );
  }
}

function runStatePathFromRun(run: PersistedRunState): string | undefined {
  return run.runStatePath;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
