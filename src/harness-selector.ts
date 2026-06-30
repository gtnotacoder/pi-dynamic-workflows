import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES_DIR } from "./config.js";
import {
  HARNESS_TYPES,
  type HarnessConfigRegistry,
  type HarnessType,
  loadHarnessConfigRegistry,
} from "./harness-config.js";

/**
 * Result of deterministic harness selection.
 *
 * Determinism contract: output is deeply-equal for identical inputs.
 * Only sorted directory listings and parsed JSON are inspected —
 * no reads of process.env, git state, or file mtimes.
 */
export interface HarnessSelection {
  harness_type: HarnessType;
  harness_config: string;
  source: "explicit" | "auto" | "default" | "frontmatter" | "runtime";
  signals?: string[];
  detectorVersion: 1;
}

/**
 * Select a harness for the given working directory.
 *
 * Deterministic: depends only on sorted directory listings and parsed
 * JSON contents. No process.env, git state, or file mtime reads.
 */
export function selectHarness(
  cwd: string,
  opts?: { registry?: HarnessConfigRegistry; projectDir?: string; userDir?: string },
): HarnessSelection {
  const projectDir = opts?.projectDir ?? join(cwd, HARNESSES_DIR);
  const registry = opts?.registry ?? loadHarnessConfigRegistry(cwd, { projectDir, userDir: opts?.userDir });
  const pkg = readJsonSafe(join(cwd, "package.json"));

  for (const descriptor of [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const signals = descriptorSignals(cwd, descriptor.id, descriptor.triggerRules, pkg);
    if (signals.length === 0) continue;
    signals.sort((a, b) => a.localeCompare(b));
    return {
      harness_type: descriptor.harness_type,
      harness_config: descriptor.id,
      source: "auto",
      signals,
      detectorVersion: 1,
    };
  }

  return fallbackDefault();
}

/* ------------------------------------------------------------------ */
/*  Serialization / round-trip helpers                                 */
/* ------------------------------------------------------------------ */

const VALID_SOURCES = ["explicit", "auto", "default", "frontmatter", "runtime"] as const;

type ValidSource = (typeof VALID_SOURCES)[number];

/**
 * Produce a canonical, key-sorted JSON string for a `HarnessSelection`.
 * The `signals` array (if present) is sorted before serialization so that
 * equal selections always produce the same string across runs.
 */
export function serializeHarnessSelection(sel: HarnessSelection): string {
  const clone: Record<string, unknown> = {
    detectorVersion: sel.detectorVersion,
    harness_config: sel.harness_config,
    harness_type: sel.harness_type,
    source: sel.source,
  };
  if (sel.signals !== undefined) {
    clone.signals = [...sel.signals].sort((a, b) => a.localeCompare(b));
  }
  return JSON.stringify(clone, Object.keys(clone).sort(), 0);
}

/**
 * Return a hashable key for an optional `HarnessSelection`.
 * Used in resume call-hash computation — returns a fixed sentinel when
 * the selection is `undefined`.
 */
export function harnessSelectionKey(sel: HarnessSelection | undefined): string {
  return sel !== undefined ? serializeHarnessSelection(sel) : '"none"';
}

/**
 * Validate a persisted/plain object back into a `HarnessSelection`.
 *
 * Guards:
 *  - `harness_type` against the canonical `HARNESS_TYPES` set.
 *  - `source` against the known source literals (including "runtime").
 *  - `detectorVersion` defaults to `1`.
 *  - `signals` must be a string array (if present).
 *
 * Returns `undefined` on malformed input so callers fall back to
 * a fresh `selectHarness()` call.
 */
export function parseHarnessSelection(raw: unknown): HarnessSelection | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const harnessType: HarnessType | undefined =
    typeof obj.harness_type === "string" && (HARNESS_TYPES as readonly string[]).includes(obj.harness_type)
      ? (obj.harness_type as HarnessType)
      : undefined;
  if (harnessType === undefined) return undefined;

  const harnessConfig = typeof obj.harness_config === "string" ? obj.harness_config : undefined;
  if (harnessConfig === undefined) return undefined;

  const source: ValidSource | undefined =
    typeof obj.source === "string" && VALID_SOURCES.includes(obj.source as ValidSource)
      ? (obj.source as ValidSource)
      : undefined;
  if (source === undefined) return undefined;

  const signals: string[] | undefined = Array.isArray(obj.signals)
    ? obj.signals.filter((s): s is string => typeof s === "string")
    : undefined;

  return {
    harness_type: harnessType,
    harness_config: harnessConfig,
    source,
    signals,
    detectorVersion: 1,
  };
}

/* ------------------------------------------------------------------ */
/*  descriptor detection                                               */
/* ------------------------------------------------------------------ */

function descriptorSignals(
  cwd: string,
  descriptorId: string,
  triggerRules: Record<string, unknown> | undefined,
  pkg: Record<string, unknown> | undefined,
): string[] {
  const signals = triggerRuleSignals(cwd, triggerRules, pkg);
  if (descriptorId === "frontend-react-shadcn") {
    signals.push(...componentsJsonSignals(cwd), ...shadcnDependencySignals(cwd, pkg));
  }
  return signals;
}

/* ------------------------------------------------------------------ */
/*  frontend-react-shadcn detection                                    */
/* ------------------------------------------------------------------ */

/** (a) `components.json` at `cwd` or `cwd/web` — the canonical shadcn manifest. */
function componentsJsonSignals(cwd: string): string[] {
  const signals: string[] = [];
  if (existsSync(join(cwd, "components.json"))) signals.push("components.json@cwd");
  if (existsSync(join(cwd, "web", "components.json"))) signals.push("components.json@cwd/web");
  return signals;
}

/**
 * (b) `package.json` shape: react AND tailwindcss AND (a `@radix-ui/*` dependency
 * OR an existing `src/components/ui/**\/*.tsx` component).
 */
function shadcnDependencySignals(cwd: string, pkg: Record<string, unknown> | undefined): string[] {
  if (!pkg) return [];
  const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  const hasReact = "react" in deps;
  const hasTailwind = "tailwindcss" in deps;
  const hasRadix = Object.keys(deps).some(isRadixDep);
  const hasUiTsx = hasSrcComponentsUiTsx(cwd);
  if (!(hasReact && hasTailwind && (hasRadix || hasUiTsx))) return [];

  const signals: string[] = [];
  if (hasRadix) signals.push("deps:@radix-ui/*");
  if (hasUiTsx) signals.push("src/components/ui/**/*.tsx");
  signals.push("deps:react+tailwindcss");
  return signals;
}

/**
 * (c) registry trigger rules — only statically observable rules contribute.
 * `pathPrefixes` (a declared dir exists) and `importPatterns` (a declared
 * dependency is present) describe the project's on-disk shape. The remaining
 * trigger keys describe runtime state the pure detector deliberately does not
 * read: `packageChangePatterns` is a git-diff signal and `labels` is a PR/issue
 * signal. Evaluating either from mere file existence would produce false
 * positives (e.g. every Node project has `package.json`) and break the
 * determinism contract, so they are intentionally not gating here.
 */
function triggerRuleSignals(
  cwd: string,
  triggerRules: Record<string, unknown> | undefined,
  pkg: Record<string, unknown> | undefined,
): string[] {
  if (!triggerRules) return [];
  const signals: string[] = [];

  for (const prefix of stringArray(triggerRules.pathPrefixes)) {
    if (existsSync(join(cwd, prefix))) signals.push(`pathPrefix:${prefix}`);
  }

  const depKeys = pkg ? Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }) : [];
  for (const pattern of stringArray(triggerRules.importPatterns)) {
    if (dependencyMatches(depKeys, pattern)) signals.push(`importPattern:${pattern}`);
  }

  return signals;
}

/** Whether a dependency key is a Radix UI primitive package. */
function isRadixDep(dep: string): boolean {
  return dep.startsWith("@radix-ui/");
}

/** Whether any dependency key matches the given import pattern fragment. */
function dependencyMatches(depKeys: string[], pattern: string): boolean {
  for (const dep of depKeys) {
    if (pattern.includes("*")) {
      const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, ".*")}$`);
      if (regex.test(dep)) return true;
      continue;
    }
    if (dep === pattern || dep.startsWith(`${pattern}/`) || dep.includes(pattern)) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/*  Fallback                                                           */
/* ------------------------------------------------------------------ */

function fallbackDefault(): HarnessSelection {
  return {
    harness_type: "pi",
    harness_config: "none",
    source: "default",
    detectorVersion: 1,
  };
}

/* ------------------------------------------------------------------ */
/*  Deterministic helpers                                              */
/* ------------------------------------------------------------------ */

/**
 * Return sorted children of `dir`, or `[]` if the directory does not exist.
 * Mirrors the sort discipline from harness-config.ts `readConfigsFromDir`.
 */
function sortedReaddir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort((a, b) => a.localeCompare(b)) : [];
}

/**
 * Safely parse a JSON file. Returns a parsed record or `undefined` on any error.
 */
function readJsonSafe(path: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check whether `cwd/src/components/ui/` contains any `.tsx` file, supporting
 * both flat (`checkbox.tsx`) and directory-module (`checkbox/index.tsx`) layouts
 * per Issue #48.
 */
function hasSrcComponentsUiTsx(cwd: string): boolean {
  const uiDir = join(cwd, "src", "components", "ui");
  if (!existsSync(uiDir)) return false;
  const entries = sortedReaddir(uiDir);
  for (const entry of entries) {
    const full = join(uiDir, entry);
    if (entry.endsWith(".tsx")) return true;
    if (existsSync(join(full, "index.tsx"))) return true;
  }
  return false;
}

/**
 * Extract the string members of an array-valued trigger-rule entry, ignoring
 * any non-string members. Returns `[]` for a missing or non-array value.
 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
