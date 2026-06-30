import {
  existsSync as defaultExistsSync,
  realpathSync as defaultRealpathSync,
  statSync as defaultStatSync,
  type Stats,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export const FRONTEND_COMPONENT_EXTENSIONS: readonly string[] = [".tsx", ".jsx", ".vue", ".svelte"];

/** Matches package-private source/build internals after path normalization. */
export const PACKAGE_INTERNAL_RE = /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/(?:src|dist|build|internal)(?:\/|$)/;

export type CtxReadGuardrailKind =
  | "file"
  | "directory"
  | "missing"
  | "packageInternal"
  | "frontendFallback"
  | "invalid";

export interface CtxReadGuardrailOutcome {
  ok: boolean;
  kind: CtxReadGuardrailKind;
  normalizedPath?: string;
  reason: string;
  fallbackHint?: string;
}

export interface GuardCtxReadOptions {
  cwd: string;
  allowDirectory?: boolean;
  allowPackageInternals?: boolean;
  frontendExtensions?: readonly string[];
  /** Component file extensions for frontend fallback (e.g. [".tsx", ".jsx"]). */
  componentExtensions?: readonly string[];
  /** Barrel/index file extensions (e.g. [".ts", ".tsx", ".js", ".jsx"]). */
  indexExtensions?: readonly string[];
  /** When true, emit dir/stem/stem.ext directory-module self-file candidates. */
  directoryModuleSelfFile?: boolean;
  /** Glob-ish path prefixes that gate frontend fallback (e.g. ["components/ui/"]). */
  frontendPathTriggers?: readonly string[];
  /** Injectable filesystem hooks for tests. */
  exists?: (path: string) => boolean;
  stat?: (path: string) => Pick<Stats, "isDirectory" | "isFile">;
  realpath?: (path: string) => string;
}

interface NormalizedPath {
  ok: true;
  absolutePath: string;
  normalizedPath: string;
}

interface RealpathWithinCwd {
  realNormalizedPath: string;
}

/**
 * Validate and normalize a path before attempting an expensive ctx_read /
 * lean-ctx bridge read. The returned outcome is intentionally concise so a
 * caller can show it directly as a fallback hint instead of surfacing noisy
 * bridge errors like "Is a directory" or package-internal file-not-found traces.
 */
export function guardCtxReadPath(rawPath: string, opts: GuardCtxReadOptions): CtxReadGuardrailOutcome {
  const pathText = String(rawPath ?? "").trim();
  const exists = opts.exists ?? defaultExistsSync;
  const stat = opts.stat ?? defaultStatSync;
  const realpath = opts.realpath ?? defaultRealpathSync.native;
  const frontendExtensions = opts.frontendExtensions ?? FRONTEND_COMPONENT_EXTENSIONS;
  const componentExtensions = opts.componentExtensions ?? frontendExtensions;
  const indexExtensions = opts.indexExtensions ?? frontendExtensions;
  const directoryModuleSelfFile = opts.directoryModuleSelfFile ?? false;
  const frontendPathTriggers = opts.frontendPathTriggers;

  if (!pathText) return invalid("Path is empty.");
  if (pathText.startsWith("-")) return invalid(`Path looks like an option, not a file: ${pathText}`);
  if (hasControlCharacter(pathText)) return invalid("Path contains a control character.");

  const normalized = normalizeWithinCwd(pathText, opts.cwd);
  if (!isNormalizedPath(normalized)) return normalized;

  const allowPackageInternals = opts.allowPackageInternals ?? false;
  const packageInternal = packageInternalOutcome(normalized.normalizedPath, allowPackageInternals);
  if (packageInternal) return packageInternal;

  if (!exists(normalized.absolutePath)) {
    const frontendFallback = frontendFallbackOutcome(
      normalized.normalizedPath,
      opts.cwd,
      componentExtensions,
      indexExtensions,
      directoryModuleSelfFile,
      frontendPathTriggers,
      exists,
      stat,
      realpath,
      allowPackageInternals,
    );
    if (frontendFallback) return frontendFallback;
    return {
      ok: false,
      kind: "missing",
      normalizedPath: normalized.normalizedPath,
      reason: `Path does not exist: ${normalized.normalizedPath}`,
      fallbackHint: `Try fffind ${basename(pathText)} or ctx_grep ${basename(pathText)} before ctx_read.`,
    };
  }

  const realpathResult = resolveExistingRealpathWithinCwd(normalized, opts.cwd, realpath);
  if (!isRealpathWithinCwd(realpathResult)) return realpathResult;
  const realPackageInternal = packageInternalOutcome(realpathResult.realNormalizedPath, allowPackageInternals);
  if (realPackageInternal) return realPackageInternal;

  let stats: Pick<Stats, "isDirectory" | "isFile">;
  try {
    stats = stat(normalized.absolutePath);
  } catch {
    return {
      ok: false,
      kind: "missing",
      normalizedPath: normalized.normalizedPath,
      reason: `Path disappeared before it could be inspected: ${normalized.normalizedPath}`,
      fallbackHint: `Try fffind ${basename(pathText)} before ctx_read.`,
    };
  }

  if (stats.isDirectory()) {
    if (opts.allowDirectory)
      return ok("directory", normalized.normalizedPath, "Directory reads are explicitly allowed.");
    const indexHint = firstExistingIndex(normalized.normalizedPath, opts.cwd, indexExtensions, exists);
    return {
      ok: false,
      kind: "directory",
      normalizedPath: normalized.normalizedPath,
      reason: "Path resolves to a directory; ctx_read expects a file.",
      fallbackHint: indexHint
        ? `Use ctx_read ${indexHint} or list the directory with ctx_ls ${normalized.normalizedPath}.`
        : `Use ctx_ls ${normalized.normalizedPath} or fffind ${basename(normalized.normalizedPath)} to choose a file.`,
    };
  }

  if (!stats.isFile()) {
    return {
      ok: false,
      kind: "invalid",
      normalizedPath: normalized.normalizedPath,
      reason: "Path is not a regular file; ctx_read expects a readable file.",
      fallbackHint: `Use ctx_ls ${dirname(normalized.normalizedPath)} to inspect the entry before reading.`,
    };
  }

  return ok("file", normalized.normalizedPath, "Path is safe for ctx_read.");
}

function normalizeWithinCwd(rawPath: string, cwd: string): NormalizedPath | CtxReadGuardrailOutcome {
  const absolutePath = resolve(cwd, rawPath);
  const normalizedPath = normalizeRelativePath(relative(cwd, absolutePath)) || ".";
  if (normalizedPath.startsWith("../") || normalizedPath === ".." || isAbsolute(normalizedPath)) {
    return invalid(`Path escapes the repository: ${rawPath}`);
  }
  return { ok: true, absolutePath, normalizedPath };
}

function resolveExistingRealpathWithinCwd(
  normalized: NormalizedPath,
  cwd: string,
  realpath: (path: string) => string,
): RealpathWithinCwd | CtxReadGuardrailOutcome {
  let realCwd: string;
  let realCandidate: string;
  try {
    realCwd = realpath(cwd);
    realCandidate = realpath(normalized.absolutePath);
  } catch {
    return {
      ok: false,
      kind: "missing",
      normalizedPath: normalized.normalizedPath,
      reason: `Path could not be resolved safely: ${normalized.normalizedPath}`,
      fallbackHint: `Try fffind ${basename(normalized.normalizedPath)} before ctx_read.`,
    };
  }
  const realNormalizedPath = normalizeRelativePath(relative(realCwd, realCandidate)) || ".";
  if (
    realNormalizedPath &&
    (realNormalizedPath.startsWith("../") || realNormalizedPath === ".." || isAbsolute(realNormalizedPath))
  ) {
    return invalid(`Path resolves outside the repository after symlink resolution: ${normalized.normalizedPath}`);
  }
  return { realNormalizedPath };
}

function packageInternalOutcome(normalizedPath: string, allowed: boolean): CtxReadGuardrailOutcome | undefined {
  if (allowed || !isPackageInternalPath(normalizedPath)) return undefined;
  return {
    ok: false,
    kind: "packageInternal",
    normalizedPath,
    reason: "Package internals are not enabled; avoid probing unavailable package source/build internals.",
    fallbackHint: packageEntrypointHint(normalizedPath),
  };
}

function frontendFallbackOutcome(
  rawPath: string,
  cwd: string,
  componentExtensions: readonly string[],
  indexExtensions: readonly string[],
  directoryModuleSelfFile: boolean,
  frontendPathTriggers: readonly string[] | undefined,
  exists: (path: string) => boolean,
  stat: (path: string) => Pick<Stats, "isDirectory" | "isFile">,
  realpath: (path: string) => string,
  allowPackageInternals: boolean,
): CtxReadGuardrailOutcome | undefined {
  if (!looksLikeFrontendComponentPath(rawPath, componentExtensions)) return undefined;
  const normalizedPath = normalizeRelativePath(rawPath);
  if (frontendPathTriggers && frontendPathTriggers.length > 0) {
    const matched = frontendPathTriggers.some((trigger) => matchesFrontendTrigger(normalizedPath, trigger));
    if (!matched) return undefined;
  }
  for (const candidate of generateFrontendFallbacks(
    rawPath,
    componentExtensions,
    indexExtensions,
    directoryModuleSelfFile,
  )) {
    const normalized = normalizeWithinCwd(candidate, cwd);
    if (!isNormalizedPath(normalized)) continue;
    if (exists(normalized.absolutePath)) {
      const packageInternal = packageInternalOutcome(normalized.normalizedPath, allowPackageInternals);
      if (packageInternal) return packageInternal;
      const realpathResult = resolveExistingRealpathWithinCwd(normalized, cwd, realpath);
      if (!isRealpathWithinCwd(realpathResult)) return realpathResult;
      const realPackageInternal = packageInternalOutcome(realpathResult.realNormalizedPath, allowPackageInternals);
      if (realPackageInternal) return realPackageInternal;
      let stats: Pick<Stats, "isDirectory" | "isFile">;
      try {
        stats = stat(normalized.absolutePath);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      return {
        ok: true,
        kind: "frontendFallback",
        normalizedPath: normalized.normalizedPath,
        reason: `Original frontend component path is missing; selected ${normalized.normalizedPath}.`,
        fallbackHint: `Use ctx_read ${normalized.normalizedPath}.`,
      };
    }
  }
  return undefined;
}

function matchesFrontendTrigger(normalizedPath: string, trigger: string): boolean {
  const normalizedTrigger = normalizeTriggerPrefix(trigger);
  return normalizedPath === normalizedTrigger || normalizedPath.startsWith(`${normalizedTrigger}/`);
}

function generateFrontendFallbacks(
  rawPath: string,
  componentExtensions: readonly string[],
  indexExtensions: readonly string[],
  directoryModuleSelfFile: boolean,
): string[] {
  const dir = dirname(rawPath);
  const ext = extname(rawPath);
  const stem = basename(rawPath, ext);
  const candidates: string[] = [];

  /* 1) Directory-module self-file: dir/stem/stem.ext (when opt-in) */
  if (directoryModuleSelfFile) {
    for (const candidateExt of componentExtensions) {
      candidates.push(join(dir, stem, `${stem}${candidateExt}`));
    }
  }

  /* 2) Barrel/index: dir/stem/index.ext */
  for (const candidateExt of indexExtensions) {
    candidates.push(join(dir, stem, `index${candidateExt}`));
  }

  /* 3) Sibling variants: dir/stem.ext */
  for (const candidateExt of componentExtensions) {
    candidates.push(join(dir, `${stem}${candidateExt}`));
  }

  return unique(candidates.filter((candidate) => normalizeRelativePath(candidate) !== normalizeRelativePath(rawPath)));
}

function firstExistingIndex(
  normalizedDirectory: string,
  cwd: string,
  indexExtensions: readonly string[],
  exists: (path: string) => boolean,
): string | undefined {
  for (const extension of indexExtensions) {
    const candidate = normalizeRelativePath(join(normalizedDirectory, `index${extension}`));
    if (exists(resolve(cwd, candidate))) return candidate;
  }
  return undefined;
}

function looksLikeFrontendComponentPath(pathText: string, frontendExtensions: readonly string[]): boolean {
  const extension = extname(pathText);
  return frontendExtensions.includes(extension);
}

function isPackageInternalPath(normalizedPath: string): boolean {
  const pathText = normalizeRelativePath(normalizedPath);
  if (pathText.endsWith(".d.ts") || pathText.endsWith(".md") || pathText.includes("/docs/")) return false;
  return PACKAGE_INTERNAL_RE.test(pathText);
}

function packageEntrypointHint(normalizedPath: string): string {
  const parts = normalizeRelativePath(normalizedPath).split("/");
  const packageRoot = packageRootForInternalPath(parts);
  if (!packageRoot) return "Read the package entrypoint or README instead.";
  return `Read ${packageRoot}/package.json or ${packageRoot}/README.md instead.`;
}

function packageRootForInternalPath(parts: string[]): string | undefined {
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index] !== "node_modules") continue;
    const first = parts[index + 1];
    if (!first) continue;
    const packageNameLength = first.startsWith("@") ? 2 : 1;
    const packageNameParts = parts.slice(index + 1, index + 1 + packageNameLength);
    if (packageNameParts.length !== packageNameLength || packageNameParts.some((part) => !part)) continue;
    const internalSegment = parts[index + 1 + packageNameLength];
    if (!isPackageInternalSegment(internalSegment)) continue;
    return `${parts.slice(0, index + 1).join("/")}/${packageNameParts.join("/")}`;
  }
  return undefined;
}

function isPackageInternalSegment(segment: string | undefined): boolean {
  return segment === "src" || segment === "dist" || segment === "build" || segment === "internal";
}

function isNormalizedPath(value: NormalizedPath | CtxReadGuardrailOutcome): value is NormalizedPath {
  return "absolutePath" in value;
}

function isRealpathWithinCwd(value: RealpathWithinCwd | CtxReadGuardrailOutcome): value is RealpathWithinCwd {
  return "realNormalizedPath" in value;
}

function ok(kind: "file" | "directory", normalizedPath: string, reason: string): CtxReadGuardrailOutcome {
  return { ok: true, kind, normalizedPath, reason };
}

function invalid(reason: string): CtxReadGuardrailOutcome {
  return { ok: false, kind: "invalid", reason };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}

function normalizeRelativePath(pathText: string): string {
  return pathText.split(sep).join("/").replace(/\/+/g, "/");
}

function normalizeTriggerPrefix(pathText: string): string {
  const normalized = posix.normalize(normalizeRelativePath(pathText)).replace(/^\.\//, "").replace(/\/+$/g, "");
  return normalized === "." ? "" : normalized;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
