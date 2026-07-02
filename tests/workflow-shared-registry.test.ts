import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { listAvailableModelSpecs } from "../src/agent.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowTool, modelRoutingGuideline } from "../src/workflow-tool.js";

/**
 * Upstream #49 port: workflow subagents/tooling must resolve models against the
 * HOST session's ModelRegistry when one is shared, so providers registered
 * dynamically by extensions are routable and advertised. The fake provider name
 * is deliberately one no disk registry would contain, so these tests cannot
 * pass by accident against ~/.pi/models.json.
 */
const fakeRegistry = {
  getAvailable: () => [
    { provider: "fake-ext-provider", id: "fake-model-x" },
    { provider: "fake-ext-provider", id: "fake-model-y" },
  ],
  getAll: () => [],
  find: () => undefined,
} as unknown as ModelRegistry;

test("listAvailableModelSpecs uses a provided registry instead of the disk registry", () => {
  const specs = listAvailableModelSpecs(fakeRegistry);
  assert.deepEqual(specs, ["fake-ext-provider/fake-model-x", "fake-ext-provider/fake-model-y"]);
});

test("modelRoutingGuideline advertises models from the provided registry", () => {
  const guideline = modelRoutingGuideline(fakeRegistry);
  assert.match(guideline, /fake-ext-provider\/fake-model-x/);
  assert.match(guideline, /fake-ext-provider\/fake-model-y/);
});

test("WorkflowManager stores and exposes the shared model registry", () => {
  const manager = new WorkflowManager();
  assert.equal(manager.getModelRegistry(), undefined);
  manager.setModelRegistry(fakeRegistry);
  assert.equal(manager.getModelRegistry(), fakeRegistry);
  manager.setModelRegistry(undefined);
  assert.equal(manager.getModelRegistry(), undefined);
});

test("WorkflowManager accepts a registry via constructor options", () => {
  const manager = new WorkflowManager({ modelRegistry: fakeRegistry });
  assert.equal(manager.getModelRegistry(), fakeRegistry);
});

test("workflow tool promptGuidelines re-read the manager registry set after creation", () => {
  const manager = new WorkflowManager();
  const tool = createWorkflowTool({ manager });
  const before = (tool.promptGuidelines ?? []).join(" ");
  assert.ok(!before.includes("fake-ext-provider/fake-model-x"), "fake provider must not appear before sharing");
  manager.setModelRegistry(fakeRegistry);
  const after = (tool.promptGuidelines ?? []).join(" ");
  assert.match(after, /fake-ext-provider\/fake-model-x/);
});
