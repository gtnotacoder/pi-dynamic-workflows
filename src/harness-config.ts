import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { WRITE_TOOL_NAMES } from "./agent-registry.js";
import { HARNESSES_DIR } from "./config.js";

export const HARNESS_TYPES = ["pi", "opencode", "hermes"] as const;
export type HarnessType = (typeof HARNESS_TYPES)[number];

export interface HarnessRuntimeInfo {
  harness_type: HarnessType;
  wired: boolean;
}

export const HARNESS_RUNTIME_INFO: Record<HarnessType, HarnessRuntimeInfo> = {
  pi: { harness_type: "pi", wired: true },
  opencode: { harness_type: "opencode", wired: false },
  hermes: { harness_type: "hermes", wired: false },
};

export interface HarnessConfig {
  schemaVersion: 1;
  id: string;
  harness_type: HarnessType;
  wired: boolean;
  displayName?: string;
  description?: string;
  trigger?: string;
  triggerRules?: Record<string, unknown>;
  legacyHarnessType?: string;
  invalid?: boolean;
  invalidReason?: string;
  source: "project" | "user";
  path?: string;
  raw: Record<string, unknown>;
}

export type HarnessConfigRegistry = Map<string, HarnessConfig>;

export interface LoadHarnessConfigRegistryOptions {
  projectDir?: string;
  userDir?: string;
  onWarning?: (message: string) => void;
}

const LEGACY_HARNESS_TYPE_IDS: Record<string, string> = {
  "frontend.radix-shadcn": "frontend-react-shadcn",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isHarnessType(value: unknown): value is HarnessType {
  return typeof value === "string" && (HARNESS_TYPES as readonly string[]).includes(value);
}

function canonicalId(
  raw: Record<string, unknown>,
  fileName: string,
): { id: string; legacyHarnessType?: string } | null {
  const id = stringField(raw.id) ?? stringField(raw.harness_config) ?? stringField(raw.profile);
  if (id) return { id };
  const legacyHarnessType = stringField(raw.harnessType);
  if (legacyHarnessType) {
    return {
      id: LEGACY_HARNESS_TYPE_IDS[legacyHarnessType] ?? legacyHarnessType.replace(/[._]/g, "-"),
      legacyHarnessType,
    };
  }
  const fromFile = basename(fileName)
    .replace(/\.json$/i, "")
    .trim();
  return fromFile ? { id: LEGACY_HARNESS_TYPE_IDS[fromFile] ?? fromFile.replace(/[._]/g, "-") } : null;
}

function triggerSummary(raw: Record<string, unknown>): string | undefined {
  const trigger = stringField(raw.trigger) ?? stringField(raw.triggerSummary);
  if (trigger) return trigger;
  if (isRecord(raw.triggerRules)) {
    const parts: string[] = [];
    for (const key of ["pathPrefixes", "importPatterns", "packageChangePatterns", "labels"]) {
      const value = raw.triggerRules[key];
      if (Array.isArray(value) && value.length > 0) parts.push(`${key}:${value.length}`);
    }
    if (parts.length > 0) return parts.join(", ");
  }
  return undefined;
}

export function parseHarnessConfigDescriptor(
  content: string,
  source: "project" | "user",
  fileName = "harness-config.json",
): HarnessConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null;

  const identity = canonicalId(raw, fileName);
  if (!identity) return null;

  const rawHarnessType = raw.harness_type ?? raw.harness;
  const invalidReason =
    rawHarnessType !== undefined && !isHarnessType(rawHarnessType)
      ? `Unknown harness_type '${String(rawHarnessType)}'`
      : undefined;
  const harness_type: HarnessType = invalidReason ? "pi" : isHarnessType(rawHarnessType) ? rawHarnessType : "pi";
  const triggerRules = isRecord(raw.triggerRules) ? raw.triggerRules : undefined;

  return {
    schemaVersion: 1,
    id: identity.id,
    harness_type,
    wired: invalidReason ? false : HARNESS_RUNTIME_INFO[harness_type].wired,
    displayName: stringField(raw.displayName) ?? stringField(raw.name),
    description: stringField(raw.description),
    trigger: triggerSummary(raw),
    triggerRules,
    legacyHarnessType: identity.legacyHarnessType,
    invalid: invalidReason !== undefined,
    invalidReason,
    source,
    raw,
  };
}

function readConfigsFromDir(
  dir: string,
  source: "project" | "user",
  onWarning?: (message: string) => void,
): HarnessConfig[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith(".json"));
  } catch {
    return [];
  }

  const configs: HarnessConfig[] = [];
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    const path = join(dir, file);
    try {
      const config = parseHarnessConfigDescriptor(readFileSync(path, "utf-8"), source, file);
      if (!config) {
        onWarning?.(`Skipping invalid or unsupported harness_config descriptor ${path}.`);
        continue;
      }
      if (config.invalidReason) {
        onWarning?.(`Skipping invalid harness_config descriptor ${path}: ${config.invalidReason}.`);
      }
      if ("profile" in config.raw) {
        onWarning?.(`Deprecated harness_config descriptor field 'profile' used in ${path}; prefer 'id'.`);
      }
      if ("harness" in config.raw) {
        onWarning?.(`Deprecated harness_config descriptor field 'harness' used in ${path}; prefer 'harness_type'.`);
      }
      configs.push({ ...config, path });
    } catch (error) {
      onWarning?.(
        `Skipping unreadable harness_config descriptor ${path}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return configs;
}

export function loadHarnessConfigRegistry(
  cwd: string,
  opts: LoadHarnessConfigRegistryOptions = {},
): HarnessConfigRegistry {
  const projectDir = opts.projectDir ?? join(cwd, HARNESSES_DIR);
  const userDir = opts.userDir ?? join(homedir(), HARNESSES_DIR);
  const registry: HarnessConfigRegistry = new Map();

  for (const config of readConfigsFromDir(projectDir, "project", opts.onWarning)) {
    if (registry.has(config.id)) {
      opts.onWarning?.(`Duplicate project harness_config id '${config.id}' ignored from ${config.path ?? projectDir}.`);
      continue;
    }
    registry.set(config.id, config);
  }

  if (userDir !== projectDir) {
    for (const config of readConfigsFromDir(userDir, "user", opts.onWarning)) {
      if (registry.has(config.id)) {
        opts.onWarning?.(`User harness_config id '${config.id}' ignored because a project descriptor wins.`);
        continue;
      }
      registry.set(config.id, config);
    }
  }

  return registry;
}

export function listHarnessConfigs(registry: HarnessConfigRegistry): HarnessConfig[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function renderHarnessConfigs(registry: HarnessConfigRegistry): string {
  const configs = listHarnessConfigs(registry);
  if (configs.length === 0) {
    return [
      "Harness configs — none found.",
      "Add schemaVersion:1 JSON descriptors under .pi/workflows/harnesses/ or ~/.pi/workflows/harnesses/.",
    ].join("\n");
  }

  const width = Math.max(...configs.map((config) => config.id.length), 8);
  const rows = configs.map((config) => {
    const runtime = `${config.harness_type}, ${config.wired ? "wired" : "not wired"}`;
    const label = config.displayName ? ` · ${config.displayName}` : "";
    const trigger = config.trigger ? ` · trigger:${config.trigger}` : "";
    const legacy = config.legacyHarnessType ? ` · legacy:${config.legacyHarnessType}` : "";
    return `  ${config.id.padEnd(width)}  (${runtime})${label}${trigger}${legacy}`;
  });

  return [
    "Harness configs — use `harness_config` for the capability bundle and `harness_type` for the runtime axis.",
    "Project descriptors override user descriptors on id collision.",
    "",
    ...rows,
  ].join("\n");
}

function registerOneHarnessConfigsCommand(
  pi: ExtensionAPI,
  name: "harness-configs" | "profiles",
  opts: { cwd: string },
): void {
  try {
    if ((pi.getCommands?.() ?? []).some((command: { name: string }) => command.name === name)) return;
  } catch {
    // getCommands may be unavailable; fall through and try to register.
  }

  pi.registerCommand(name, {
    description:
      name === "profiles"
        ? "Deprecated alias for /harness-configs"
        : "List harness configs and their harness_type runtime wiring",
    async handler(_args: string, _ctx: ExtensionCommandContext) {
      pi.sendMessage({
        customType: name,
        content: renderHarnessConfigs(loadHarnessConfigRegistry(opts.cwd)),
        display: true,
      });
    },
  });
}

export function registerHarnessConfigsCommand(pi: ExtensionAPI, opts: { cwd: string }): void {
  registerOneHarnessConfigsCommand(pi, "harness-configs", opts);
  registerOneHarnessConfigsCommand(pi, "profiles", opts);
}

// TODO(#230): finalize field spelling/values — external harness_type / harness_config
//              field names are tentative (blocked on dev-system #230). Kept as opaque
//              strings so callers are not coupled to the HarnessType union yet.

/** A single layer of harness overrides (e.g. run-level, frontmatter, per-call). */
export interface HarnessOverrides {
  harness_type?: string;
  harness_config?: string;
}

/**
 * Resolve the final harness override set from an ordered list of layers,
 * lowest precedence first (e.g. [runLevel, frontmatter, perCall]).
 *
 * Higher-index layers override lower-index layers. An undefined layer is
 * skipped. Within a layer, a field that is `undefined` inherits the lower
 * layer's value; an explicit `"none"` is a real override (not inheritance).
 */
export function resolveHarnessLayers(layers: ReadonlyArray<HarnessOverrides | undefined>): {
  harness_type?: string;
  harness_config?: string;
} {
  let harness_type: string | undefined;
  let harness_config: string | undefined;
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.harness_type !== undefined) harness_type = layer.harness_type;
    if (layer.harness_config !== undefined) harness_config = layer.harness_config;
  }
  return { harness_type, harness_config };
}

// ---------------------------------------------------------------------------
// Expansion layer: resolved harness_config → concrete runWorkflow overrides
// ---------------------------------------------------------------------------

/**
 * Pure expansion of a resolved harness_config into concrete runWorkflow
 * override fields. Callers may merge this into the `agent()` call options
 * before scheduling work.
 */
export interface HarnessExpansion {
  harness_type: HarnessType;
  harness_config: string;
  wired: boolean;
  contextMode?: string;
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  inheritMainRules?: boolean;
  systemPromptMode?: string;
  tools?: string[];
  disallowedTools?: string[];
  stageCheckDefaults?: Record<string, unknown>;
  agentOverrides?: Record<string, unknown>;
  componentExtensions?: string[];
  indexExtensions?: string[];
  directoryModuleSelfFile?: boolean;
  frontendPathTriggers?: string[];
}

/**
 * Expand a resolved harness_config (from the registry) into a concrete
 * `HarnessExpansion` with all agent/context/tool/stageCheck overrides
 * derived from the descriptor's raw payload.
 *
 * Pure — reads only the passed registry. When `readOnly` is true the
 * returned `tools` array will not include known write tool names. The
 * `applyToolPolicy` read-only fence also strips write tools as a final guard.
 */
export function expandHarnessConfig(opts: {
  harness_type?: string;
  harness_config?: string;
  registry: HarnessConfigRegistry;
  readOnly?: boolean;
}): HarnessExpansion {
  const { harness_type, harness_config, registry, readOnly } = opts;

  // "none" / missing harness_config ⇒ pass-through with defaults
  if (!harness_config || harness_config === "none") {
    const resolvedType = isHarnessType(harness_type) ? harness_type : "pi";
    return {
      harness_type: resolvedType,
      harness_config: "none",
      wired: HARNESS_RUNTIME_INFO[resolvedType].wired,
    };
  }

  const descriptor = registry.get(harness_config);
  if (!descriptor) {
    // Unknown id: fall back to pi defaults
    return {
      harness_type: isHarnessType(harness_type) ? harness_type : "pi",
      harness_config,
      wired: HARNESS_RUNTIME_INFO[isHarnessType(harness_type) ? harness_type : "pi"].wired,
    };
  }

  const type: HarnessType = isHarnessType(harness_type) ? harness_type : descriptor.harness_type;
  const raw = descriptor.raw;

  const result: HarnessExpansion = {
    harness_type: type,
    harness_config,
    wired: descriptor.invalid && !isHarnessType(harness_type) ? false : HARNESS_RUNTIME_INFO[type].wired,
  };

  // Optional override fields from raw
  if (isRecord(raw)) {
    result.contextMode = stringField(raw.contextMode);
    result.inheritProjectContext = booleanField(raw.inheritProjectContext);
    result.inheritSkills = booleanField(raw.inheritSkills);
    result.inheritMainRules = booleanField(raw.inheritMainRules);
    result.systemPromptMode = stringField(raw.systemPromptMode);

    const tools = stringArrayField(raw.tools);
    const disallowedTools = stringArrayField(raw.disallowedTools);

    result.tools = readOnly ? tools?.filter((tool) => !WRITE_TOOL_NAMES.has(tool)) : tools;
    result.disallowedTools = disallowedTools;

    if (isRecord(raw.stageCheck)) {
      result.stageCheckDefaults = raw.stageCheck as Record<string, unknown>;
    }
    if (isRecord(raw.agentOverrides)) {
      result.agentOverrides = raw.agentOverrides as Record<string, unknown>;
    }

    const shadcnDefaults = descriptor.id === "frontend-react-shadcn";
    result.componentExtensions =
      stringArrayField(raw.componentExtensions) ?? (shadcnDefaults ? [".tsx", ".jsx"] : undefined);
    result.indexExtensions =
      stringArrayField(raw.indexExtensions) ?? (shadcnDefaults ? [".ts", ".tsx", ".js", ".jsx"] : undefined);
    result.frontendPathTriggers =
      stringArrayField(raw.frontendPathTriggers) ??
      (shadcnDefaults && isRecord(raw.triggerRules) ? stringArrayField(raw.triggerRules.pathPrefixes) : undefined);
    result.directoryModuleSelfFile =
      typeof raw.directoryModuleSelfFile === "boolean"
        ? raw.directoryModuleSelfFile
        : shadcnDefaults
          ? true
          : undefined;
  }

  return result;
}

/**
 * Check whether a given harness_type is wired (connected to the Pi
 * runtime). Unknown types are treated as not wired.
 */
export function isHarnessWired(harness_type?: string): boolean {
  const type = isHarnessType(harness_type) ? harness_type : undefined;
  return type !== undefined ? HARNESS_RUNTIME_INFO[type].wired : false;
}

/**
 * Produce a structured clean-skip payload so callers can short-circuit
 * when the active harness is not wired.
 */
export function harnessNotWiredSkip(selection: { harness_type?: string; harness_config?: string; reason?: string }): {
  status: "harness-not-wired";
  harness_type: string;
  harness_config: string;
  reason: string;
} {
  const type = selection.harness_type ?? "pi";
  return {
    status: "harness-not-wired" as const,
    harness_type: type,
    harness_config: selection.harness_config ?? "none",
    reason: selection.reason ?? `Harness '${type}' is not wired to the current runtime.`,
  };
}

/**
 * Pull a `--harness-type <id>` / `--harness-type=<id>` / `--no-harness` flag out of a
 * raw args string, returning the harness type (if present) and the args with the
 * matched flag removed. The flag may appear anywhere; remaining args keep order
 * and are trimmed. Case-insensitive on the flag, not on the value.
 *
 * `--no-harness` maps to `harnessType: "none"`.
 */
export function extractHarnessTypeFlag(args: string): { harnessType?: string; rest: string } {
  const cut = (m: RegExpMatchArray): string =>
    `${args.slice(0, m.index)} ${args.slice((m.index ?? 0) + m[0].length)}`.replace(/\s+/g, " ").trim();
  const eq = args.match(/(?:^|\s)--harness-type=(\S+)/i);
  if (eq?.index !== undefined) return { harnessType: eq[1], rest: cut(eq) };
  const sp = args.match(/(?:^|\s)--harness-type\s+(\S+)/i);
  if (sp?.index !== undefined) return { harnessType: sp[1], rest: cut(sp) };
  const bare = args.match(/(?:^|\s)--no-harness/i);
  if (bare?.index !== undefined) return { harnessType: "none", rest: cut(bare) };
  return { rest: args.trim() };
}

/**
 * Pull a `--harness-config <id>` or `--harness-config=<id>` flag out of a raw
 * args string, returning the harness config (if present) and the args with the
 * flag removed. The flag may appear anywhere; remaining args keep order and
 * are trimmed. Case-insensitive on the flag, not on the value.
 */
export function extractHarnessConfigFlag(args: string): { harnessConfig?: string; rest: string } {
  const cut = (m: RegExpMatchArray): string =>
    `${args.slice(0, m.index)} ${args.slice((m.index ?? 0) + m[0].length)}`.replace(/\s+/g, " ").trim();
  const eq = args.match(/(?:^|\s)--harness-config=(\S+)/i);
  if (eq?.index !== undefined) return { harnessConfig: eq[1], rest: cut(eq) };
  const sp = args.match(/(?:^|\s)--harness-config\s+(\S+)/i);
  if (sp?.index !== undefined) return { harnessConfig: sp[1], rest: cut(sp) };
  return { rest: args.trim() };
}
