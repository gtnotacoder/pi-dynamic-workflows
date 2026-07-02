import assert from "node:assert/strict";
import test from "node:test";
import { checkToolRequirements } from "../src/tool-requirements.js";

test("checkToolRequirements: undefined availableTools => ok/not-degraded", () => {
  const result = checkToolRequirements(undefined, ["read"], ["edit"]);
  assert.deepEqual(result, { ok: true, degraded: false });
});

test("checkToolRequirements: missing required => ok:false/degraded:false with reason", () => {
  const result = checkToolRequirements(["read", "edit"], ["read", "write"], ["edit"]);
  assert.deepEqual(result, {
    ok: false,
    degraded: false,
    reason: "Missing required tool(s): write",
    missingRequired: ["write"],
  });
});

test("checkToolRequirements: missing preferred => ok:true/degraded:true", () => {
  const result = checkToolRequirements(["read", "edit"], ["read"], ["edit", "write"]);
  assert.deepEqual(result, {
    ok: true,
    degraded: true,
    reason: "Degraded: missing preferred tool(s): write",
    missingPreferred: ["write"],
  });
});

test("checkToolRequirements: all present => ok:true/degraded:false", () => {
  const result = checkToolRequirements(["read", "edit", "write"], ["read"], ["edit", "write"]);
  assert.deepEqual(result, { ok: true, degraded: false });
});
