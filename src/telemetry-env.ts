import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const PI_TELEMETRY_ENV_KEYS = [
  "PI_TELEMETRY_OWNER_PID",
  "PI_TELEMETRY_SESSION_ID",
  "PI_TELEMETRY_TRACE_ID",
] as const;

export const PI_TELEMETRY_PROCESS_ROLE_KEY = "PI_TELEMETRY_PROCESS_ROLE" as const;
export const PI_TELEMETRY_SUBAGENT_ROLE = "subagent" as const;
export const PI_TELEMETRY_SUBAGENT_DETAIL_KEYS = [
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_TELEMETRY_SUBAGENT_NAME",
  "PI_TELEMETRY_SUBAGENT_AGENT",
] as const;
export const HINDSIGHT_API_URL_KEY = "HINDSIGHT_API_URL" as const;
export const LANGFUSE_CREDENTIAL_ENV_KEYS = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"] as const;
export const LANGFUSE_ENDPOINT_ENV_KEYS = ["LANGFUSE_BASE_URL", "LANGFUSE_BASEURL", "LANGFUSE_HOST"] as const;

const PI_TELEMETRY_SCRUB_KEYS = [
  ...PI_TELEMETRY_ENV_KEYS,
  PI_TELEMETRY_PROCESS_ROLE_KEY,
  ...PI_TELEMETRY_SUBAGENT_DETAIL_KEYS,
] as const;

export type PiTelemetryEnvKey = (typeof PI_TELEMETRY_ENV_KEYS)[number];
export type TelemetryProcessRole = "main" | "subagent";

export interface TelemetryRuntime {
  pid: number;
  ppid: number;
  /** Inject in tests to avoid relying on real process state. */
  isProcessLive?: (pid: number) => boolean;
  /** Inject in tests or launchers that know a wrapper/supervisor ancestry. */
  isProcessAncestor?: (ancestorPid: number, descendantPid: number) => boolean;
  /** Explicit launch-path allowlist for a known telemetry subagent. */
  isIntendedSubagent?: boolean;
}

export type HindsightApiUrlAction = "absent" | "preserved" | "set" | "removed-blank";

export interface SupervisorTelemetryEnvDecision {
  piTelemetry: PiTelemetryEnvDecision;
  hindsightApiUrlAction: HindsightApiUrlAction;
  langfuse: {
    publicKeyPresent: boolean;
    secretKeyPresent: boolean;
    endpointConfigured: boolean;
    includePayloads: boolean;
  };
}

export interface SupervisorTelemetryEnvOptions {
  /** Optional non-empty URL to inject for supervised sessions. Empty values are treated as absent. */
  hindsightApiUrl?: string | null;
  /**
   * Runtime for the child Pi process whose env is being prepared. Omit this when
   * preparing env before spawn; inherited PI_TELEMETRY_* is then scrubbed
   * conservatively because the future child PID/parentage cannot be proven yet.
   */
  childRuntime?: TelemetryRuntime;
}

export interface PiTelemetryEnvDecision {
  telemetryProcessRole: TelemetryProcessRole;
  processPid: number;
  parentPid: number;
  ownerPid?: number;
  hasTelemetryEnv: boolean;
  hasSubagentMarker: boolean;
  preserve: boolean;
  scrubbed: boolean;
  reason:
    | "absent"
    | "invalid-owner-pid"
    | "owner-is-current-process"
    | "owner-not-live"
    | "missing-session-or-trace"
    | "owner-is-not-parent"
    | "owner-is-not-ancestor"
    | "valid-direct-child"
    | "valid-marked-descendant";
}

/** Parse a PID string, returning a positive base-10 integer or undefined. */
export function parseTelemetryOwnerPid(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[1-9]\d*$/.test(trimmed)) return undefined;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

/** Check whether a process with the given PID is live; EPERM means live but inaccessible. */
export function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

/**
 * Return true when `ancestorPid` is in `descendantPid`'s OS parent chain.
 *
 * This lets marked telemetry children launched through wrappers preserve the
 * parent trace without trusting a marker inherited from an unrelated live Pi
 * process. On platforms without `/proc`, this falls back to `ps` when
 * available; direct-child compatibility still works through `ownerPid === ppid`.
 */
export function isProcessAncestor(ancestorPid: number, descendantPid: number): boolean {
  const seen = new Set<number>();
  let current: number | undefined = descendantPid;

  while (current !== undefined && current > 1 && !seen.has(current)) {
    if (current === ancestorPid) return true;
    seen.add(current);
    current = readParentPid(current);
  }

  return false;
}

export function classifyPiTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
  runtime?: TelemetryRuntime,
): PiTelemetryEnvDecision {
  const pid = runtime?.pid ?? process.pid;
  const ppid = runtime?.ppid ?? (typeof process.ppid === "number" ? process.ppid : 0);
  const checkLive = runtime?.isProcessLive ?? isProcessLive;
  const checkAncestor = runtime?.isProcessAncestor ?? isProcessAncestor;
  const hasTelemetryLinkage = PI_TELEMETRY_ENV_KEYS.some((key) => env[key] !== undefined && env[key] !== "");
  const hasSubagentMarker = isExplicitTelemetrySubagent(env, runtime);
  const hasSubagentDetails = PI_TELEMETRY_SUBAGENT_DETAIL_KEYS.some((key) => env[key] !== undefined && env[key] !== "");
  const hasTelemetryEnv = hasTelemetryLinkage || hasSubagentMarker || hasSubagentDetails;

  if (!hasTelemetryEnv) {
    return decision("absent", pid, ppid, undefined, false, hasSubagentMarker, false, false);
  }

  const ownerPid = parseTelemetryOwnerPid(env.PI_TELEMETRY_OWNER_PID);
  if (ownerPid === undefined) {
    return decision("invalid-owner-pid", pid, ppid, undefined, true, hasSubagentMarker, false, false);
  }

  if (ownerPid === pid) {
    return decision("owner-is-current-process", pid, ppid, ownerPid, true, hasSubagentMarker, false, false);
  }

  if (!checkLive(ownerPid)) {
    return decision("owner-not-live", pid, ppid, ownerPid, true, hasSubagentMarker, false, false);
  }

  if (!nonEmpty(env.PI_TELEMETRY_SESSION_ID) || !nonEmpty(env.PI_TELEMETRY_TRACE_ID)) {
    return decision("missing-session-or-trace", pid, ppid, ownerPid, true, hasSubagentMarker, false, false);
  }

  if (ownerPid === ppid) {
    return decision("valid-direct-child", pid, ppid, ownerPid, true, hasSubagentMarker, true, false);
  }

  if (!hasSubagentMarker) {
    return decision("owner-is-not-parent", pid, ppid, ownerPid, true, false, false, false);
  }

  if (runtime?.isIntendedSubagent === true || checkAncestor(ownerPid, ppid)) {
    return decision("valid-marked-descendant", pid, ppid, ownerPid, true, true, true, false);
  }

  return decision("owner-is-not-ancestor", pid, ppid, ownerPid, true, true, false, false);
}

/** Return true only when inherited telemetry describes a compatible direct-child or marked subagent launch. */
export function shouldPreservePiTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
  runtime?: TelemetryRuntime,
): boolean {
  return classifyPiTelemetryEnv(env, runtime).preserve;
}

/**
 * Delete stale, partial, or unrelated Pi telemetry env vars before telemetry extensions load.
 *
 * If @amaster.ai/pi-telemetry is installed separately, this package must be
 * loaded first; that extension snapshots PI_TELEMETRY_* during its factory.
 *
 * Top-level Pi processes launched by supervisors can inherit old PI_TELEMETRY_* values.
 * Preserve them only for a coherent legacy direct-child launch, a marked owner
 * in the current process ancestry, or an injected fresh launch-path allowlist;
 * otherwise scrub all telemetry linkage keys so the process starts a fresh
 * top-level trace.
 */
export function scrubStalePiTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
  runtime?: TelemetryRuntime,
): PiTelemetryEnvDecision {
  const initial = classifyPiTelemetryEnv(env, runtime);
  if (!initial.hasTelemetryEnv || initial.preserve) return initial;

  for (const key of PI_TELEMETRY_SCRUB_KEYS) {
    delete env[key];
  }

  return { ...initial, scrubbed: true };
}

/**
 * Normalize telemetry-related env before launching a supervised tmux/workflow Pi session.
 *
 * Policy:
 * - never pass `HINDSIGHT_API_URL=` as a blank override; delete it so Hindsight can
 *   use normal config discovery, or inject an explicit non-empty URL;
 * - scrub inherited PI_TELEMETRY_* before spawn unless an explicit childRuntime proves
 *   the env belongs to that child;
 * - report only boolean Langfuse presence so runbooks can diagnose setup without
 *   printing secrets.
 */
export function prepareSupervisorTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
  options: SupervisorTelemetryEnvOptions = {},
): SupervisorTelemetryEnvDecision {
  const hindsightApiUrlAction = normalizeHindsightApiUrlEnv(env, options.hindsightApiUrl);
  const piTelemetry = options.childRuntime
    ? scrubStalePiTelemetryEnv(env, options.childRuntime)
    : scrubPiTelemetryEnvForUnknownSupervisorChild(env);
  return {
    piTelemetry,
    hindsightApiUrlAction,
    langfuse: summarizeLangfuseEnv(env),
  };
}

export function normalizeHindsightApiUrlEnv(
  env: Record<string, string | undefined> = process.env,
  overrideUrl?: string | null,
): HindsightApiUrlAction {
  const override = overrideUrl?.trim();
  if (override) {
    env[HINDSIGHT_API_URL_KEY] = override;
    return "set";
  }

  const current = env[HINDSIGHT_API_URL_KEY];
  if (current === undefined) return "absent";
  if (current.trim()) return "preserved";
  delete env[HINDSIGHT_API_URL_KEY];
  return "removed-blank";
}

function scrubPiTelemetryEnvForUnknownSupervisorChild(env: Record<string, string | undefined>): PiTelemetryEnvDecision {
  const initial = classifyPiTelemetryEnv(env, {
    pid: 0,
    ppid: 0,
    isProcessLive: () => true,
    isProcessAncestor: () => false,
  });
  if (!initial.hasTelemetryEnv) return initial;
  for (const key of PI_TELEMETRY_SCRUB_KEYS) {
    delete env[key];
  }
  return { ...initial, telemetryProcessRole: "main", preserve: false, scrubbed: true };
}

function summarizeLangfuseEnv(env: Record<string, string | undefined>): SupervisorTelemetryEnvDecision["langfuse"] {
  return {
    publicKeyPresent: nonEmpty(env.LANGFUSE_PUBLIC_KEY),
    secretKeyPresent: nonEmpty(env.LANGFUSE_SECRET_KEY),
    endpointConfigured: LANGFUSE_ENDPOINT_ENV_KEYS.some((key) => nonEmpty(env[key])),
    includePayloads: ["1", "true", "yes", "on"].includes(env.LANGFUSE_INCLUDE_PAYLOADS?.trim().toLowerCase() ?? ""),
  };
}

function decision(
  reason: PiTelemetryEnvDecision["reason"],
  processPid: number,
  parentPid: number,
  ownerPid: number | undefined,
  hasTelemetryEnv: boolean,
  hasSubagentMarker: boolean,
  preserve: boolean,
  scrubbed: boolean,
): PiTelemetryEnvDecision {
  return {
    telemetryProcessRole: preserve ? "subagent" : "main",
    processPid,
    parentPid,
    ownerPid,
    hasTelemetryEnv,
    hasSubagentMarker,
    preserve,
    scrubbed,
    reason,
  };
}

function isExplicitTelemetrySubagent(
  env: Record<string, string | undefined>,
  runtime: TelemetryRuntime | undefined,
): boolean {
  if (runtime?.isIntendedSubagent === true) return true;
  return env[PI_TELEMETRY_PROCESS_ROLE_KEY]?.trim().toLowerCase() === PI_TELEMETRY_SUBAGENT_ROLE;
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function readParentPid(pid: number): number | undefined {
  return readParentPidFromProc(pid) ?? readParentPidFromPs(pid);
}

function readParentPidFromProc(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return undefined;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    return parseTelemetryOwnerPid(fields[1]);
  } catch {
    return undefined;
  }
}

function readParentPidFromPs(pid: number): number | undefined {
  if (process.platform === "win32") return undefined;

  try {
    const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return parseTelemetryOwnerPid(output.trim());
  } catch {
    return undefined;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
