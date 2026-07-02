/**
 * `validate-harness` smoke gate.
 *
 * Loads + parses a harness_config descriptor (and, when referenced, its linked
 * workflow script) and checks required fields, supported `schemaVersion`, the
 * `engine.min` floor, and that the script parses — **without executing agents**.
 *
 * Intended for repo CI and post-engine-upgrade smoke. Returns non-zero on any
 * error. Additive-only minor / major-bump-to-remove discipline is documented in
 * docs/harness-engine-compat.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEngineFloor, readEngineVersionFromFile, type Semver } from "./engine-compat.js";
import { DEFAULT_SUPPORTED_SCHEMA_VERSIONS, parseHarnessConfigDescriptor } from "./harness-config.js";
import { parseWorkflowScript } from "./workflow.js";

export interface ValidateHarnessOptions {
  /** Running engine version; defaults to this package's version. */
  engineVersion?: Semver;
  /** Schema versions accepted by the validator. */
  supportedSchemaVersions?: readonly number[];
  /** Optional linked workflow script path to also parse (overrides descriptor `script`). */
  scriptPath?: string;
}

export interface ValidationFinding {
  level: "error" | "warning";
  message: string;
}

export interface HarnessValidationResult {
  ok: boolean;
  path: string;
  findings: ValidationFinding[];
}

function resolveScriptPath(descriptorPath: string, scriptRef: unknown): string | undefined {
  if (typeof scriptRef !== "string" || !scriptRef.trim()) return undefined;
  const base = dirname(descriptorPath);
  const resolved = isAbsolute(scriptRef) ? scriptRef : join(base, scriptRef);
  return resolved;
}

export function validateHarnessFile(
  descriptorPath: string,
  opts: ValidateHarnessOptions = {},
): HarnessValidationResult {
  const findings: ValidationFinding[] = [];
  const absPath = resolve(descriptorPath);

  if (!existsSync(absPath)) {
    return { ok: false, path: absPath, findings: [{ level: "error", message: `Descriptor not found: ${absPath}` }] };
  }

  const supported = opts.supportedSchemaVersions ?? DEFAULT_SUPPORTED_SCHEMA_VERSIONS;
  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (error) {
    return {
      ok: false,
      path: absPath,
      findings: [
        { level: "error", message: `Unreadable descriptor: ${error instanceof Error ? error.message : error}` },
      ],
    };
  }

  const config = parseHarnessConfigDescriptor(content, "project", absPath, {
    supportedSchemaVersions: supported,
  });
  if (!config) {
    let declared: unknown;
    try {
      declared = (JSON.parse(content) as { schemaVersion?: unknown })?.schemaVersion;
    } catch {
      declared = undefined;
    }
    const reason =
      declared !== undefined && typeof declared === "number" && !supported.includes(declared)
        ? `Unsupported schemaVersion ${declared}; supported: ${supported.join(", ")}`
        : "Descriptor is not a valid harness_config (missing schemaVersion or failed to parse)";
    return { ok: false, path: absPath, findings: [{ level: "error", message: reason }] };
  }

  if (config.invalidReason) {
    findings.push({ level: "error", message: config.invalidReason });
  }
  if (!config.id) {
    findings.push({ level: "error", message: "Missing required field 'id'" });
  }

  // Malformed tool-requirement lists: a present non-array (including null), an
  // empty array, or a mixed-type array would silently drop the requirement
  // (stringArrayField returns undefined) and let the run proceed WITHOUT the tool,
  // bypassing the clean-skip/degrade gate. Surface them here so validate-harness
  // catches the misdeclaration in CI instead of passing (mirrors the loader's
  // warn-and-clean-skip in readConfigsFromDir).
  if (config.requiredToolsMalformed) {
    findings.push({ level: "error", message: "requiredTools must be a non-empty string array" });
  }
  if (config.preferredToolsMalformed) {
    findings.push({ level: "error", message: "preferredTools must be a non-empty string array" });
  }

  // engine.min floor check.
  if (config.engineMinMalformed) {
    findings.push({ level: "error", message: "engine.min must be a semver string" });
  } else if (config.engineMin) {
    const engineVersion = opts.engineVersion ?? readEngineVersionFromFile(resolveEnginePackageJson(absPath));
    if (!engineVersion) {
      findings.push({
        level: "warning",
        message: `Could not verify engine.min '${config.engineMin}'; engine version unavailable`,
      });
    } else {
      const floor = checkEngineFloor(config.engineMin, engineVersion);
      if (!floor.ok) {
        findings.push({ level: "error", message: floor.reason ?? `engine.min check failed for '${config.engineMin}'` });
      }
    }
  }

  // Optional linked workflow script — parse without executing agents.
  const scriptRef = opts.scriptPath ?? config.raw.script ?? config.raw.workflowScript;
  const scriptPath = scriptRef === opts.scriptPath ? opts.scriptPath : resolveScriptPath(absPath, scriptRef);
  if (scriptPath) {
    if (!existsSync(scriptPath)) {
      findings.push({ level: "error", message: `Referenced workflow script not found: ${scriptPath}` });
    } else {
      try {
        const parsed = parseWorkflowScript(readFileSync(scriptPath, "utf-8"));
        const metaAny = parsed.meta as unknown as { engine?: { min?: unknown } };
        if (metaAny.engine && "min" in metaAny.engine) {
          if (typeof metaAny.engine.min !== "string") {
            findings.push({
              level: "error",
              message: "Workflow meta engine.min must be a semver string",
            });
          } else {
            const metaEngineMin = metaAny.engine.min;
            const engineVersion = opts.engineVersion ?? readEngineVersionFromFile(resolveEnginePackageJson(absPath));
            if (engineVersion) {
              const floor = checkEngineFloor(metaEngineMin, engineVersion);
              if (!floor.ok) {
                findings.push({
                  level: "error",
                  message: `Workflow meta engine.min '${metaEngineMin}': ${floor.reason}`,
                });
              }
            }
          }
        }
      } catch (error) {
        findings.push({
          level: "error",
          message: `Workflow script failed to parse: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
  }

  return { ok: !findings.some((finding) => finding.level === "error"), path: absPath, findings };
}

/** Resolve the engine package.json from a descriptor location (walk up is overkill; use import.meta). */
function resolveEnginePackageJson(_descriptorPath: string): string {
  return fileURLToPath(new URL("../package.json", import.meta.url));
}

export interface ValidateHarnessRunResult {
  exitCode: number;
  results: HarnessValidationResult[];
  report: string;
}

/** CLI entry: validate one or more descriptor paths. Returns an exit code (non-zero on any error). */
export function runValidateHarness(
  args: readonly string[],
  opts: ValidateHarnessOptions = {},
): ValidateHarnessRunResult {
  // `--script <path>` (or `--script=<path>`) supplies a linked workflow script
  // override applied to each descriptor. Positional args are all descriptor paths
  // (so CI globs over many descriptors validate each one, not a descriptor+script pair).
  let scriptPath: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--script") {
      scriptPath = args[i + 1];
      if (typeof scriptPath !== "string" || !scriptPath) {
        return {
          exitCode: 2,
          results: [],
          report:
            "validate-harness: --script requires a path argument\nusage: validate-harness <descriptor.json> [--script <script.js>] [<descriptor2>...]",
        };
      }
      i++;
    } else if (arg.startsWith("--script=")) {
      scriptPath = arg.slice("--script=".length);
      if (!scriptPath) {
        return {
          exitCode: 2,
          results: [],
          report:
            "validate-harness: --script= requires a non-empty path\nusage: validate-harness <descriptor.json> [--script <script.js>] [<descriptor2>...]",
        };
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  if (positional.length === 0) {
    return {
      exitCode: 2,
      results: [],
      report:
        "validate-harness: no descriptor paths provided\nusage: validate-harness <descriptor.json> [--script <script.js>] [<descriptor2>...]",
    };
  }
  const results = positional.map((path) => validateHarnessFile(path, scriptPath ? { ...opts, scriptPath } : opts));
  const lines: string[] = [];
  let hasError = false;
  for (const result of results) {
    const status = result.ok ? "ok" : "FAIL";
    if (!result.ok) hasError = true;
    lines.push(`[${status}] ${result.path}`);
    for (const finding of result.findings) {
      lines.push(`  ${finding.level}: ${finding.message}`);
    }
  }
  return { exitCode: hasError ? 1 : 0, results, report: lines.join("\n") };
}
