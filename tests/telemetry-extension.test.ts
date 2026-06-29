import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_TELEMETRY_ENV_KEYS } from "../src/telemetry-env.js";

const originalEnv = new Map<string, string | undefined>();

function rememberTelemetryEnv() {
  originalEnv.clear();
  for (const key of PI_TELEMETRY_ENV_KEYS) {
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
  it("scrubs stale inherited Pi telemetry env before registering telemetry handlers", async () => {
    rememberTelemetryEnv();
    process.env.PI_TELEMETRY_OWNER_PID = "999999";
    process.env.PI_TELEMETRY_SESSION_ID = "stale-session";
    process.env.PI_TELEMETRY_TRACE_ID = "stale-trace";

    const { default: extension } = await import("../extensions/workflow.js");
    extension(makeMinimalPi());

    for (const key of PI_TELEMETRY_ENV_KEYS) {
      assert.equal(process.env[key], undefined, `${key} should be scrubbed during extension bootstrap`);
    }
  });
});
