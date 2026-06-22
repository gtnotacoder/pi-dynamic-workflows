/**
 * `/modes` — list the context-inheritance modes (built-in + project-defined) and
 * what each expands to, plus `extractModeFlag`: the shared `--mode <name>` parser
 * used by the bundled workflow commands so `/code-review --mode isolated` (etc.)
 * sets a run-level default posture for every subagent in that run.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  buildContextModeRegistry,
  type ContextModeRegistry,
  type ContextPrimitives,
  DEFAULT_CONTEXT_MODE,
} from "./context-mode.js";
import { loadWorkflowSettings } from "./workflow-settings.js";

/**
 * Pull a `--mode <name>` or `--mode=<name>` flag out of a raw args string,
 * returning the mode (if present) and the args with the flag removed. The flag
 * may appear anywhere; the remaining args keep their order. Case-insensitive on
 * the flag, not on the value.
 */
export function extractModeFlag(args: string): { mode?: string; rest: string } {
  const cut = (m: RegExpMatchArray): string =>
    `${args.slice(0, m.index)} ${args.slice((m.index ?? 0) + m[0].length)}`.replace(/\s+/g, " ").trim();
  const eq = args.match(/(?:^|\s)--mode=(\S+)/i);
  if (eq?.index !== undefined) return { mode: eq[1], rest: cut(eq) };
  const sp = args.match(/(?:^|\s)--mode\s+(\S+)/i);
  if (sp?.index !== undefined) return { mode: sp[1], rest: cut(sp) };
  return { rest: args.trim() };
}

/** Build the active registry for a project (built-ins + its `contextModes`). */
export function buildRegistryForCwd(cwd: string): ContextModeRegistry {
  return buildContextModeRegistry(loadWorkflowSettings({ cwd }).contextModes);
}

function describe(p: ContextPrimitives): string {
  const context = p.inheritProjectContext ? "context:in " : "context:out";
  const skills = p.inheritSkills ? "skills:in " : "skills:out";
  return `${context} · prompt:${p.systemPromptMode.padEnd(7)} · ${skills}`;
}

/** Plain-text listing of a registry, `inherit` first then alphabetical. */
export function renderModes(registry: ContextModeRegistry): string {
  const names = Object.keys(registry).sort((a, b) =>
    a === DEFAULT_CONTEXT_MODE ? -1 : b === DEFAULT_CONTEXT_MODE ? 1 : a.localeCompare(b),
  );
  const width = Math.max(...names.map((n) => n.length), 8);
  const rows = names.map((n) => `  ${n.padEnd(width)}  ${describe(registry[n])}`);
  return [
    "Context-inheritance modes — use `--mode <name>` or set `contextMode:` in an agent `.md`:",
    ...rows,
    "",
    "Define your own under `contextModes` in ~/.pi/workflows/settings.json (or the project override).",
  ].join("\n");
}

/** Register `/modes`. Idempotent. */
export function registerModesCommand(pi: ExtensionAPI, opts: { cwd: string }): void {
  try {
    if ((pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === "modes")) return;
  } catch {
    // getCommands may be unavailable; fall through and try to register.
  }
  pi.registerCommand("modes", {
    description: "List context-inheritance modes (built-in + project-defined) and what each expands to",
    async handler(_args: string, _ctx: ExtensionCommandContext) {
      await pi.sendMessage({
        customType: "modes",
        content: renderModes(buildRegistryForCwd(opts.cwd)),
        display: true,
      });
    },
  });
}
