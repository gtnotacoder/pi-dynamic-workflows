import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  expandHarnessConfig,
  extractHarnessConfigFlag,
  extractHarnessTypeFlag,
  loadHarnessConfigRegistry,
  parseHarnessConfigDescriptor,
  registerHarnessConfigsCommand,
  renderHarnessConfigs,
  resolveHarnessLayers,
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

  it("accepts deprecated harness/profile descriptor aliases", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, profile: "legacy-docs", harness: "opencode" }),
      "project",
      "legacy.json",
    );
    assert.ok(config);
    assert.equal(config.id, "legacy-docs");
    assert.equal(config.harness_type, "opencode");
  });

  it("returns null for malformed or unsupported descriptors", () => {
    assert.equal(parseHarnessConfigDescriptor("not json", "project"), null);
    assert.equal(parseHarnessConfigDescriptor(JSON.stringify({ schemaVersion: 2, id: "x" }), "project"), null);
  });

  it("keeps unknown explicit harness runtimes invalid instead of treating them as wired pi", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "typo", harness_type: "p1" }),
      "project",
    );
    assert.ok(config);
    assert.equal(config.id, "typo");
    assert.equal(config.harness_type, "pi");
    assert.equal(config.wired, false);
    assert.equal(config.invalid, true);
    assert.match(config.invalidReason ?? "", /Unknown harness_type 'p1'/);

    const legacy = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "typo", harness: "future" }),
      "project",
    );
    assert.ok(legacy?.invalid);
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

  it("warns on deprecated harness/profile descriptor aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-configs-"));
    const projectDir = join(root, "project");
    const warnings: string[] = [];
    try {
      writeJson(
        projectDir,
        "legacy.json",
        JSON.stringify({ schemaVersion: 1, profile: "legacy-docs", harness: "opencode" }),
      );

      const registry = loadHarnessConfigRegistry(root, {
        projectDir,
        userDir: projectDir,
        onWarning: (message) => warnings.push(message),
      });
      assert.equal(registry.get("legacy-docs")?.harness_type, "opencode");
      assert.ok(warnings.some((warning) => warning.includes("'profile'")));
      assert.ok(warnings.some((warning) => warning.includes("'harness'")));
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
    assert.match(out, /React shadcn\/ui Radix adversarial PR review/);
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

describe("expandHarnessConfig", () => {
  it("leaves omitted optional context booleans undefined so defaults can inherit", () => {
    const config = parseHarnessConfigDescriptor(JSON.stringify({ schemaVersion: 1, id: "minimal" }), "project");
    assert.ok(config);

    const expanded = expandHarnessConfig({ harness_config: "minimal", registry: new Map([[config.id, config]]) });

    assert.equal(expanded.contextMode, undefined);
    assert.equal(expanded.inheritProjectContext, undefined);
    assert.equal(expanded.inheritSkills, undefined);
    assert.equal(expanded.inheritMainRules, undefined);
  });
});

// ── resolveHarnessLayers: precedence / inheritance ──────────────────────────

describe("resolveHarnessLayers", () => {
  it("higher-index layer wins", () => {
    const result = resolveHarnessLayers([
      { harness_type: "pi", harness_config: "base" },
      { harness_type: "hermes", harness_config: "override" },
    ]);
    assert.equal(result.harness_type, "hermes");
    assert.equal(result.harness_config, "override");
  });

  it("undefined inherits from the lower layer", () => {
    const result = resolveHarnessLayers([{ harness_type: "pi", harness_config: "docs" }, { harness_type: undefined }]);
    assert.equal(result.harness_type, "pi");
    assert.equal(result.harness_config, "docs");
  });

  it('explicit "none" overrides an inherited value', () => {
    const result = resolveHarnessLayers([{ harness_type: "pi", harness_config: "docs" }, { harness_type: "none" }]);
    assert.equal(result.harness_type, "none");
    assert.equal(result.harness_config, "docs"); // inherited unchanged
  });

  it("empty layers yield no fields", () => {
    const result = resolveHarnessLayers([]);
    assert.equal(result.harness_type, undefined);
    assert.equal(result.harness_config, undefined);
  });

  it("all-undefined layers yield no fields", () => {
    const result = resolveHarnessLayers([undefined, undefined, undefined]);
    assert.equal(result.harness_type, undefined);
    assert.equal(result.harness_config, undefined);
  });

  it("a mix of defined and undefined layers inherits correctly", () => {
    const result = resolveHarnessLayers([
      { harness_type: "opencode" },
      undefined,
      { harness_config: "backend-review" },
      undefined,
    ]);
    assert.equal(result.harness_type, "opencode");
    assert.equal(result.harness_config, "backend-review");
  });
});

// ── extractHarnessTypeFlag ──────────────────────────────────────────────────

describe("extractHarnessTypeFlag", () => {
  it("returns no harnessType and trimmed args when the flag is absent", () => {
    const { harnessType, rest } = extractHarnessTypeFlag("  review the auth module  ");
    assert.equal(harnessType, undefined);
    assert.equal(rest, "review the auth module");
  });

  it("parses `--harness-type <value>` and strips it from rest", () => {
    const { harnessType, rest } = extractHarnessTypeFlag("--harness-type hermes review task");
    assert.equal(harnessType, "hermes");
    assert.equal(rest, "review task");
  });

  it("parses `--harness-type=<value>` form", () => {
    const { harnessType, rest } = extractHarnessTypeFlag("task --harness-type=opencode");
    assert.equal(harnessType, "opencode");
    assert.equal(rest, "task");
  });

  it("a flag in the middle does not mangle surrounding args", () => {
    const { harnessType, rest } = extractHarnessTypeFlag("urgent --harness-type hermes src/auth");
    assert.equal(harnessType, "hermes");
    assert.equal(rest, "urgent src/auth");
  });

  it("flag match is case-insensitive but the value is not", () => {
    const { harnessType } = extractHarnessTypeFlag("--HARNESS-TYPE HerMees");
    assert.equal(harnessType, "HerMees");
  });

  it("--no-harness yields harnessType 'none'", () => {
    const { harnessType, rest } = extractHarnessTypeFlag("--no-harness do review");
    assert.equal(harnessType, "none");
    assert.equal(rest, "do review");
  });

  it("a plain harness_config=value (no --) is left untouched in rest", () => {
    const { harnessType, rest } = extractHarnessTypeFlag("harness_config=backend review");
    assert.equal(harnessType, undefined);
    assert.equal(rest, "harness_config=backend review");
  });
});

// ── extractHarnessConfigFlag ────────────────────────────────────────────────

describe("extractHarnessConfigFlag", () => {
  it("returns no harnessConfig and trimmed args when the flag is absent", () => {
    const { harnessConfig, rest } = extractHarnessConfigFlag("  review the auth module  ");
    assert.equal(harnessConfig, undefined);
    assert.equal(rest, "review the auth module");
  });

  it("parses `--harness-config <value>` and strips it from rest", () => {
    const { harnessConfig, rest } = extractHarnessConfigFlag("--harness-config docs review task");
    assert.equal(harnessConfig, "docs");
    assert.equal(rest, "review task");
  });

  it("parses `--harness-config=<value>` form", () => {
    const { harnessConfig, rest } = extractHarnessConfigFlag("task --harness-config=backend");
    assert.equal(harnessConfig, "backend");
    assert.equal(rest, "task");
  });

  it("a flag in the middle does not mangle surrounding args", () => {
    const { harnessConfig, rest } = extractHarnessConfigFlag("urgent --harness-config docs src/auth");
    assert.equal(harnessConfig, "docs");
    assert.equal(rest, "urgent src/auth");
  });

  it("flag match is case-insensitive but the value is not", () => {
    const { harnessConfig } = extractHarnessConfigFlag("--HARNESS-CONFIG DocID");
    assert.equal(harnessConfig, "DocID");
  });

  it("a plain harness_config=value (no --) is left untouched in rest", () => {
    const { harnessConfig, rest } = extractHarnessConfigFlag("harness_config=backend review");
    assert.equal(harnessConfig, undefined);
    assert.equal(rest, "harness_config=backend review");
  });
});
