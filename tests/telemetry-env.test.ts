import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelemetryRuntime } from "../src/telemetry-env.js";
import {
  classifyPiTelemetryEnv,
  HINDSIGHT_API_URL_KEY,
  normalizeHindsightApiUrlEnv,
  PI_TELEMETRY_ENV_KEYS,
  PI_TELEMETRY_PROCESS_ROLE_KEY,
  PI_TELEMETRY_SUBAGENT_DETAIL_KEYS,
  PI_TELEMETRY_SUBAGENT_ROLE,
  parseTelemetryOwnerPid,
  prepareSupervisorTelemetryEnv,
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
  return PI_TELEMETRY_ENV_KEYS.filter((key) => env[key] !== undefined && env[key] !== "");
}

function presentSubagentDetailKeys(env: Record<string, string | undefined>): string[] {
  return PI_TELEMETRY_SUBAGENT_DETAIL_KEYS.filter((key) => env[key] !== undefined && env[key] !== "");
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

describe("supervisor telemetry env policy", () => {
  it("removes blank HINDSIGHT_API_URL instead of passing a noisy empty override", () => {
    const env: Record<string, string | undefined> = { [HINDSIGHT_API_URL_KEY]: "" };

    const action = normalizeHindsightApiUrlEnv(env);

    assert.equal(action, "removed-blank");
    assert.equal(env[HINDSIGHT_API_URL_KEY], undefined);
  });

  it("preserves or injects non-empty HINDSIGHT_API_URL values", () => {
    const inherited: Record<string, string | undefined> = { [HINDSIGHT_API_URL_KEY]: " http://10.100.0.100:8888 " };
    assert.equal(normalizeHindsightApiUrlEnv(inherited), "preserved");
    assert.equal(inherited[HINDSIGHT_API_URL_KEY], " http://10.100.0.100:8888 ");

    const injected: Record<string, string | undefined> = {};
    assert.equal(normalizeHindsightApiUrlEnv(injected, " http://10.100.0.100:8888 "), "set");
    assert.equal(injected[HINDSIGHT_API_URL_KEY], "http://10.100.0.100:8888");
  });

  it("prepares supervisor env with conservative Pi scrub plus secret-safe Langfuse booleans", () => {
    const env = telemetryEnv({
      PI_TELEMETRY_OWNER_PID: "9999",
      HINDSIGHT_API_URL: "",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_INCLUDE_PAYLOADS: "true",
    });

    const decision = prepareSupervisorTelemetryEnv(env);

    assert.equal(decision.hindsightApiUrlAction, "removed-blank");
    assert.equal(env.HINDSIGHT_API_URL, undefined);
    assert.equal(decision.piTelemetry.scrubbed, true);
    assert.deepEqual(presentTelemetryKeys(env), []);
    assert.deepEqual(decision.langfuse, {
      publicKeyPresent: true,
      secretKeyPresent: true,
      endpointConfigured: false,
      includePayloads: true,
    });
  });

  it("reports endpointConfigured only when an explicit Langfuse endpoint is set", () => {
    const env: Record<string, string | undefined> = {
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_BASE_URL: "https://langfuse.example.test",
    };

    assert.equal(prepareSupervisorTelemetryEnv(env).langfuse.endpointConfigured, true);
  });

  it("scrubs supervisor telemetry even when it is valid for the supervisor process", () => {
    const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "2000" });

    const decision = prepareSupervisorTelemetryEnv(env);

    assert.equal(decision.piTelemetry.scrubbed, true);
    assert.notEqual(decision.piTelemetry.reason, "valid-direct-child");
    assert.deepEqual(presentTelemetryKeys(env), []);
  });

  it("can preserve telemetry when a real child runtime is supplied", () => {
    const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "2000" });

    const decision = prepareSupervisorTelemetryEnv(env, { childRuntime: runtime({ pid: 1000, ppid: 2000 }) });

    assert.equal(decision.piTelemetry.reason, "valid-direct-child");
    assert.equal(decision.piTelemetry.preserve, true);
    assert.equal(decision.piTelemetry.scrubbed, false);
    assert.deepEqual(presentTelemetryKeys(env), [...PI_TELEMETRY_ENV_KEYS]);
  });
});

describe("classifyPiTelemetryEnv", () => {
  it("classifies absent telemetry as a main process without scrubbing", () => {
    const env: Record<string, string | undefined> = {};
    const decision = classifyPiTelemetryEnv(env, runtime());

    assert.equal(decision.telemetryProcessRole, "main");
    assert.equal(decision.reason, "absent");
    assert.equal(decision.hasTelemetryEnv, false);
    assert.equal(decision.hasSubagentMarker, false);
    assert.equal(decision.preserve, false);
    assert.equal(decision.scrubbed, false);
    assert.equal(decision.processPid, 1000);
    assert.equal(decision.parentPid, 2000);
  });

  it("preserves the existing direct-child telemetry contract without requiring a marker", () => {
    const env = telemetryEnv({
      PI_TELEMETRY_OWNER_PID: "2000",
      PI_SUBAGENT_CHILD_AGENT: "child-agent",
      PI_TELEMETRY_SUBAGENT_NAME: "child-name",
      PI_TELEMETRY_SUBAGENT_AGENT: "child-kind",
    });
    const rt = runtime({ pid: 1000, ppid: 2000 });
    const decision = scrubStalePiTelemetryEnv(env, rt);

    assert.equal(shouldPreservePiTelemetryEnv(env, rt), true);
    assert.equal(decision.telemetryProcessRole, "subagent");
    assert.equal(decision.reason, "valid-direct-child");
    assert.equal(decision.ownerPid, 2000);
    assert.equal(decision.hasSubagentMarker, false);
    assert.equal(decision.preserve, true);
    assert.equal(decision.scrubbed, false);
    assert.deepEqual(presentTelemetryKeys(env), [...PI_TELEMETRY_ENV_KEYS]);
    assert.deepEqual(presentSubagentDetailKeys(env), [...PI_TELEMETRY_SUBAGENT_DETAIL_KEYS]);
  });

  it("preserves direct-child telemetry when an explicit subagent marker is present", () => {
    const env = telemetryEnv({
      PI_TELEMETRY_OWNER_PID: "2000",
      [PI_TELEMETRY_PROCESS_ROLE_KEY]: PI_TELEMETRY_SUBAGENT_ROLE,
    });
    const rt = runtime({ pid: 1000, ppid: 2000 });
    const decision = scrubStalePiTelemetryEnv(env, rt);

    assert.equal(shouldPreservePiTelemetryEnv(env, rt), true);
    assert.equal(decision.telemetryProcessRole, "subagent");
    assert.equal(decision.reason, "valid-direct-child");
    assert.equal(decision.ownerPid, 2000);
    assert.equal(decision.processPid, 1000);
    assert.equal(decision.parentPid, 2000);
    assert.equal(decision.hasSubagentMarker, true);
    assert.equal(decision.preserve, true);
    assert.equal(decision.scrubbed, false);
    assert.deepEqual(presentTelemetryKeys(env), [...PI_TELEMETRY_ENV_KEYS]);
    assert.equal(env[PI_TELEMETRY_PROCESS_ROLE_KEY], PI_TELEMETRY_SUBAGENT_ROLE);
  });

  it("preserves marked descendants launched through shell or supervisor wrappers", () => {
    const env = telemetryEnv({
      PI_TELEMETRY_OWNER_PID: "9999",
      [PI_TELEMETRY_PROCESS_ROLE_KEY]: PI_TELEMETRY_SUBAGENT_ROLE,
    });
    const decision = scrubStalePiTelemetryEnv(
      env,
      runtime({
        pid: 1000,
        ppid: 2000,
        isProcessLive: () => true,
        isProcessAncestor: (ancestorPid, descendantPid) => ancestorPid === 9999 && descendantPid === 2000,
      }),
    );

    assert.equal(decision.telemetryProcessRole, "subagent");
    assert.equal(decision.reason, "valid-marked-descendant");
    assert.equal(decision.ownerPid, 9999);
    assert.equal(decision.hasSubagentMarker, true);
    assert.equal(decision.preserve, true);
    assert.equal(decision.scrubbed, false);
    assert.deepEqual(presentTelemetryKeys(env), [...PI_TELEMETRY_ENV_KEYS]);
  });

  it("scrubs inherited markers when the live owner is not in the process ancestry", () => {
    const env = telemetryEnv({
      PI_TELEMETRY_OWNER_PID: "9999",
      [PI_TELEMETRY_PROCESS_ROLE_KEY]: PI_TELEMETRY_SUBAGENT_ROLE,
    });
    const decision = scrubStalePiTelemetryEnv(
      env,
      runtime({
        pid: 1000,
        ppid: 2000,
        isProcessLive: () => true,
        isProcessAncestor: () => false,
      }),
    );

    assert.equal(decision.telemetryProcessRole, "main");
    assert.equal(decision.reason, "owner-is-not-ancestor");
    assert.equal(decision.ownerPid, 9999);
    assert.equal(decision.hasSubagentMarker, true);
    assert.equal(decision.scrubbed, true);
    assert.deepEqual(presentTelemetryKeys(env), []);
    assert.equal(env[PI_TELEMETRY_PROCESS_ROLE_KEY], undefined);
  });

  it("also accepts an explicit runtime launch-path allowlist for intended subagents", () => {
    const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "9999" });
    const decision = scrubStalePiTelemetryEnv(
      env,
      runtime({ pid: 1000, ppid: 2000, isIntendedSubagent: true, isProcessLive: () => true }),
    );

    assert.equal(decision.telemetryProcessRole, "subagent");
    assert.equal(decision.reason, "valid-marked-descendant");
    assert.equal(decision.hasSubagentMarker, true);
    assert.equal(decision.preserve, true);
    assert.equal(decision.scrubbed, false);
  });

  it("scrubs live but unrelated inherited telemetry so top-level workers start fresh", () => {
    const env = telemetryEnv({ PI_TELEMETRY_OWNER_PID: "9999" });
    const decision = scrubStalePiTelemetryEnv(env, runtime({ pid: 1000, ppid: 2000, isProcessLive: () => true }));

    assert.equal(decision.telemetryProcessRole, "main");
    assert.equal(decision.reason, "owner-is-not-parent");
    assert.equal(decision.ownerPid, 9999);
    assert.equal(decision.hasSubagentMarker, false);
    assert.equal(decision.scrubbed, true);
    assert.deepEqual(presentTelemetryKeys(env), []);
  });

  it("scrubs marker-only telemetry environments", () => {
    const env: Record<string, string | undefined> = {
      [PI_TELEMETRY_PROCESS_ROLE_KEY]: PI_TELEMETRY_SUBAGENT_ROLE,
    };
    const decision = scrubStalePiTelemetryEnv(env, runtime());

    assert.equal(decision.telemetryProcessRole, "main");
    assert.equal(decision.reason, "invalid-owner-pid");
    assert.equal(decision.hasTelemetryEnv, true);
    assert.equal(decision.hasSubagentMarker, true);
    assert.equal(decision.scrubbed, true);
    assert.equal(env[PI_TELEMETRY_PROCESS_ROLE_KEY], undefined);
  });

  it("scrubs subagent detail-only telemetry environments", () => {
    const env: Record<string, string | undefined> = {
      PI_SUBAGENT_CHILD_AGENT: "stale-child",
      PI_TELEMETRY_SUBAGENT_NAME: "stale-name",
      PI_TELEMETRY_SUBAGENT_AGENT: "stale-agent",
    };
    const decision = scrubStalePiTelemetryEnv(env, runtime());

    assert.equal(decision.telemetryProcessRole, "main");
    assert.equal(decision.reason, "invalid-owner-pid");
    assert.equal(decision.hasTelemetryEnv, true);
    assert.equal(decision.hasSubagentMarker, false);
    assert.equal(decision.scrubbed, true);
    assert.deepEqual(presentSubagentDetailKeys(env), []);
  });

  it("scrubs inherited subagent detail variables with stale telemetry", () => {
    const env = telemetryEnv({
      PI_SUBAGENT_CHILD_AGENT: "stale-child",
      PI_TELEMETRY_SUBAGENT_NAME: "stale-name",
      PI_TELEMETRY_SUBAGENT_AGENT: "stale-agent",
    });
    const decision = scrubStalePiTelemetryEnv(env, runtime({ pid: 1000, ppid: 2000, isProcessLive: () => true }));

    assert.equal(decision.telemetryProcessRole, "main");
    assert.equal(decision.reason, "owner-is-not-parent");
    assert.equal(decision.scrubbed, true);
    assert.deepEqual(presentTelemetryKeys(env), []);
    assert.deepEqual(presentSubagentDetailKeys(env), []);
  });

  it("scrubs dead owner telemetry even when ownerPid equals parentPid", () => {
    const env = telemetryEnv({
      PI_TELEMETRY_OWNER_PID: "2000",
      [PI_TELEMETRY_PROCESS_ROLE_KEY]: PI_TELEMETRY_SUBAGENT_ROLE,
    });
    const decision = scrubStalePiTelemetryEnv(env, runtime({ ppid: 2000, isProcessLive: () => false }));

    assert.equal(decision.reason, "owner-not-live");
    assert.equal(decision.scrubbed, true);
    assert.deepEqual(presentTelemetryKeys(env), []);
    assert.equal(env[PI_TELEMETRY_PROCESS_ROLE_KEY], undefined);
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
