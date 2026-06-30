/**
 * Named workflow subagent definitions ("agentType" registry).
 *
 * A workflow script can route an agent() call to a reusable, named definition:
 *
 *   agent("audit this dir", { agentType: "security-auditor" })
 *
 * Definitions live as Markdown files under `.pi/agents/*.md` (project, cwd-relative)
 * and `~/.pi/agents/*.md` (user). Frontmatter binds the subagent's tools, model,
 * and a body prompt; project definitions win on a name collision. This mirrors
 * Claude Code's `.claude/agents` registry: agentType is a real binding of
 * tools+model+system-prompt, not a prose hint.
 *
 * Bound today: `tools` (allowlist), `disallowedTools` (denylist), `model`,
 * and the markdown body (`prompt`). Parsed-but-ignored for now (documented):
 * `mcp`, `skills`, `background`, `isolation` — each is wired independently later.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AGENTS_DIR } from "./config.js";
import { isSystemPromptMode, type SystemPromptMode } from "./context-mode.js";

export interface AgentDefinition {
  /** Stable identity used as the `agentType` value. */
  name: string;
  /** One-line summary (for discoverability in the tool guideline). */
  description?: string;
  /** Allowlist of coding-tool names the subagent may use. Undefined = all. */
  tools?: string[];
  /** Denylist of coding-tool names, applied after the allowlist. */
  disallowedTools?: string[];
  /** Model spec (`provider/modelId` or bare id) for this subagent. */
  model?: string;
  /** Markdown body, prepended to the subagent's task as role guidance. */
  prompt: string;
  /** Named context-inheritance posture (expands to the three primitives below). */
  contextMode?: string;
  /** Load project AGENTS.md / context files into the subagent session. Default true. */
  inheritProjectContext?: boolean;
  /** "append": keep base prompt + role-as-task (default); "replace": role IS the base system prompt. */
  systemPromptMode?: SystemPromptMode;
  /** Load skills into the subagent session. Default true. */
  inheritSkills?: boolean;
  /** Inherit the main-agent append channel (`.pi/APPEND_SYSTEM.md`). Default false (no leak). */
  inheritMainRules?: boolean;
  /** Opaque harness selector, bound from the agentType `.md` (tentative, pending dev-system #230). */
  harness_type?: string;
  /** Opaque harness configuration string (tentative, pending dev-system #230). */
  harness_config?: string;
  /** Where the definition was loaded from (project wins over user). */
  source: "project" | "user";
}

export type AgentRegistry = Map<string, AgentDefinition>;

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const arr = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return arr.length ? arr : undefined;
}

/** Read a frontmatter boolean, accepting real booleans and the strings "true"/"false". */
function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return undefined;
}

/**
 * Parse one agent-definition markdown file. Returns null only when there is no
 * usable content (no name derivable and an empty body).
 */
export function parseAgentDefinition(
  content: string,
  source: "project" | "user",
  fileName: string,
): AgentDefinition | null {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(content);
  } catch {
    // Malformed frontmatter: treat the whole file as a body, name from filename.
    parsed = { frontmatter: {}, body: content };
  }
  const fm = parsed.frontmatter;
  const fmName = typeof fm.name === "string" ? fm.name.trim() : "";
  const name = fmName || basename(fileName).replace(/\.md$/i, "").trim();
  const prompt = parsed.body.trim();
  if (!name && !prompt) return null;

  const systemPromptMode = isSystemPromptMode(fm.systemPromptMode) ? fm.systemPromptMode : undefined;

  return {
    name,
    description: typeof fm.description === "string" ? fm.description.trim() || undefined : undefined,
    tools: toStringArray(fm.tools),
    disallowedTools: toStringArray(fm.disallowedTools),
    model: typeof fm.model === "string" ? fm.model.trim() || undefined : undefined,
    prompt,
    contextMode: typeof fm.contextMode === "string" ? fm.contextMode.trim() || undefined : undefined,
    inheritProjectContext: toBool(fm.inheritProjectContext),
    systemPromptMode,
    inheritSkills: toBool(fm.inheritSkills),
    inheritMainRules: toBool(fm.inheritMainRules),
    harness_type: typeof fm.harness_type === "string" ? fm.harness_type.trim() || undefined : undefined,
    harness_config: typeof fm.harness_config === "string" ? fm.harness_config.trim() || undefined : undefined,
    source,
  };
}

function readDefsFromDir(dir: string, source: "project" | "user"): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
  const defs: AgentDefinition[] = [];
  for (const file of files.sort()) {
    try {
      const def = parseAgentDefinition(readFileSync(join(dir, file), "utf-8"), source, file);
      if (def) defs.push(def);
    } catch {
      // Skip unreadable/invalid files; never let one bad file break the registry.
    }
  }
  return defs;
}

/**
 * Load the agent registry once for a run. Scans the project dir then the user
 * dir; the FIRST definition for a name wins (project > user, then filename
 * order), so a name collision is resolved deterministically and silently.
 *
 * `opts` overrides the scanned directories (used by tests).
 */
export function loadAgentRegistry(cwd: string, opts?: { projectDir?: string; userDir?: string }): AgentRegistry {
  const projectDir = opts?.projectDir ?? join(cwd, AGENTS_DIR);
  const userDir = opts?.userDir ?? join(homedir(), AGENTS_DIR);
  const registry: AgentRegistry = new Map();
  for (const def of readDefsFromDir(projectDir, "project")) {
    if (def.name && !registry.has(def.name)) registry.set(def.name, def);
  }
  if (userDir !== projectDir) {
    for (const def of readDefsFromDir(userDir, "user")) {
      if (def.name && !registry.has(def.name)) registry.set(def.name, def);
    }
  }
  return registry;
}

/** Resolve an agentType name to its definition, or undefined if not registered. */
export function resolveAgentType(name: string | undefined, registry: AgentRegistry): AgentDefinition | undefined {
  if (!name) return undefined;
  return registry.get(name);
}

/**
 * Apply a definition's tool policy to a tool list: keep only allowlisted names
 * (when an allowlist is given), then drop any denylisted names. Generic over any
 * object with a `name` so it is unit-testable without real ToolDefinitions.
 */
export function applyToolPolicy<T extends { name: string }>(tools: T[], allow?: string[], deny?: string[]): T[] {
  let out = tools;
  if (allow?.length) {
    const allowSet = new Set(allow);
    out = out.filter((t) => allowSet.has(t.name));
  }
  if (deny?.length) {
    const denySet = new Set(deny);
    out = out.filter((t) => !denySet.has(t.name));
  }
  return out;
}

/**
 * A stable identity string for a resolved definition, folded into the resume
 * call-hash so editing an agent `.md` invalidates that call's cached result.
 */
export function agentDefinitionKey(def: AgentDefinition | undefined): string | null {
  if (!def) return null;
  return JSON.stringify({
    tools: def.tools ?? null,
    disallowedTools: def.disallowedTools ?? null,
    model: def.model ?? null,
    prompt: def.prompt,
    contextMode: def.contextMode ?? null,
    inheritProjectContext: def.inheritProjectContext ?? null,
    systemPromptMode: def.systemPromptMode ?? null,
    inheritSkills: def.inheritSkills ?? null,
    inheritMainRules: def.inheritMainRules ?? null,
    harness_type: def.harness_type ?? null,
    harness_config: def.harness_config ?? null,
  });
}

/** List registered agent types for discoverability in the tool guideline. */
export function listAgentTypes(registry: AgentRegistry): Array<{ name: string; description?: string }> {
  return [...registry.values()].map((d) => ({ name: d.name, description: d.description }));
}
