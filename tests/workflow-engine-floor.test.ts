import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { loadHarnessConfigRegistry } from "../src/harness-config.js";
import { runWorkflow } from "../src/workflow.js";

function neverCalledRunner() {
  return {
    async run() {
      throw new Error("agent runner must not be called on a clean-skip");
    },
  };
}

function writeHarness(dir: string, id: string, raw: Record<string, unknown>) {
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, harness_type: "pi", ...raw }));
  return harnessDir;
}

test("explicit --harness-config below the engine.min floor clean-skips (no silent pi fallback)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-floor-explicit-"));
  // engine.min 99.0.0 is above the running engine (0.1.7) → loader skips + retains it.
  writeHarness(dir, "too-new", { engine: { min: "99.0.0" }, tools: ["read"] });
  const userDir = mkdtempSync(join(tmpdir(), "engine-floor-explicit-user-"));
  const registry = loadHarnessConfigRegistry("/unused", {
    projectDir: join(dir, ".pi", "workflows", "harnesses"),
    userDir,
  });
  assert.ok(registry.get("too-new")?.skipped, "loader retains the below-floor descriptor as skipped");

  const script = `export const meta = { name: 'explicit_floor', description: 'explicit below floor' }
return 'ran'`;
  const result = await runWorkflow(script, {
    agent: neverCalledRunner(),
    harness_config: "too-new",
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
  });

  assert.equal(result.agentCount, 0, "no agents spawned on a below-floor explicit config");
  assert.equal((result.result as { status?: string }).status, "harness-not-wired", "clean-skip result shape");
  const reason = (result.result as { reason?: string }).reason ?? "";
  assert.match(reason, /engine\.min|below declared engine\.min/, "skip reason names the engine.min floor");
});

test("a workflow script with meta.engine.min above the running engine clean-skips on launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-floor-meta-"));
  const script = `export const meta = { name: 'needs_new_engine', description: 'meta floor', engine: { min: '99.0.0' } }
return 'ran'`;
  const result = await runWorkflow(script, {
    agent: neverCalledRunner(),
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(result.agentCount, 0, "no agents spawned when meta.engine.min is above the engine");
  assert.equal((result.result as { status?: string }).status, "harness-not-wired", "clean-skip result shape");
  assert.match(
    (result.result as { reason?: string }).reason ?? "",
    /Workflow meta engine\.min/,
    "skip reason names the workflow meta floor",
  );
});

test("a workflow script with meta.engine.min at/below the running engine runs normally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-floor-meta-ok-"));
  const script = `export const meta = { name: 'ok_engine', description: 'meta floor ok', engine: { min: '0.0.1' } }
const a = await agent('do', { label: 'do' })
return a`;
  let called = 0;
  const result = await runWorkflow(script, {
    agent: {
      async run(prompt: string) {
        called++;
        return `ran:${prompt}`;
      },
    },
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(called, 1, "the agent runs when the meta floor is satisfied");
  assert.equal(result.agentCount, 1);
  assert.equal(result.result, "ran:do");
});

test("a per-call harness_config that the loader skipped clean-skips (PR #108 round-5 finding 3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-floor-percall-"));
  writeHarness(dir, "too-new", { engine: { min: "99.0.0" }, tools: ["read"] });
  writeHarness(dir, "backend-ok", { tools: ["bash", "read"] });
  const userDir = mkdtempSync(join(tmpdir(), "engine-floor-percall-user-"));
  const registry = loadHarnessConfigRegistry("/unused", {
    projectDir: join(dir, ".pi", "workflows", "harnesses"),
    userDir,
  });
  assert.ok(registry.get("too-new")?.skipped, "too-new is retained as skipped");

  const calls: Array<{ label?: string; toolNames?: readonly string[] }> = [];
  const script = `export const meta = { name: 'percall_skipped', description: 'per-call skipped' }
const a = await agent('step', { label: 'step', harness_config: 'too-new' })
return a`;
  // PR #108 round-5 finding 3: an explicit per-call selection of a SKIPPED descriptor must
  // clean-skip the agent with the skip reason instead of silently falling back to the
  // run-level harness (which may have no requirement, defeating the fail-closed intent of
  // the loader skip). Previously the per-call skipped descriptor fell back to run-level and
  // the agent ran under backend-ok; now it throws a non-recoverable HARNESS_NOT_WIRED.
  let thrown: unknown;
  try {
    await runWorkflow(script, {
      agent: {
        async run(_p: string, o: Record<string, unknown>) {
          calls.push({ label: o.label as string | undefined, toolNames: o.toolNames as readonly string[] | undefined });
          return "ran";
        },
      },
      harness_config: "backend-ok",
      harnessConfigRegistry: registry,
      cwd: dir,
      persistLogs: false,
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(calls.length, 0, "the agent must NOT run when the per-call descriptor was skipped by the loader");
  assert.ok(thrown instanceof WorkflowError, `expected WorkflowError, got ${(thrown as Error)?.name ?? thrown}`);
  assert.equal((thrown as WorkflowError).code, WorkflowErrorCode.HARNESS_NOT_WIRED);
  assert.match((thrown as Error).message, /skipped by the loader/);
  assert.match((thrown as Error).message, /engine\.min/, "skip reason names the engine.min floor");
});

test("a workflow script with a malformed (non-string) meta.engine.min clean-skips on launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-floor-meta-malformed-"));
  const script = `export const meta = { name: 'bad_floor', description: 'malformed floor', engine: { min: 99 } }
return 'ran'`;
  const result = await runWorkflow(script, {
    agent: neverCalledRunner(),
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(result.agentCount, 0, "no agents spawned on a malformed meta floor");
  assert.equal((result.result as { status?: string }).status, "harness-not-wired");
  assert.match(
    (result.result as { reason?: string }).reason ?? "",
    /meta engine\.min must be a semver string/,
    "skip reason names the malformed floor",
  );
});

test("a loader-skipped descriptor is retained as not-wired with its skipReason (catalog + auto-detect)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-floor-retained-"));
  writeHarness(dir, "too-new", { engine: { min: "99.0.0" }, tools: ["read"] });
  const userDir = mkdtempSync(join(tmpdir(), "engine-floor-retained-user-"));
  const registry = loadHarnessConfigRegistry("/unused", {
    projectDir: join(dir, ".pi", "workflows", "harnesses"),
    userDir,
  });
  const retained = registry.get("too-new");
  assert.ok(retained, "skipped descriptor is retained in the registry");
  assert.equal(retained?.skipped, true, "marked skipped");
  assert.equal(retained?.wired, false, "retained skipped descriptor is not-wired (catalog shows unavailable)");
  assert.match(retained?.skipReason ?? "", /below declared engine\.min/, "carries the engine.min skip reason");
});

test("a workflow script with meta.engine.min: null clean-skips (present non-string is malformed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-floor-meta-null-"));
  const script = `export const meta = { name: 'null_floor', description: 'null floor', engine: { min: null } }
return 'ran'`;
  const result = await runWorkflow(script, {
    agent: neverCalledRunner(),
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(result.agentCount, 0, "no agents spawned on a null meta floor");
  assert.match(
    (result.result as { reason?: string }).reason ?? "",
    /meta engine\.min must be a semver string/,
    "null min is treated as malformed (present key)",
  );
});

test("a workflow script with meta.engine but no min key runs normally (no floor declared)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-floor-meta-nomin-"));
  const script = `export const meta = { name: 'no_min', description: 'no min key', engine: {} }
const a = await agent('do', { label: 'do' })
return a`;
  let called = 0;
  const result = await runWorkflow(script, {
    agent: {
      async run(prompt: string) {
        called++;
        return `ran:${prompt}`;
      },
    },
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(called, 1, "runs when engine object has no min key");
  assert.equal(result.agentCount, 1);
});

test('a workflow script with meta.engine.min: "" runs normally (empty = no floor, mirrors validate-harness)', async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-floor-meta-empty-"));
  const script = `export const meta = { name: 'empty_floor', description: 'empty floor', engine: { min: '' } }
const a = await agent('do', { label: 'do' })
return a`;
  let called = 0;
  const result = await runWorkflow(script, {
    agent: {
      async run(prompt: string) {
        called++;
        return `ran:${prompt}`;
      },
    },
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(called, 1, "an empty-string min is no floor → runs");
  assert.equal(result.agentCount, 1);
});
