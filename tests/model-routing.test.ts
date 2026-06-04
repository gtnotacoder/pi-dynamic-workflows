import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelRoutingInstructions,
  type ModelRoutingConfig,
  parseModelRoutingFromMeta,
  resolveModelForPhase,
} from "../src/model-routing.js";

test("resolveModelForPhase returns default when no phases match", () => {
  assert.equal(resolveModelForPhase("Discovery", { defaultModel: "default-model", routes: [] }), "default-model");
});

test("resolveModelForPhase returns undefined when no default and no routes", () => {
  assert.equal(resolveModelForPhase("Discovery", { routes: [] }), undefined);
});

test("resolveModelForPhase returns defaultModel when phase is undefined (no route to match)", () => {
  assert.equal(resolveModelForPhase(undefined, { defaultModel: "m", routes: [] }), "m");
});

test("resolveModelForPhase matches by case-insensitive contains", () => {
  const config: ModelRoutingConfig = {
    defaultModel: "default-model",
    routes: [{ phasePattern: "research", model: "explorer-model" }],
  };
  assert.equal(resolveModelForPhase("Deep Research", config), "explorer-model");
});

test("resolveModelForPhase prefers explicit route over default", () => {
  const config: ModelRoutingConfig = {
    defaultModel: "default-model",
    routes: [{ phasePattern: "scan", model: "scan-model" }],
  };
  assert.equal(resolveModelForPhase("Scan", config), "scan-model");
});

test("resolveModelForPhase uses first matching route", () => {
  const config: ModelRoutingConfig = {
    defaultModel: "default-model",
    routes: [
      { phasePattern: "scan", model: "scan-model" },
      { phasePattern: "scan", model: "other-model" },
    ],
  };
  assert.equal(resolveModelForPhase("Scan", config), "scan-model");
});

test("resolveModelForPhase uses regex when useRegex is true", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "phase-\\d+", model: "regex-model", useRegex: true }],
  };
  assert.equal(resolveModelForPhase("phase-3", config), "regex-model");
  assert.equal(resolveModelForPhase("phase-42", config), "regex-model");
  assert.equal(resolveModelForPhase("Not Matching", config), undefined);
});

test("resolveModelForPhase handles invalid regex gracefully (skips)", () => {
  const config: ModelRoutingConfig = {
    defaultModel: "default-model",
    routes: [{ phasePattern: "[invalid", model: "bad", useRegex: true }],
  };
  // Invalid regex should be skipped, falling back to default
  assert.equal(resolveModelForPhase("anything", config), "default-model");
});

test("resolveModelForPhase regex is case-insensitive", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "^scan", model: "m", useRegex: true }],
  };
  assert.equal(resolveModelForPhase("SCAN", config), "m");
});

test("resolveModelForPhase no routes and no default returns undefined for any phase", () => {
  assert.equal(resolveModelForPhase("Test", { routes: [] }), undefined);
});

test("buildModelRoutingInstructions returns undefined when no model matched", () => {
  const result = buildModelRoutingInstructions("Test", { routes: [] });
  assert.equal(result, undefined);
});

test("buildModelRoutingInstructions returns model instruction string", () => {
  const result = buildModelRoutingInstructions("Research", {
    routes: [{ phasePattern: "research", model: "gpt-4" }],
  });
  assert.equal(result, "Use model: gpt-4");
});

test("buildModelRoutingInstructions returns instructions for undefined phase with default", () => {
  const result = buildModelRoutingInstructions(undefined, {
    defaultModel: "m",
    routes: [],
  });
  assert.equal(result, "Use model: m");
});

test("parseModelRoutingFromMeta extracts routes from phases", () => {
  const phases = [
    { title: "Scan", model: "fast-model" },
    { title: "Analyze" },
    { title: "Report", model: "slow-model" },
  ];
  const config = parseModelRoutingFromMeta(phases);
  assert.equal(config.routes.length, 2);
  assert.equal(config.routes[0].phasePattern, "Scan");
  assert.equal(config.routes[0].model, "fast-model");
  assert.equal(config.routes[1].phasePattern, "Report");
  assert.equal(config.routes[1].model, "slow-model");
});

test("parseModelRoutingFromMeta returns empty routes when no phases", () => {
  const config = parseModelRoutingFromMeta(undefined);
  assert.deepEqual(config.routes, []);
});

test("parseModelRoutingFromMeta returns empty routes when phases have no models", () => {
  const config = parseModelRoutingFromMeta([{ title: "Scan" }, { title: "Report" }]);
  assert.deepEqual(config.routes, []);
});

test("parseModelRoutingFromMeta handles empty array", () => {
  const config = parseModelRoutingFromMeta([]);
  assert.deepEqual(config.routes, []);
});
