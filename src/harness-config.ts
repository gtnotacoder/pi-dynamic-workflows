import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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

function isHarnessType(value: unknown): value is HarnessType {
  return typeof value === "string" && (HARNESS_TYPES as readonly string[]).includes(value);
}

function canonicalId(
  raw: Record<string, unknown>,
  fileName: string,
): { id: string; legacyHarnessType?: string } | null {
  const id = stringField(raw.id);
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
  const harness_type: HarnessType = isHarnessType(rawHarnessType) ? rawHarnessType : "pi";
  const triggerRules = isRecord(raw.triggerRules) ? raw.triggerRules : undefined;

  return {
    schemaVersion: 1,
    id: identity.id,
    harness_type,
    wired: HARNESS_RUNTIME_INFO[harness_type].wired,
    displayName: stringField(raw.displayName) ?? stringField(raw.name),
    description: stringField(raw.description),
    trigger: triggerSummary(raw),
    triggerRules,
    legacyHarnessType: identity.legacyHarnessType,
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
      if (config) configs.push({ ...config, path });
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
    const trigger = config.trigger ? ` · trigger:${config.trigger}` : "";
    const legacy = config.legacyHarnessType ? ` · legacy:${config.legacyHarnessType}` : "";
    return `  ${config.id.padEnd(width)}  (${runtime})${trigger}${legacy}`;
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
