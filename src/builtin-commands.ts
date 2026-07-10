/**
 * Bundled workflow commands: `/deep-research`, `/adversarial-review`, `/code-review`, `/issue-delivery`, and `/fugu`.
 * They run a generated workflow script and print the final report.
 */

import {
  createCodingTools,
  createReadOnlyTools,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow, parseAdversarialReviewArgs } from "./adversarial-review.js";
import { generateCodeReviewWorkflow, prepareCodeReviewArgs } from "./code-review.js";
import {
  defaultResearchReportWriter,
  deliverDeepResearchResult,
  generateDeepResearchWorkflow,
  MAX_RESEARCH_QUESTION_CHARS,
} from "./deep-research.js";
import { extractHarnessConfigFlag, extractHarnessTypeFlag } from "./harness-config.js";
import { generateIssueDeliveryWorkflow } from "./issue-delivery.js";
import { buildRegistryForCwd, extractModeFlag } from "./modes-command.js";
import { createWebFetchTool, createWebSearchTool, createWebTools } from "./web-tools.js";
import { runWorkflow, type WorkflowRunOptions, type WorkflowRunResult } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";

function alreadyRegistered(pi: ExtensionAPI, name: string): boolean {
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

function adversarialReviewTools(cwd: string, evidenceComponents: string[]): WorkflowRunOptions["tools"] {
  const tools = [...createReadOnlyTools(cwd)] as unknown as NonNullable<WorkflowRunOptions["tools"]>;
  if (evidenceComponents.includes("web_search")) tools.push(createWebSearchTool());
  if (
    evidenceComponents.includes("web_fetch") ||
    evidenceComponents.includes("github") ||
    evidenceComponents.includes("web_search")
  ) {
    tools.push(createWebFetchTool());
  }
  return tools;
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (value === undefined || value === "") return true;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function extractPrototypeFlag(raw: string): { prototype: boolean; rest: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const keep: string[] = [];
  let prototype = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--prototype") {
      prototype = true;
      continue;
    }
    if (token === "--no-prototype") {
      prototype = false;
      continue;
    }
    if (token.startsWith("--prototype=")) {
      prototype = parseBooleanFlag(token.slice("--prototype=".length));
      continue;
    }
    if (token.startsWith("prototype=")) {
      prototype = parseBooleanFlag(token.slice("prototype=".length));
      continue;
    }
    keep.push(token);
  }
  return { prototype, rest: keep.join(" ") };
}

function toCamelFlagName(name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

const ISSUE_DELIVERY_BOOLEAN_FLAGS = new Set([
  "prototype",
  "dryRun",
  "finish",
  "finishOnly",
  "resumeFinish",
  "worktreeRequired",
  "allowSharedCheckout",
  "allowDirty",
]);
const ISSUE_DELIVERY_NUMBER_FLAGS = new Set(["maxSteps", "maxRepairRounds", "maxReviewRounds"]);

function isBooleanLiteral(value: string | undefined): boolean {
  return value !== undefined && ["1", "0", "true", "false", "yes", "no", "on", "off"].includes(value.toLowerCase());
}

function coerceIssueDeliveryFlag(name: string, value: string | boolean): unknown {
  const normalized = toCamelFlagName(name);
  if (ISSUE_DELIVERY_BOOLEAN_FLAGS.has(normalized)) {
    return typeof value === "boolean" ? value : parseBooleanFlag(value);
  }
  if (ISSUE_DELIVERY_NUMBER_FLAGS.has(normalized)) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return value;
}

function buildIssueDeliveryArgs(rest: string): Record<string, unknown> & { task: string } {
  const parsed = extractPrototypeFlag(rest);
  const tokens = parsed.rest.trim().split(/\s+/).filter(Boolean);
  const keep: string[] = [];
  const options: Record<string, unknown> = parsed.prototype ? { prototype: true } : {};
  const valueFlags = new Set([
    "issue",
    "plan-path",
    "planPath",
    "repo",
    "base-branch",
    "baseBranch",
    "base-ref",
    "baseRef",
    "max-steps",
    "maxSteps",
    "max-repair-rounds",
    "maxRepairRounds",
    "max-review-rounds",
    "maxReviewRounds",
    "dry-run",
    "dryRun",
    "finish",
    "finish-only",
    "finishOnly",
    "resume-finish",
    "resumeFinish",
    "worktree-required",
    "worktreeRequired",
    "allow-shared-checkout",
    "allowSharedCheckout",
    "allow-dirty",
    "allowDirty",
  ]);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const bare = token.replace(/^--/, "");
    const equals = bare.indexOf("=");
    if (equals > 0) {
      const name = bare.slice(0, equals);
      if (valueFlags.has(name)) {
        options[toCamelFlagName(name)] = coerceIssueDeliveryFlag(name, bare.slice(equals + 1));
        continue;
      }
    }
    if (token.startsWith("--no-")) {
      const name = token.slice("--no-".length);
      if (valueFlags.has(name)) {
        options[toCamelFlagName(name)] = false;
        continue;
      }
    }
    if (token.startsWith("--") && valueFlags.has(bare)) {
      const normalized = toCamelFlagName(bare);
      const next = tokens[i + 1];
      let value: string | boolean = true;
      if (ISSUE_DELIVERY_BOOLEAN_FLAGS.has(normalized)) {
        if (isBooleanLiteral(next)) value = tokens[++i];
      } else if (next && !next.startsWith("--")) {
        value = tokens[++i];
      }
      options[normalized] = coerceIssueDeliveryFlag(bare, value);
      continue;
    }
    if (equals > 0) {
      const name = bare.slice(0, equals);
      if (valueFlags.has(name)) {
        options[toCamelFlagName(name)] = coerceIssueDeliveryFlag(name, bare.slice(equals + 1));
        continue;
      }
    }
    keep.push(token);
  }

  const task = keep.join(" ").trim() || String(options.issue ?? options.planPath ?? "").trim();
  if (options.dryRun === true) options.prototype = true;
  return { ...options, task };
}

export function registerBuiltinWorkflows(pi: ExtensionAPI, opts: { cwd: string; manager?: WorkflowManager }): void {
  const cwd = opts.cwd;

  if (!alreadyRegistered(pi, "deep-research")) {
    pi.registerCommand("deep-research", {
      description: "Research a question across the web with cross-checked sources",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const { mode, rest: r1 } = extractModeFlag(args);
        const { harnessType, rest: r2 } = extractHarnessTypeFlag(r1);
        const { harnessConfig, rest } = extractHarnessConfigFlag(r2);
        const question = rest;
        if (!question)
          return ctx.ui.notify(
            "Usage: /deep-research [--mode <name>] [--harness-type <id>] [--harness-config <id>] <question>",
            "warning",
          );
        // Deterministic bound: reject an overlong question before the workflow
        // ever runs. The workflow re-clamps defensively for direct invocation, but
        // the slash handler is the authoritative gate so a huge question can never
        // reach a model prompt.
        if (question.length > MAX_RESEARCH_QUESTION_CHARS) {
          return ctx.ui.notify(
            `deep-research question is too long: ${question.length} chars (limit ${MAX_RESEARCH_QUESTION_CHARS}). Please shorten it.`,
            "warning",
          );
        }
        ctx.ui.notify("Researching — running web searches across several angles…", "info");
        // Read-only + web-only: every research agent runs against the repo
        // read-only tools plus the web_search/web_fetch tools — no agent
        // receives the `write` tool. The host renders the cited Markdown
        // report from the bounded supported claims into a fresh private
        // tmpdir directory (no cwd/.pi/.research writes, no model-controlled
        // path). No path-fenced write, no stamp, no artifact dir.
        const runTools = [...createReadOnlyTools(cwd), ...createWebTools()];
        try {
          const result = await runWorkflow(generateDeepResearchWorkflow(), {
            // Route tier/phase models against the host session registry (upstream #49 port).
            modelRegistry: ctx.modelRegistry,
            cwd,
            args: { question },
            // The run-level tool pool is read-only repo tools + web tools only.
            // Each agent narrows it with a per-call `tools` allowlist: Queries
            // is fenced ([]), Gather gets web_search + web_fetch, Verify and
            // Report are fenced ([]). No research agent can write, run shell,
            // or edit tracked files — the security boundary is the tool pool,
            // not the prompt text.
            tools: runTools,
            contextMode: mode,
            harness_type: harnessType,
            harness_config: harnessConfig,
            contextModeRegistry: buildRegistryForCwd(cwd),
            onPhase: (title) => ctx.ui.setStatus("deep-research", `research: ${title}`),
          });
          ctx.ui.setStatus("deep-research", undefined);

          // Host delivery (see deliverDeepResearchResult): the host renders the
          // cited Markdown report from the bounded supported claims via the
          // injectable writer, reapplies the configured UTF-8-safe summary,
          // claim, and citation limits, rejects invalid/uncited claims, surfaces
          // writer failure, and delivers path + claim/source
          // counts + short summary only. The validated question is threaded in
          // from the handler (the workflow result no longer carries it), so the
          // model cannot influence the report heading. No full report body in
          // any result channel; write failure or no cited claims must not report
          // success.
          const outcome = deliverDeepResearchResult(question, result, defaultResearchReportWriter);
          if (!outcome.ok) {
            ctx.ui.notify(outcome.warning, "warning");
            return;
          }
          await pi.sendMessage({ customType: "deep-research", content: outcome.message, display: true });
        } catch (error) {
          ctx.ui.setStatus("deep-research", undefined);
          ctx.ui.notify(`deep-research failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }

  if (!alreadyRegistered(pi, "adversarial-review")) {
    pi.registerCommand("adversarial-review", {
      description: "Investigate a task, then cross-check each finding with skeptical reviewers",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const { mode, rest: r1 } = extractModeFlag(args);
        const { harnessType, rest: r2 } = extractHarnessTypeFlag(r1);
        const { harnessConfig, rest } = extractHarnessConfigFlag(r2);
        const parsed = parseAdversarialReviewArgs(rest);
        const usage =
          "Usage: /adversarial-review [--mode <name>] [--harness-type <id>] [--harness-config <id>] " +
          "[--evidence[=web_fetch,github|web_search]] [--no-evidence] [--reviewers N] [--threshold N] <task or question>";
        if (!parsed.task) return ctx.ui.notify(usage, "warning");
        for (const component of parsed.unknownEvidenceComponents) {
          ctx.ui.notify(`Ignoring unsupported evidence component: ${component}`, "warning");
        }
        const workflowArgs = {
          task: parsed.task,
          reviewers: parsed.reviewers,
          threshold: parsed.threshold,
          evidence: parsed.evidence,
          evidenceComponents: parsed.evidenceComponents,
        };
        const tools = adversarialReviewTools(cwd, parsed.evidence ? parsed.evidenceComponents : []);
        ctx.ui.notify(
          parsed.evidence
            ? `Reviewing with evidence (${parsed.evidenceComponents.join(", ")}) — investigating, sourcing, then refuting…`
            : "Reviewing — investigating then refuting each finding…",
          "info",
        );
        try {
          if (opts.manager) {
            const { runId, promise } = opts.manager.startInBackground(
              generateAdversarialReviewWorkflow(),
              workflowArgs,
              {
                contextMode: mode,
                harness_type: harnessType,
                harness_config: harnessConfig,
                tools,
              },
            );
            ctx.ui.setStatus("adversarial-review", `review running (${runId})`);
            void promise.finally(() => ctx.ui.setStatus("adversarial-review", undefined)).catch(() => {});
            await pi.sendMessage({
              customType: "adversarial-review:started",
              content: backgroundStartedText("adversarial-review", runId, opts.manager.getRun(runId)?.transcriptDir),
              display: true,
            });
            return;
          }

          const result = await runWorkflow(generateAdversarialReviewWorkflow(), {
            modelRegistry: ctx.modelRegistry,
            cwd,
            args: workflowArgs,
            tools,
            contextMode: mode,
            harness_type: harnessType,
            harness_config: harnessConfig,
            contextModeRegistry: buildRegistryForCwd(cwd),
            onPhase: (title) => ctx.ui.setStatus("adversarial-review", `review: ${title}`),
          });
          ctx.ui.setStatus("adversarial-review", undefined);
          await pi.sendMessage({ customType: "adversarial-review", content: reportText(result), display: true });
        } catch (error) {
          ctx.ui.setStatus("adversarial-review", undefined);
          ctx.ui.notify(`adversarial-review failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }

  const registerIssueDelivery = (commandName: "issue-delivery" | "fugu", deprecated = false) => {
    if (alreadyRegistered(pi, commandName)) return;
    pi.registerCommand(commandName, {
      description: deprecated
        ? "Deprecated alias for /issue-delivery: autonomous issue-to-PR workflow"
        : "Autonomous Issue Delivery workflow: plan, edit, verify, and open a draft PR",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const { mode, rest: r1 } = extractModeFlag(args);
        const { harnessType, rest: r2 } = extractHarnessTypeFlag(r1);
        const { harnessConfig, rest } = extractHarnessConfigFlag(r2);
        const workflowArgs = buildIssueDeliveryArgs(rest);
        if (!workflowArgs.task) {
          return ctx.ui.notify(
            `Usage: /${commandName} [--mode <name>] [--harness-type <id>] [--harness-config <id>] [--prototype] [--finish] <task or issue>`,
            "warning",
          );
        }
        if (deprecated) {
          ctx.ui.notify("/fugu is deprecated; use /issue-delivery for new runs.", "warning");
        }
        const runModeText = workflowArgs.finish ? " (finish path)" : workflowArgs.prototype ? " (prototype lane)" : "";
        ctx.ui.notify(
          `Issue Delivery running${runModeText} — thinking, working, verifying, then shipping a draft PR…`,
          "info",
        );
        try {
          if (opts.manager) {
            const { runId, promise } = opts.manager.startInBackground(generateIssueDeliveryWorkflow(), workflowArgs, {
              contextMode: mode,
              harness_type: harnessType,
              harness_config: harnessConfig,
            });
            ctx.ui.setStatus(commandName, `${commandName} running (${runId})`);
            void promise.finally(() => ctx.ui.setStatus(commandName, undefined)).catch(() => {});
            await pi.sendMessage({
              customType: `${commandName}:started`,
              content: backgroundStartedText(commandName, runId, opts.manager.getRun(runId)?.transcriptDir),
              display: true,
            });
            return;
          }

          const result = await runWorkflow(generateIssueDeliveryWorkflow(), {
            modelRegistry: ctx.modelRegistry,
            cwd,
            args: workflowArgs,
            tools: createCodingTools(cwd),
            contextMode: mode,
            harness_type: harnessType,
            harness_config: harnessConfig,
            contextModeRegistry: buildRegistryForCwd(cwd),
            onPhase: (title) => ctx.ui.setStatus(commandName, `${commandName}: ${title}`),
          });
          ctx.ui.setStatus(commandName, undefined);
          await pi.sendMessage({ customType: commandName, content: reportText(result), display: true });
        } catch (error) {
          ctx.ui.setStatus(commandName, undefined);
          ctx.ui.notify(`/${commandName} failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  };

  registerIssueDelivery("issue-delivery");
  registerIssueDelivery("fugu", true);

  if (!alreadyRegistered(pi, "code-review")) {
    pi.registerCommand("code-review", {
      description: "Multi-angle code review with independent verification and synthesis",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const { mode, rest: r1 } = extractModeFlag(args);
        const { harnessType, rest: r2 } = extractHarnessTypeFlag(r1);
        const { harnessConfig, rest } = extractHarnessConfigFlag(r2);
        ctx.ui.notify("Reviewing — scoping, finding, verifying, synthesizing…", "info");
        try {
          // Host code owns all git argv/patch collection. Review agents get only
          // read-only tools, so prompt text is not the security boundary.
          const prepared = await prepareCodeReviewArgs(rest, cwd);
          const result = await runWorkflow(generateCodeReviewWorkflow(), {
            modelRegistry: ctx.modelRegistry,
            cwd,
            args: prepared,
            tools: createReadOnlyTools(cwd),
            contextMode: mode,
            harness_type: harnessType,
            harness_config: harnessConfig,
            contextModeRegistry: buildRegistryForCwd(cwd),
            onPhase: (title) => ctx.ui.setStatus("code-review", `review: ${title}`),
          });
          ctx.ui.setStatus("code-review", undefined);
          await pi.sendMessage({ customType: "code-review", content: reportText(result), display: true });
        } catch (error) {
          ctx.ui.setStatus("code-review", undefined);
          ctx.ui.notify(`code-review failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }
}
