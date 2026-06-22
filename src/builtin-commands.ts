/**
 * Bundled workflow commands: `/deep-research`, `/adversarial-review`, and `/code-review`.
 * They run a generated workflow script and print the final report.
 */

import { createCodingTools, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow } from "./adversarial-review.js";
import { generateCodeReviewWorkflow } from "./code-review.js";
import { generateDeepResearchWorkflow } from "./deep-research.js";
import { buildRegistryForCwd, extractModeFlag } from "./modes-command.js";
import { createWebTools } from "./web-tools.js";
import { runWorkflow, type WorkflowRunResult } from "./workflow.js";

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

export function registerBuiltinWorkflows(pi: ExtensionAPI, opts: { cwd: string }): void {
  const cwd = opts.cwd;

  if (!alreadyRegistered(pi, "deep-research")) {
    pi.registerCommand("deep-research", {
      description: "Research a question across the web with cross-checked sources",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const { mode, rest } = extractModeFlag(args);
        const question = rest;
        if (!question) return ctx.ui.notify("Usage: /deep-research [--mode <name>] <question>", "warning");
        ctx.ui.notify("Researching — running web searches across several angles…", "info");
        try {
          const result = await runWorkflow(generateDeepResearchWorkflow(), {
            cwd,
            args: { question },
            // Research agents need real web access on top of the coding tools.
            tools: [...createCodingTools(cwd), ...createWebTools()],
            contextMode: mode,
            contextModeRegistry: buildRegistryForCwd(cwd),
            onPhase: (title) => ctx.ui.setStatus("deep-research", `research: ${title}`),
          });
          ctx.ui.setStatus("deep-research", undefined);
          await pi.sendMessage({ customType: "deep-research", content: reportText(result), display: true });
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
        const { mode, rest } = extractModeFlag(args);
        const task = rest;
        if (!task) return ctx.ui.notify("Usage: /adversarial-review [--mode <name>] <task or question>", "warning");
        ctx.ui.notify("Reviewing — investigating then refuting each finding…", "info");
        try {
          const result = await runWorkflow(generateAdversarialReviewWorkflow(), {
            cwd,
            args: { task },
            tools: createCodingTools(cwd),
            contextMode: mode,
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

  if (!alreadyRegistered(pi, "code-review")) {
    pi.registerCommand("code-review", {
      description: "Multi-angle code review with independent verification and synthesis",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const { mode, rest } = extractModeFlag(args);
        ctx.ui.notify("Reviewing — scoping, finding, verifying, synthesizing…", "info");
        try {
          // The script parses its level (high|xhigh|max) + target from the raw args
          // string at runtime, mirroring Claude Code's own arg parsing. The --mode
          // flag is stripped first so it never leaks into level/target parsing.
          const result = await runWorkflow(generateCodeReviewWorkflow(), {
            cwd,
            args: rest,
            tools: createCodingTools(cwd),
            contextMode: mode,
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
