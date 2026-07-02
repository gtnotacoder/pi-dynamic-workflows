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

// ── expandHarnessConfig ──────────────────────────────────────────────────────

describe("expandHarnessConfig", () => {
  it("surfaces componentExtensions, indexExtensions, directoryModuleSelfFile, and frontendPathTriggers from a frontend-react-shadcn descriptor", () => {
    const registry = new Map();
    registry.set("frontend-react-shadcn", {
      schemaVersion: 1,
      id: "frontend-react-shadcn",
      harness_type: "pi",
      wired: true,
      source: "project" as const,
      raw: {
        schemaVersion: 1,
        id: "frontend-react-shadcn",
        harness_type: "pi",
        componentExtensions: [".tsx", ".jsx"],
        indexExtensions: [".ts", ".tsx", ".js", ".jsx"],
        directoryModuleSelfFile: true,
        frontendPathTriggers: ["components/ui/"],
      },
    });

    const result = expandHarnessConfig({
      harness_config: "frontend-react-shadcn",
      registry,
    });

    assert.deepStrictEqual(result.componentExtensions, [".tsx", ".jsx"]);
    assert.deepStrictEqual(result.indexExtensions, [".ts", ".tsx", ".js", ".jsx"]);
    assert.strictEqual(result.directoryModuleSelfFile, true);
    assert.deepStrictEqual(result.frontendPathTriggers, ["components/ui/"]);
  });

  it("populates shadcn guardrail defaults for legacy frontend-react-shadcn descriptors", () => {
    const registry = new Map();
    registry.set("frontend-react-shadcn", {
      schemaVersion: 1,
      id: "frontend-react-shadcn",
      harness_type: "pi",
      wired: true,
      source: "project" as const,
      raw: {
        schemaVersion: 1,
        id: "frontend-react-shadcn",
        harness_type: "pi",
        triggerRules: { pathPrefixes: ["./components/ui/"] },
      },
    });

    const result = expandHarnessConfig({
      harness_config: "frontend-react-shadcn",
      registry,
    });

    assert.deepStrictEqual(result.componentExtensions, [".tsx", ".jsx"]);
    assert.deepStrictEqual(result.indexExtensions, [".ts", ".tsx", ".js", ".jsx"]);
    assert.strictEqual(result.directoryModuleSelfFile, true);
    assert.deepStrictEqual(result.frontendPathTriggers, ["./components/ui/", "components/ui/", "src/components/ui/"]);
  });

  it("does not enable guardrail fields by default for unrelated descriptors", () => {
    const registry = new Map();
    registry.set("backend-review", {
      schemaVersion: 1,
      id: "backend-review",
      harness_type: "pi",
      wired: true,
      source: "project" as const,
      raw: {
        schemaVersion: 1,
        id: "backend-review",
        harness_type: "pi",
        tools: ["read"],
      },
    });

    const result = expandHarnessConfig({
      harness_config: "backend-review",
      registry,
    });

    assert.strictEqual(result.componentExtensions, undefined);
    assert.strictEqual(result.indexExtensions, undefined);
    assert.strictEqual(result.directoryModuleSelfFile, undefined);
    assert.strictEqual(result.frontendPathTriggers, undefined);
  });

  it("'none' pass-through leaves the new fields undefined", () => {
    const result = expandHarnessConfig({
      harness_config: "none",
      registry: new Map(),
    });

    assert.strictEqual(result.componentExtensions, undefined);
    assert.strictEqual(result.indexExtensions, undefined);
    assert.strictEqual(result.directoryModuleSelfFile, undefined);
    assert.strictEqual(result.frontendPathTriggers, undefined);
  });
});

// ── Malformed requiredTools / preferredTools (PR #108 finding 3) ──────────────

describe("parseHarnessConfigDescriptor: malformed tool lists", () => {
  it("flags a bare-string requiredTools as malformed and drops the requirement", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "bare", harness_type: "pi", requiredTools: "web_search" }),
      "project",
    );
    assert.ok(config);
    assert.equal(config.requiredTools, undefined, "bare string is not a valid tool list");
    assert.equal(config.requiredToolsMalformed, true, "malformed flag is set");
  });

  it("flags a mixed-type array requiredTools as malformed", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "mixed", harness_type: "pi", requiredTools: ["read", 42] }),
      "project",
    );
    assert.ok(config);
    assert.equal(config.requiredTools, undefined, "mixed array is not a valid tool list");
    assert.equal(config.requiredToolsMalformed, true);
  });

  // PR #108 round-4 finding 3: an explicitly EMPTY array is a benign serialized
  // default meaning "no requirement" — it must NOT be flagged malformed (the previous
  // behavior marked it malformed and the loader clean-skipped the descriptor, making
  // generated descriptors with `requiredTools: []` / `preferredTools: []` unusable).
  it("does NOT flag an empty requiredTools array as malformed (empty = no requirement)", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "empty", harness_type: "pi", requiredTools: [] }),
      "project",
    );
    assert.ok(config);
    assert.equal(
      config.requiredTools,
      undefined,
      "empty array yields no requirement (stringArrayField returns undefined)",
    );
    assert.equal(config.requiredToolsMalformed, false, "an empty array is NOT malformed");
  });

  it("does NOT flag an empty preferredTools array as malformed (empty = no preference)", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "emptypref", harness_type: "pi", preferredTools: [] }),
      "project",
    );
    assert.ok(config);
    assert.equal(config.preferredTools, undefined);
    assert.equal(config.preferredToolsMalformed, false, "an empty preferred array is NOT malformed");
  });

  it("flags a bare-string preferredTools as malformed", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "pref", harness_type: "pi", preferredTools: "web_search" }),
      "project",
    );
    assert.ok(config);
    assert.equal(config.preferredTools, undefined);
    assert.equal(config.preferredToolsMalformed, true);
  });

  // PR #108 finding 2: an explicitly present non-array — including null — is
  // malformed, mirroring worktreeRequiredMalformed's presence-with-wrong-type
  // detection. Treating null as not-malformed would silently drop the requirement.
  it("flags an explicit null requiredTools as malformed (presence-with-wrong-type)", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "nullreq", harness_type: "pi", requiredTools: null }),
      "project",
    );
    assert.ok(config);
    assert.equal(config.requiredTools, undefined);
    assert.equal(config.requiredToolsMalformed, true, "null is an explicit non-array and must be malformed");
  });

  it("flags an explicit null preferredTools as malformed (presence-with-wrong-type)", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "nullpref", harness_type: "pi", preferredTools: null }),
      "project",
    );
    assert.ok(config);
    assert.equal(config.preferredTools, undefined);
    assert.equal(config.preferredToolsMalformed, true);
  });

  it("does NOT flag a well-formed non-empty string array", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "ok", harness_type: "pi", requiredTools: ["read", "bash"] }),
      "project",
    );
    assert.ok(config);
    assert.deepEqual(config.requiredTools, ["read", "bash"]);
    assert.equal(config.requiredToolsMalformed, false);
  });

  it("does NOT flag an absent field (no declaration ⇒ nothing to validate)", () => {
    const config = parseHarnessConfigDescriptor(
      JSON.stringify({ schemaVersion: 1, id: "absent", harness_type: "pi" }),
      "project",
    );
    assert.ok(config);
    assert.equal(config.requiredTools, undefined);
    assert.equal(config.requiredToolsMalformed, false);
    assert.equal(config.preferredToolsMalformed, false);
  });
});

describe("loadHarnessConfigRegistry: malformed tool lists clean-skip + warn", () => {
  function writeJson(dir: string, file: string, content: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), content, "utf-8");
  }

  it("skips a descriptor with malformed requiredTools and emits a warning", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-malformed-req-"));
    const projectDir = join(root, "project");
    const warnings: string[] = [];
    try {
      writeJson(
        projectDir,
        "bad.json",
        JSON.stringify({ schemaVersion: 1, id: "bad", harness_type: "pi", requiredTools: "web_search" }),
      );
      const registry = loadHarnessConfigRegistry(root, {
        projectDir,
        userDir: projectDir,
        onWarning: (m) => warnings.push(m),
      });
      const cfg = registry.get("bad");
      assert.ok(cfg, "descriptor is retained (skipped, not dropped)");
      assert.equal(cfg?.skipped, true, "malformed requiredTools clean-skips the descriptor");
      assert.equal(cfg?.wired, false);
      assert.ok(
        warnings.some((w) => w.includes("requiredTools must be a string array")),
        `warning emitted; got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips a descriptor with malformed preferredTools and emits a warning", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-malformed-pref-"));
    const projectDir = join(root, "project");
    const warnings: string[] = [];
    try {
      writeJson(
        projectDir,
        "badpref.json",
        JSON.stringify({ schemaVersion: 1, id: "badpref", harness_type: "pi", preferredTools: ["read", 1] }),
      );
      const registry = loadHarnessConfigRegistry(root, {
        projectDir,
        userDir: projectDir,
        onWarning: (m) => warnings.push(m),
      });
      const cfg = registry.get("badpref");
      assert.ok(cfg);
      assert.equal(cfg?.skipped, true, "malformed preferredTools clean-skips the descriptor");
      assert.ok(
        warnings.some((w) => w.includes("preferredTools must be a string array")),
        `warning emitted; got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // PR #108 finding 2: an explicit null is presence-with-wrong-type and must
  // clean-skip the descriptor, not be treated as an absent declaration.
  it("skips a descriptor whose requiredTools is explicitly null and emits a warning", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-null-req-"));
    const projectDir = join(root, "project");
    const warnings: string[] = [];
    try {
      writeJson(
        projectDir,
        "nullreq.json",
        JSON.stringify({ schemaVersion: 1, id: "nullreq", harness_type: "pi", requiredTools: null }),
      );
      const registry = loadHarnessConfigRegistry(root, {
        projectDir,
        userDir: projectDir,
        onWarning: (m) => warnings.push(m),
      });
      const cfg = registry.get("nullreq");
      assert.ok(cfg, "descriptor is retained (skipped, not dropped)");
      assert.equal(cfg?.skipped, true, "null requiredTools clean-skips the descriptor");
      assert.ok(
        warnings.some((w) => w.includes("requiredTools must be a string array")),
        `warning emitted; got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // PR #108 round-4 finding 3: an explicitly EMPTY requiredTools/preferredTools array
  // is a benign "no requirement" default — the descriptor must NOT be clean-skipped and
  // must remain wired/usable.
  it("does NOT skip a descriptor with empty requiredTools/preferredTools arrays (empty = no requirement)", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-empty-req-"));
    const projectDir = join(root, "project");
    const warnings: string[] = [];
    try {
      writeJson(
        projectDir,
        "emptyok.json",
        JSON.stringify({
          schemaVersion: 1,
          id: "emptyok",
          harness_type: "pi",
          requiredTools: [],
          preferredTools: [],
        }),
      );
      const registry = loadHarnessConfigRegistry(root, {
        projectDir,
        userDir: projectDir,
        onWarning: (m) => warnings.push(m),
      });
      const cfg = registry.get("emptyok");
      assert.ok(cfg, "descriptor is retained");
      assert.notEqual(cfg?.skipped, true, "an empty tool list must NOT clean-skip the descriptor");
      assert.equal(cfg?.wired, true, "an empty tool list keeps the descriptor wired and usable");
      assert.ok(
        !warnings.some((w) => /requiredTools must be a string array/.test(w)),
        `no requiredTools malformed warning; got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
