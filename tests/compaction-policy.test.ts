import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkflowCompactionPolicy } from "../src/compaction-policy.js";

test("resolveWorkflowCompactionPolicy chooses aggressive settings for local/no-cache models", () => {
  const decision = resolveWorkflowCompactionPolicy({
    model: { provider: "litellm-ny2", id: "local-qwen27", contextWindow: 100_000 },
  });

  assert.equal(decision.policy, "aggressive-local");
  assert.equal(decision.cacheValue, "none");
  assert.equal(decision.settings?.enabled, true);
  assert.equal(decision.settings?.reserveTokens, 35_000);
  assert.equal(decision.settings?.keepRecentTokens, 12_000);
});

test("resolveWorkflowCompactionPolicy leaves remote/cacheable models on default policy", () => {
  const decision = resolveWorkflowCompactionPolicy({
    model: { provider: "openai", id: "gpt-5", contextWindow: 100_000 },
  });

  assert.equal(decision.policy, "default");
  assert.equal(decision.settings, undefined);
});

test("resolveWorkflowCompactionPolicy ignores a local-looking unresolved spec after remote fallback", () => {
  const decision = resolveWorkflowCompactionPolicy({
    modelSpec: "litellm-ny2/local-typo",
    model: { provider: "openai", id: "gpt-5", contextWindow: 100_000 },
  });

  assert.equal(decision.policy, "default");
  assert.equal(decision.settings, undefined);
});

test("resolveWorkflowCompactionPolicy uses a safe fallback for unknown local windows", () => {
  const decision = resolveWorkflowCompactionPolicy({ modelSpec: "ollama/qwen" });

  assert.equal(decision.policy, "aggressive-local");
  assert.equal(decision.settings?.reserveTokens, 4_000);
  assert.equal(decision.settings?.keepRecentTokens, 4_000);
});

test("resolveWorkflowCompactionPolicy honors explicit overrides", () => {
  const cachePreserving = resolveWorkflowCompactionPolicy({ requested: "cache-preserving" });
  assert.equal(cachePreserving.policy, "cache-preserving");
  assert.equal(cachePreserving.settings?.enabled, true);
  assert.equal(resolveWorkflowCompactionPolicy({ requested: "off" }).settings?.enabled, false);
  assert.equal(resolveWorkflowCompactionPolicy({ requested: "aggressive-local" }).policy, "aggressive-local");
});
