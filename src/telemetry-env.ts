export const PI_TELEMETRY_ENV_KEYS = [
  "PI_TELEMETRY_OWNER_PID",
  "PI_TELEMETRY_SESSION_ID",
  "PI_TELEMETRY_TRACE_ID",
] as const;

export type PiTelemetryEnvKey = (typeof PI_TELEMETRY_ENV_KEYS)[number];
export type TelemetryProcessRole = "main" | "subagent";

export interface TelemetryRuntime {
  pid: number;
  ppid: number;
  /** Inject in tests to avoid relying on real process state. */
  isProcessLive?: (pid: number) => boolean;
}

export interface PiTelemetryEnvDecision {
  telemetryProcessRole: TelemetryProcessRole;
  processPid: number;
  parentPid: number;
  ownerPid?: number;
  hasTelemetryEnv: boolean;
  preserve: boolean;
  scrubbed: boolean;
  reason:
    | "absent"
    | "invalid-owner-pid"
    | "owner-is-current-process"
    | "owner-not-live"
    | "missing-session-or-trace"
    | "owner-is-not-parent"
    | "valid-direct-child";
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

export function classifyPiTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
  runtime?: TelemetryRuntime,
): PiTelemetryEnvDecision {
  const pid = runtime?.pid ?? process.pid;
  const ppid = runtime?.ppid ?? (typeof process.ppid === "number" ? process.ppid : 0);
  const checkLive = runtime?.isProcessLive ?? isProcessLive;
  const hasTelemetryEnv = PI_TELEMETRY_ENV_KEYS.some((key) => env[key] != null && env[key] !== "");

  if (!hasTelemetryEnv) {
    return decision("absent", pid, ppid, undefined, false, false, false);
  }

  const ownerPid = parseTelemetryOwnerPid(env.PI_TELEMETRY_OWNER_PID);
  if (ownerPid === undefined) {
    return decision("invalid-owner-pid", pid, ppid, undefined, true, false, false);
  }

  if (ownerPid === pid) {
    return decision("owner-is-current-process", pid, ppid, ownerPid, true, false, false);
  }

  if (!checkLive(ownerPid)) {
    return decision("owner-not-live", pid, ppid, ownerPid, true, false, false);
  }

  if (!nonEmpty(env.PI_TELEMETRY_SESSION_ID) || !nonEmpty(env.PI_TELEMETRY_TRACE_ID)) {
    return decision("missing-session-or-trace", pid, ppid, ownerPid, true, false, false);
  }

  if (ownerPid !== ppid) {
    return decision("owner-is-not-parent", pid, ppid, ownerPid, true, false, false);
  }

  return decision("valid-direct-child", pid, ppid, ownerPid, true, true, false);
}

/** Return true only when inherited telemetry describes this process as a valid direct child/subagent. */
export function shouldPreservePiTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
  runtime?: TelemetryRuntime,
): boolean {
  return classifyPiTelemetryEnv(env, runtime).preserve;
}

/**
 * Delete stale, partial, or unrelated Pi telemetry env vars before telemetry extensions load.
 *
 * Top-level Pi processes launched by supervisors can inherit old PI_TELEMETRY_* values.
 * Preserve them only for a coherent direct-child/subagent launch; otherwise scrub all
 * telemetry linkage keys so the process starts a fresh top-level trace.
 */
export function scrubStalePiTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
  runtime?: TelemetryRuntime,
): PiTelemetryEnvDecision {
  const initial = classifyPiTelemetryEnv(env, runtime);
  if (!initial.hasTelemetryEnv || initial.preserve) return initial;

  for (const key of PI_TELEMETRY_ENV_KEYS) {
    delete env[key];
  }

  return { ...initial, scrubbed: true };
}

function decision(
  reason: PiTelemetryEnvDecision["reason"],
  processPid: number,
  parentPid: number,
  ownerPid: number | undefined,
  hasTelemetryEnv: boolean,
  preserve: boolean,
  scrubbed: boolean,
): PiTelemetryEnvDecision {
  return {
    telemetryProcessRole: preserve ? "subagent" : "main",
    processPid,
    parentPid,
    ownerPid,
    hasTelemetryEnv,
    preserve,
    scrubbed,
    reason,
  };
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
