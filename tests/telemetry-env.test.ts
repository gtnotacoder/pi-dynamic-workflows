import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelemetryRuntime } from "../src/telemetry-env.js";
import {
  classifyPiTelemetryEnv,
  PI_TELEMETRY_ENV_KEYS,
  parseTelemetryOwnerPid,
  scrubStalePiTelemetryEnv,
  shouldPreservePiTelemetryEnv,
} from "../src/telemetry-env.js";

function telemetryEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PI_TELEMETRY_OWNER_PID: "9999",
    PI_TELEMETRY_SESSION_ID: "sess-abc",
    PI_TELEMETRY_TRACE_ID: "trace-xyz",
    ...overrides,
  };
}

function runtime(overrides: Partial<TelemetryRuntime> = {}): TelemetryRuntime {
  return {
    pid: 1000,
    ppid: 2000,
    isProcessLive: () => true,
    ...overrides,
  };
}

function presentTelemetryKeys(env: Record<string, string | undefined>): string[] {
  return PI_TELEMETRY_ENV_KEYS.filter((key) => env[key] != null && env[key] !== "");
}

describe("parseTelemetryOwnerPid", () => {
  it("accepts positive base-10 process ids", () => {
    assert.equal(parseTelemetryOwnerPid("1"), 1);
    assert.equal(parseTelemetryOwnerPid(" 12345 "), 12345);
  });

  it("rejects missing, non-positive, unsafe, and non-base-10 process ids", () => {
    for (const value of [undefined, "", "0", "-1", "1.5", "1e2", "0x10", "12abc"]) {
      assert.equal(parseTelemetryOwnerPid(value), undefined, `expected ${String(value)} to be rejected`);
    }
  });
});

describe("classifyPiTelemetryEnv", () => {
  it("classifies absent telemetry as a main process without scrubbing", () => {
    const env: Record<string, string | undefined> = {};
    const decision = classifyPiTelemetryEnv(env, runtime());

    assert.equal(decision.telemetryProcessRole, "main");
    assert.equal(decision.reason, "absent");
    assert.equal(decision.hasTelemetryEnv, false);
    assert.equal(decision.preserve, false);
    assert.equal(decision.scrubbed, false);
    assert.equal(decision.processPid, 1000);
    assert.equal(decision.parentPid, 2000);
  });

  it("preserves coherent direct-child telemetry and exposes subagent metadata", () => {
    const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "2000" });
    const decision = scrubStalePiTelemetryEnv(env, runtime({ pid: 1000, ppid: 2000 }));

    assert.equal(shouldPreservePiTelemetryEnv(env, runtime({ pid: 1000, ppid: 2000 })), true);
    assert.equal(decision.telemetryProcessRole, "subagent");
    assert.equal(decision.reason, "valid-direct-child");
    assert.equal(decision.ownerPid, 2000);
    assert.equal(decision.processPid, 1000);
    assert.equal(decision.parentPid, 2000);
    assert.equal(decision.preserve, true);
    assert.equal(decision.scrubbed, false);
    assert.deepEqual(presentTelemetryKeys(env), [...PI_TELEMETRY_ENV_KEYS]);
  });

  it("scrubs live but unrelated inherited telemetry so top-level workers start fresh", () => {
    const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "9999" });
    const decision = scrubStalePiTelemetryEnv(env, runtime({ pid: 1000, ppid: 2000, isProcessLive: () => true }));

    assert.equal(decision.telemetryProcessRole, "main");
    assert.equal(decision.reason, "owner-is-not-parent");
    assert.equal(decision.ownerPid, 9999);
    assert.equal(decision.scrubbed, true);
    assert.deepEqual(presentTelemetryKeys(env), []);
  });

  it("scrubs dead owner telemetry even when ownerPid equals parentPid", () => {
    const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "2000" });
    const decision = scrubStalePiTelemetryEnv(env, runtime({ ppid: 2000, isProcessLive: () => false }));

    assert.equal(decision.reason, "owner-not-live");
    assert.equal(decision.scrubbed, true);
    assert.deepEqual(presentTelemetryKeys(env), []);
  });

  it("scrubs partial telemetry rather than keeping orphaned session or trace ids", () => {
    for (const env of [
      telemetryEnv({ PI_TELEMETRY_SESSION_ID: "", PI_TELEMETRY_TRACE_ID: "trace-xyz" }),
      telemetryEnv({ PI_TELEMETRY_SESSION_ID: "sess-abc", PI_TELEMETRY_TRACE_ID: undefined }),
      telemetryEnv({ PI_TELEMETRY_OWNER_PID: undefined, PI_TELEMETRY_SESSION_ID: "sess-abc" }),
    ]) {
      const decision = scrubStalePiTelemetryEnv(env, runtime({ ppid: 2000 }));
      assert.equal(decision.telemetryProcessRole, "main");
      assert.equal(decision.scrubbed, true);
      assert.deepEqual(presentTelemetryKeys(env), []);
    }
  });

  it("scrubs telemetry whose owner pid is this process", () => {
    const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "1000" });
    const decision = scrubStalePiTelemetryEnv(env, runtime({ pid: 1000, ppid: 1000 }));

    assert.equal(decision.reason, "owner-is-current-process");
    assert.equal(decision.scrubbed, true);
    assert.deepEqual(presentTelemetryKeys(env), []);
  });
});
