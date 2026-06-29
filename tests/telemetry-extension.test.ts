import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_TELEMETRY_ENV_KEYS, PI_TELEMETRY_PROCESS_ROLE_KEY } from "../src/telemetry-env.js";

const TEST_ENV_KEYS = [...PI_TELEMETRY_ENV_KEYS, PI_TELEMETRY_PROCESS_ROLE_KEY] as const;
const originalEnv = new Map<string, string | undefined>();

function rememberTelemetryEnv() {
  originalEnv.clear();
  for (const key of TEST_ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
  }
}

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeMinimalPi(): ExtensionAPI {
  const commands = new Set<string>();
  return {
    getCommands: () => [...commands].map((name) => ({ name })),
    registerCommand: (name: string) => {
      commands.add(name);
    },
    registerTool: () => {},
    on: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
}

describe("workflow extension telemetry bootstrap", () => {
  it("scrubs stale inherited Pi telemetry env during workflow extension bootstrap", async () => {
    rememberTelemetryEnv();
    process.env.PI_TELEMETRY_OWNER_PID = "999999";
    process.env.PI_TELEMETRY_SESSION_ID = "stale-session";
    process.env.PI_TELEMETRY_TRACE_ID = "stale-trace";
    process.env[PI_TELEMETRY_PROCESS_ROLE_KEY] = "subagent";

    const { default: extension } = await import("../extensions/workflow.js");
    extension(makeMinimalPi());

    for (const key of TEST_ENV_KEYS) {
      assert.equal(process.env[key], undefined, `${key} should be scrubbed during extension bootstrap`);
    }
  });
});
