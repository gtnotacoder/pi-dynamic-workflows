import assert from "node:assert/strict";
import test from "node:test";
import type { TelemetryRuntime } from "../extensions/workflow.js";
import {
  PI_TELEMETRY_ENV_KEYS,
  scrubStalePiTelemetryEnv,
  shouldPreservePiTelemetryEnv,
} from "../extensions/workflow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a plain-object env fixture pre-filled with telemetry keys. */
function telemetryEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    PI_TELEMETRY_OWNER_PID: "9999",
    PI_TELEMETRY_SESSION_ID: "sess-abc",
    PI_TELEMETRY_TRACE_ID: "trace-xyz",
    ...overrides,
  };
}

/** Count how many of the three telemetry keys are still present & non-empty. */
function presentKeys(env: Record<string, string | undefined>): number {
  return PI_TELEMETRY_ENV_KEYS.filter((k) => env[k] != null && env[k] !== "").length;
}

/** Build a TelemetryRuntime that reports `isProcessLive` as live or dead. */
function runtime(opts: { pid?: number; ppid?: number; isProcessLive?: boolean }): TelemetryRuntime {
  return {
    pid: opts.pid ?? 1000,
    ppid: opts.ppid ?? 2000,
    isProcessLive: () => opts.isProcessLive ?? true,
  };
}

// ---------------------------------------------------------------------------
// 1. Live but unrelated owner PID (ownerPid !== ppid) → scrubbed including session/trace
// ---------------------------------------------------------------------------

test("live but unrelated owner PID is scrubbed including session/trace", () => {
  const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "9999" });
  // pid=1000, ppid=2000, ownerPid=9999 → ownerPid !== ppid
  const rt = runtime({ pid: 1000, ppid: 2000, isProcessLive: true });

  // shouldPreserve returns false because ownerPid !== ppid
  assert.equal(shouldPreservePiTelemetryEnv(env, rt), false);

  // scrubStale deletes all three keys
  scrubStalePiTelemetryEnv(env, rt);
  assert.equal(presentKeys(env), 0, "all telemetry keys should be scrubbed for unrelated owner");
});

// ---------------------------------------------------------------------------
// 2. Valid direct-child telemetry (ownerPid === ppid, live, non-empty session+trace) → preserved
// ---------------------------------------------------------------------------

test("valid direct-child telemetry is preserved and shouldPreserve returns true", () => {
  const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "2000" });
  // pid=1000, ppid=2000, ownerPid=2000 → ownerPid === ppid, process live
  const rt = runtime({ pid: 1000, ppid: 2000, isProcessLive: true });

  // All conditions met
  assert.equal(shouldPreservePiTelemetryEnv(env, rt), true);

  // scrubStale must NOT delete keys
  scrubStalePiTelemetryEnv(env, rt);
  assert.equal(presentKeys(env), 3, "direct-child telemetry should be preserved");
  assert.equal(env.PI_TELEMETRY_OWNER_PID, "2000");
  assert.equal(env.PI_TELEMETRY_SESSION_ID, "sess-abc");
  assert.equal(env.PI_TELEMETRY_TRACE_ID, "trace-xyz");
});

// ---------------------------------------------------------------------------
// 3. Dead owner PID → scrubbed
// ---------------------------------------------------------------------------

test("dead owner PID is scrubbed even if ownerPid === ppid", () => {
  const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "2000" });
  // pid=1000, ppid=2000, ownerPid=2000 → ownerPid === ppid but process is dead
  const rt = runtime({ pid: 1000, ppid: 2000, isProcessLive: false });

  assert.equal(shouldPreservePiTelemetryEnv(env, rt), false);

  scrubStalePiTelemetryEnv(env, rt);
  assert.equal(presentKeys(env), 0, "dead owner PID telemetry should be scrubbed");
});

// ---------------------------------------------------------------------------
// 4. Partial inherited telemetry → scrubbed
// ---------------------------------------------------------------------------

test("owner PID without session/trace is scrubbed (partial telemetry)", () => {
  // Has owner PID but no session/trace
  const env: Record<string, string | undefined> = {
    PI_TELEMETRY_OWNER_PID: "2000",
    PI_TELEMETRY_SESSION_ID: "",
    PI_TELEMETRY_TRACE_ID: "",
  };
  const rt = runtime({ pid: 1000, ppid: 2000, isProcessLive: true });

  assert.equal(shouldPreservePiTelemetryEnv(env, rt), false);

  scrubStalePiTelemetryEnv(env, rt);
  assert.equal(presentKeys(env), 0, "partial telemetry (no session/trace) should be scrubbed");
});

test("trace/session without owner PID is scrubbed (orphaned telemetry)", () => {
  // Has session & trace but no owner PID
  const env: Record<string, string | undefined> = {
    PI_TELEMETRY_OWNER_PID: undefined,
    PI_TELEMETRY_SESSION_ID: "sess-abc",
    PI_TELEMETRY_TRACE_ID: "trace-xyz",
  };
  const rt = runtime({ pid: 1000, ppid: 2000, isProcessLive: true });

  assert.equal(shouldPreservePiTelemetryEnv(env, rt), false);

  scrubStalePiTelemetryEnv(env, rt);
  assert.equal(presentKeys(env), 0, "orphaned telemetry (no owner PID) should be scrubbed");
});

test("session only, no owner or trace → scrubbed", () => {
  const env: Record<string, string | undefined> = {
    PI_TELEMETRY_OWNER_PID: undefined,
    PI_TELEMETRY_SESSION_ID: "sess-abc",
    PI_TELEMETRY_TRACE_ID: undefined,
  };
  const rt = runtime({ pid: 1000, ppid: 2000, isProcessLive: true });

  assert.equal(shouldPreservePiTelemetryEnv(env, rt), false);

  scrubStalePiTelemetryEnv(env, rt);
  assert.equal(presentKeys(env), 0, "lone session ID should be scrubbed");
});
