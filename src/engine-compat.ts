/**
 * Engine ⇄ repo-artifact compatibility helpers.
 *
 * Repos pin harness artifacts locally (descriptors + workflow scripts), but the
 * engine (`pi-dynamic-workflows`) is loaded at whatever version is installed. These
 * helpers guard *engine behavior* the way `schemaVersion` guards *data shape*:
 * an optional `engine.min` floor on a descriptor warns + skips on load when the
 * running engine is older, mirroring the `schemaVersion` warn+skip gate.
 *
 * Discipline: additive-only in minors; rename/remove only at a major bump paired
 * with a `schemaVersion` bump. See docs/harness-engine-compat.md.
 */

import { readFileSync } from "node:fs";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier (e.g. "rc.1"); a pre-release is lower than the same major.minor.patch release. */
  prerelease?: string;
}

/** Parse a strict `major.minor.patch` with optional pre-release/build suffix (no trailing junk). */
export function parseSemver(input: unknown): Semver | null {
  if (typeof input !== "string") return null;
  const match = input.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (![major, minor, patch].every(Number.isFinite)) return null;
  const prerelease = match[4];
  return prerelease ? { major, minor, patch, prerelease } : { major, minor, patch };
}

export function stringifySemver(version: Semver): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** Returns -1 / 0 / 1. A pre-release is lower than the same major.minor.patch release. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
}

export interface EngineFloorResult {
  ok: boolean;
  reason?: string;
  engineVersion?: Semver;
  floor?: Semver;
}

/**
 * Check a declared `engine.min` floor against the running engine version.
 * A missing/empty floor is always ok (the field is optional).
 */
export function checkEngineFloor(floorInput: unknown, engineVersion: Semver): EngineFloorResult {
  if (floorInput === undefined || floorInput === null || floorInput === "") return { ok: true, engineVersion };
  const floor = parseSemver(floorInput);
  if (!floor) {
    return { ok: false, reason: `Invalid engine.min '${String(floorInput)}': expected a semver string` };
  }
  if (compareSemver(engineVersion, floor) < 0) {
    return {
      ok: false,
      reason: `Engine ${stringifySemver(engineVersion)} is below declared engine.min ${stringifySemver(floor)}`,
      engineVersion,
      floor,
    };
  }
  return { ok: true, engineVersion, floor };
}

/** Read the engine version from a package.json file (best-effort; null on any failure). */
export function readEngineVersionFromFile(packageJsonPath: string): Semver | null {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
    return parseSemver(pkg?.version);
  } catch {
    return null;
  }
}
