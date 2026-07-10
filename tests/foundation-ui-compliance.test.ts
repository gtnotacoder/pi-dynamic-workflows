import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBundledFoundationUiComplianceWorkflow } from "../src/foundation-ui-compliance.js";
import { registerAllSavedWorkflows } from "../src/saved-commands.js";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { makeCommandRegistryPi } from "./helpers/mock-pi.js";

const baseArgs = {
  appSrc: "web/src",
  foundation: "third_party/frontend-foundation",
  editAllow: ["web/src/**"],
  maxRounds: 1,
};

test("bundled Foundation UI workflow loads the canonical package template", () => {
  const workflow = createBundledFoundationUiComplianceWorkflow();
  const { meta, body } = parseWorkflowScript(workflow.script);

  assert.equal(workflow.name, "foundation_ui_compliance");
  assert.equal(meta.name, "foundation_ui_compliance");
  assert.deepEqual(
    meta.phases?.map((phase) => phase.title),
    ["Gate-Diagnose", "Fix <-> Re-gate loop", "Visual verify", "Deliver", "Trace-assert"],
  );
  assert.match(body, /Delivery blocked because the final re-gate did not clear all failures/);
});

test("npm package allowlist includes executable workflow templates", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    files?: string[];
  };
  assert.ok(packageJson.files?.includes("docs/**/*.mjs"));
});

test("fresh storage registers the bundled /foundation_ui_compliance command without writing user files", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "foundation-ui-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "foundation-ui-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const storage = createWorkflowStorage(cwd, [createBundledFoundationUiComplianceWorkflow()]);
      const { pi, commands } = makeCommandRegistryPi();
      registerAllSavedWorkflows(pi, cwd, storage);

      assert.ok(commands.some((command) => command.name === "foundation_ui_compliance"));
      assert.equal(storage.load("foundation_ui_compliance")?.location, "bundled");
      assert.equal(existsSync(join(home, ".pi", "workflows", "saved")), false);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("workflow extension registers /foundation_ui_compliance in a fresh home", async () => {
  const home = mkdtempSync(join(tmpdir(), "foundation-ui-extension-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const commands = new Set<string>();
      const pi = {
        getCommands: () => [...commands].map((name) => ({ name })),
        registerCommand: (name: string) => commands.add(name),
        registerTool: () => {},
        on: () => {},
        getActiveTools: () => [],
        setActiveTools: () => {},
        sendMessage: () => {},
      } as unknown as ExtensionAPI;
      const { default: extension } = await import("../extensions/workflow.js");

      extension(pi);

      assert.ok(commands.has("foundation_ui_compliance"));
      assert.equal(existsSync(join(home, ".pi", "workflows", "saved")), false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Foundation UI workflow skips fixes and delivery when the initial gates are already clean", async () => {
  const labels: string[] = [];
  const logs: string[] = [];

  await runWorkflow(createBundledFoundationUiComplianceWorkflow().script, {
    args: { ...baseArgs, deliver: true },
    persistLogs: false,
    onLog: (message) => logs.push(message),
    agent: {
      async run(_prompt: string, options: { label?: string }): Promise<string> {
        const label = options.label ?? "";
        labels.push(label);
        return label === "gate-diagnose" ? "CLEAN" : "PASS";
      },
    },
  });

  assert.deepEqual(labels, ["gate-diagnose", "trace-assert"]);
  assert.ok(logs.some((message) => message.includes("no fixes to deliver")));
});

test("Foundation UI workflow blocks visual verification and delivery while gates remain red", async () => {
  const labels: string[] = [];
  const phases: string[] = [];
  const logs: string[] = [];

  await runWorkflow(createBundledFoundationUiComplianceWorkflow().script, {
    args: { ...baseArgs, urls: ["http://localhost:4173"], deliver: true },
    persistLogs: false,
    onPhase: (title) => phases.push(title),
    onLog: (message) => logs.push(message),
    agent: {
      async run(_prompt: string, options: { label?: string }): Promise<string> {
        const label = options.label ?? "";
        labels.push(label);
        if (label === "gate-diagnose") return "must-fix: token violation";
        if (label.startsWith("regate-round-")) return "still red";
        return "PASS";
      },
    },
  });

  assert.deepEqual(labels, ["gate-diagnose", "fix-round-1", "regate-round-1", "trace-assert"]);
  assert.deepEqual(phases, ["Gate-Diagnose", "Fix <-> Re-gate loop", "Visual verify", "Deliver", "Trace-assert"]);
  assert.ok(logs.some((message) => message.includes("Delivery blocked")));
});

test("Foundation UI workflow may visually verify and deliver only after a successful re-gate", async () => {
  const labels: string[] = [];

  await runWorkflow(createBundledFoundationUiComplianceWorkflow().script, {
    args: { ...baseArgs, urls: ["http://localhost:4173"], deliver: true },
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { label?: string }): Promise<string> {
        const label = options.label ?? "";
        labels.push(label);
        if (label === "gate-diagnose") return "must-fix: token violation";
        if (label.startsWith("regate-round-")) return "ALL-CLEAR";
        return "PASS";
      },
    },
  });

  assert.deepEqual(labels, [
    "gate-diagnose",
    "fix-round-1",
    "regate-round-1",
    "visual-verify",
    "deliver",
    "trace-assert",
  ]);
});
