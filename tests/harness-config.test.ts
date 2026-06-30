import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  loadHarnessConfigRegistry,
  parseHarnessConfigDescriptor,
  registerHarnessConfigsCommand,
  renderHarnessConfigs,
} from "../src/harness-config.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

const legacyDescriptor = JSON.stringify({
  schemaVersion: 1,
  harnessType: "frontend.radix-shadcn",
  name: "React shadcn/ui Radix adversarial PR review",
  description: "FastContext-backed PR adversarial review harness.",
  triggerRules: {
    pathPrefixes: ["components/ui/"],
    importPatterns: ["@radix-ui/react-*"],
  },
});

describe("parseHarnessConfigDescriptor", () => {
  it("maps the legacy frontend.radix-shadcn harnessType to frontend-react-shadcn on pi", () => {
    const config = parseHarnessConfigDescriptor(legacyDescriptor, "user", "frontend.radix-shadcn.json");
    assert.ok(config);
    assert.equal(config.id, "frontend-react-shadcn");
    assert.equal(config.harness_type, "pi");
    assert.equal(config.wired, true);
    assert.equal(config.legacyHarnessType, "frontend.radix-shadcn");
    assert.equal(config.displayName, "React shadcn/ui Radix adversarial PR review");
    assert.match(config.trigger ?? "", /pathPrefixes:1/);
    assert.match(config.trigger ?? "", /importPatterns:1/);
  });

  it("parses canonical harness_config descriptors with unwired runtime placeholders", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "docs", harness_type: "hermes", trigger: "manual" }),
      "project",
      "docs.json",
    );
    assert.ok(config);
    assert.equal(config.id, "docs");
    assert.equal(config.harness_type, "hermes");
    assert.equal(config.wired, false);
    assert.equal(config.trigger, "manual");
  });

  it("returns null for malformed or unsupported descriptors", () => {
    assert.equal(parseHarnessConfigDescriptor("not json", "project"), null);
    assert.equal(parseHarnessConfigDescriptor(JSON.stringify({ schemaVersion: 2, id: "x" }), "project"), null);
  });
});

describe("loadHarnessConfigRegistry", () => {
  function writeJson(dir: string, file: string, content: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), content, "utf-8");
  }

  it("loads user and project configs with project winning on id collision", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-configs-"));
    const projectDir = join(root, "project");
    const userDir = join(root, "user");
    const warnings: string[] = [];
    try {
      writeJson(userDir, "frontend.radix-shadcn.json", legacyDescriptor);
      writeJson(
        projectDir,
        "frontend-react-shadcn.json",
        JSON.stringify({
          schemaVersion: 1,
          id: "frontend-react-shadcn",
          harness_type: "pi",
          displayName: "Project shadcn",
        }),
      );
      writeJson(userDir, "docs.json", JSON.stringify({ schemaVersion: 1, id: "docs", harness_type: "opencode" }));

      const registry = loadHarnessConfigRegistry(root, {
        projectDir,
        userDir,
        onWarning: (message) => warnings.push(message),
      });
      assert.equal(registry.size, 2);
      assert.equal(registry.get("frontend-react-shadcn")?.source, "project");
      assert.equal(registry.get("frontend-react-shadcn")?.displayName, "Project shadcn");
      assert.equal(registry.get("docs")?.source, "user");
      assert.ok(warnings.some((warning) => warning.includes("project descriptor wins")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("renderHarnessConfigs / registerHarnessConfigsCommand", () => {
  it("renders id, harness_type, wired status, trigger, and legacy mapping", () => {
    const config = parseHarnessConfigDescriptor(legacyDescriptor, "user", "frontend.radix-shadcn.json");
    assert.ok(config);
    const out = renderHarnessConfigs(new Map([[config.id, config]]));
    assert.match(out, /harness_config/);
    assert.match(out, /harness_type/);
    assert.match(out, /frontend-react-shadcn/);
    assert.match(out, /pi, wired/);
    assert.match(out, /legacy:frontend\.radix-shadcn/);
  });

  it("registers /harness-configs plus deprecated /profiles alias", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-config-cmd-"));
    const projectDir = join(root, ".pi", "workflows", "harnesses");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "docs.json"), JSON.stringify({ schemaVersion: 1, id: "docs", harness_type: "pi" }));
    try {
      const { pi, commands, sent } = makeCommandRegistryPi();
      registerHarnessConfigsCommand(pi, { cwd: root });
      assert.deepEqual(
        commands.map((command) => command.name).sort((a, b) => a.localeCompare(b)),
        ["harness-configs", "profiles"],
      );
      const handler = commands.find((command) => command.name === "harness-configs")?.handler;
      assert.ok(handler);
      await handler("", makeNotifyCtx().ctx);
      assert.equal(sent.length, 1);
      assert.match(sent[0].content ?? "", /docs/);
      assert.match(sent[0].content ?? "", /pi, wired/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
