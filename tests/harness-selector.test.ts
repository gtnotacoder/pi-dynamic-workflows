import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { selectHarness } from "../src/harness-selector.js";

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

const genericDescriptor = JSON.stringify({
  schemaVersion: 1,
  id: "custom-web-harness",
  harness_type: "pi",
  name: "Custom web harness",
  triggerRules: {
    pathPrefixes: ["packages/web/"],
    importPatterns: ["custom-ui-kit"],
  },
});

describe("selectHarness", () => {
  function writeJson(dir: string, file: string, content: string) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }

  function writeFile(dir: string, file: string, content: string) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }

  function writeShadcnFixtures(root: string) {
    writeJson(
      root,
      "components.json",
      JSON.stringify({ $schema: "https://ui.shadcn.com/schema.json", style: "default" }),
    );
    writeJson(
      root,
      "package.json",
      JSON.stringify({
        dependencies: { react: "^18", tailwindcss: "^3", "@radix-ui/react-slot": "^1" },
      }),
    );
  }

  it("detects frontend-react-shadcn for a shadcn repo layout (flat file)", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-selector-"));
    try {
      writeShadcnFixtures(root);
      writeFile(root, "src/components/ui/button.tsx", "export function Button() {}");
      writeJson(join(root, ".pi/workflows/harnesses"), "frontend-react-shadcn.json", legacyDescriptor);

      const result = selectHarness(root);
      assert.equal(result.harness_config, "frontend-react-shadcn");
      assert.equal(result.source, "auto");
      assert.equal(result.harness_type, "pi");
      assert.equal(result.detectorVersion, 1);
      assert.ok(Array.isArray(result.signals) && result.signals.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects frontend-react-shadcn for directory-module component path (Issue #48)", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-selector-"));
    try {
      writeShadcnFixtures(root);
      writeFile(root, "src/components/ui/checkbox/index.tsx", "export function Checkbox() {}");
      writeJson(join(root, ".pi/workflows/harnesses"), "frontend-react-shadcn.json", legacyDescriptor);

      const result = selectHarness(root);
      assert.equal(result.harness_config, "frontend-react-shadcn");
      assert.equal(result.source, "auto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses descriptor trigger rules so rule-expressible harness_configs extend detection", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-selector-"));
    try {
      writeJson(join(root, ".pi/workflows/harnesses"), "custom-web-harness.json", genericDescriptor);
      writeJson(root, "package.json", JSON.stringify({ dependencies: { react: "^18", "custom-ui-kit": "^1" } }));
      writeFile(root, "packages/web/index.ts", "export const app = true");

      const result = selectHarness(root);
      assert.equal(result.harness_config, "custom-web-harness");
      assert.equal(result.source, "auto");
      assert.deepStrictEqual(result.signals, ["importPattern:custom-ui-kit", "pathPrefix:packages/web/"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches wildcard importPatterns from legacy descriptors", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-selector-"));
    try {
      writeJson(
        root,
        "package.json",
        JSON.stringify({ dependencies: { react: "^18", tailwindcss: "^3", "@radix-ui/react-slot": "^1" } }),
      );
      writeJson(join(root, ".pi/workflows/harnesses"), "frontend-react-shadcn.json", legacyDescriptor);

      const result = selectHarness(root);
      assert.equal(result.harness_config, "frontend-react-shadcn");
      assert.ok(result.signals?.includes("importPattern:@radix-ui/react-*"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns fallback for a plain repo with no descriptors", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-selector-"));
    try {
      const result = selectHarness(root);
      assert.deepStrictEqual(result, {
        harness_type: "pi",
        harness_config: "none",
        source: "default",
        detectorVersion: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is deterministic: repeated calls produce identical results", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-selector-"));
    try {
      writeShadcnFixtures(root);
      writeFile(root, "src/components/ui/button.tsx", "export function Button() {}");
      writeJson(join(root, ".pi/workflows/harnesses"), "frontend-react-shadcn.json", legacyDescriptor);

      const first = selectHarness(root);
      const second = selectHarness(root);
      assert.deepStrictEqual(first, second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
