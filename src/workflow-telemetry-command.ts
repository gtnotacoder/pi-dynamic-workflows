import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager } from "./workflow-manager.js";
import {
  buildWorkflowTelemetryReport,
  parseTelemetryWindow,
  renderWorkflowTelemetryReport,
} from "./workflow-telemetry-report.js";

export interface WorkflowTelemetryReportCommandOptions {
  cwd: string;
  manager: WorkflowManager;
}

const USAGE =
  "Usage: /workflow-telemetry-report [window=24h|since=<iso>] [until=<iso>] [runId=<id>] [sessionId=<id>] [json=true]";

export function registerWorkflowTelemetryReportCommand(
  pi: ExtensionAPI,
  opts: WorkflowTelemetryReportCommandOptions,
): void {
  try {
    if ((pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === "workflow-telemetry-report")) return;
  } catch {
    // If the host cannot list commands, still try to register.
  }

  pi.registerCommand("workflow-telemetry-report", {
    description: "Summarize workflow cache, cost, context, trace, and compaction telemetry",
    async handler(rawArgs: string, ctx: ExtensionCommandContext) {
      const args = parseReportArgs(rawArgs);
      if (args.help) {
        ctx.ui.notify(USAGE, "info");
        return;
      }
      const since = parseTelemetryWindow(stringArg(args.since) ?? stringArg(args.window) ?? "24h");
      const until = parseTelemetryWindow(stringArg(args.until));
      const report = buildWorkflowTelemetryReport({
        cwd: opts.cwd,
        runs: opts.manager.listAllRuns(),
        since,
        until,
        runId: stringArg(args.runId),
        sessionId: stringArg(args.sessionId),
      });
      await pi.sendMessage({
        customType: "workflow-telemetry-report",
        content: args.json ? JSON.stringify(report, null, 2) : renderWorkflowTelemetryReport(report),
        display: true,
      });
    },
  });
}

function stringArg(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseReportArgs(raw: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    if (token === "--help" || token === "help") {
      out.help = true;
      continue;
    }
    const normalized = token.startsWith("--") ? token.slice(2) : token;
    const eq = normalized.indexOf("=");
    if (eq > 0) {
      const key = normalized.slice(0, eq);
      const value = normalized.slice(eq + 1);
      out[key] = value;
    } else if (normalized === "json") {
      out.json = true;
    }
  }
  if (typeof out.json === "string") out.json = /^(1|true|yes)$/i.test(out.json);
  return out;
}
