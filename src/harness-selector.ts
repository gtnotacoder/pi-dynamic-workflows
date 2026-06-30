import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES_DIR } from "./config.js";
import type { HarnessConfigRegistry, HarnessType } from "./harness-config.js";
import { loadHarnessConfigRegistry } from "./harness-config.js";

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
