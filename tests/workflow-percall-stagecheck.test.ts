import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHarnessConfigRegistry } from "../src/harness-config.js";
import { runWorkflow } from "../src/workflow.js";

function writeHarnesses(dir: string) {
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  // A package-local harness config with stageCheck defaults (cwd = packages/web).
  writeFileSync(
    join(harnessDir, "pkg-web.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "pkg-web",
      harness_type: "pi",
      stageCheck: { cwd: "packages/web" },
    }),
  );
  return harnessDir;
}

test("Part 1: a per-call unwired harness (opencode) throws HARNESS_NOT_WIRED instead of falling back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-unwired-"));
  const script = `export const meta = { name: 'unwired', description: 'unwired per-call' }
try {
  await agent('step', { label: 'step', harness_type: 'opencode' })
  return 'ran'
} catch (e) {
  return (e && e.code) || 'no-code'
}`;
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        throw new Error("runner must not be called for an unwired per-call harness");
      },
    },
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(result.result, "HARNESS_NOT_WIRED", "agent() throws HARNESS_NOT_WIRED for an unwired per-call harness");
  assert.equal(result.agentCount, 0, "no agent runner invocation");
});

test("Part 1: a per-call config whose descriptor is an unwired runtime also throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-unwired-config-"));
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "opencode-svc.json"),
    JSON.stringify({ schemaVersion: 1, id: "opencode-svc", harness_type: "opencode", tools: ["read"] }),
  );
  const userDir = mkdtempSync(join(tmpdir(), "percall-unwired-config-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  const script = `export const meta = { name: 'unwired_cfg', description: 'unwired config' }
try {
  await agent('step', { label: 'step', harness_config: 'opencode-svc' })
  return 'ran'
} catch (e) {
  return (e && e.code) || 'no-code'
}`;
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        throw new Error("runner must not be called");
      },
    },
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(result.result, "HARNESS_NOT_WIRED", "per-call unwired-runtime config throws HARNESS_NOT_WIRED");
});

test("Part 2: stageCheck resolves per-step harness_config stageCheckDefaults (package cwd)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-stagecheck-"));
  const harnessDir = writeHarnesses(dir);
  const userDir = mkdtempSync(join(tmpdir(), "percall-stagecheck-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  let capturedCwd: string | undefined;
  const script = `export const meta = { name: 'stagecheck', description: 'per-step stageCheck' }
const r = await stageCheck({ targetFile: 'foo.ts', harness_config: 'pkg-web' })
return r.summary`;
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        return "ok";
      },
    },
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
    stageCheck: async (opts: { cwd?: string }) => {
      capturedCwd = opts.cwd;
      return { ok: true, summary: `cwd=${opts.cwd ?? "?"}`, checks: [] };
    },
  });
  assert.equal(result.result, `cwd=${join(dir, "packages/web")}`, "stageCheck used the per-step config's package cwd");
  assert.equal(capturedCwd, join(dir, "packages/web"), "the per-step harness_config cwd reached the stageCheck runner");
});

test("Part 2: stageCheck without a per-step harness_config uses the run-level defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-stagecheck-runlevel-"));
  const harnessDir = writeHarnesses(dir);
  const userDir = mkdtempSync(join(tmpdir(), "percall-stagecheck-runlevel-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  let capturedCwd: string | undefined;
  const script = `export const meta = { name: 'stagecheck_rl', description: 'run-level stageCheck' }
const r = await stageCheck({ targetFile: 'foo.ts' })
return r.summary`;
  // Run-level harness_config = none → no stageCheck defaults → cwd = baseCwd (dir).
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        return "ok";
      },
    },
    harness_config: "none",
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
    stageCheck: async (opts: { cwd?: string }) => {
      capturedCwd = opts.cwd;
      return { ok: true, summary: `cwd=${opts.cwd ?? "?"}`, checks: [] };
    },
  });
  assert.equal(result.result, `cwd=${dir}`, "run-level stageCheck uses baseCwd when no per-step config is given");
  assert.equal(capturedCwd, dir);
});

test("Part 2: stageCheck falls back to run-level when the per-call harness_type/config mismatch (mirror agent() reject)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-stagecheck-mismatch-"));
  const harnessDir = writeHarnesses(dir); // pkg-web is a pi config with stageCheck.cwd packages/web
  const userDir = mkdtempSync(join(tmpdir(), "percall-stagecheck-mismatch-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  let capturedCwd: string | undefined;
  const script = `export const meta = { name: 'mismatch', description: 'mismatch stageCheck' }
const r = await stageCheck({ targetFile: 'foo.ts', harness_config: 'pkg-web', harness_type: 'opencode' })
return r.summary`;
  // harness_type 'opencode' conflicts with pkg-web's pi runtime → agent() would reject →
  // stageCheck must also fall back to run-level (cwd = dir), NOT packages/web.
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        return "ok";
      },
    },
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
    stageCheck: async (opts: { cwd?: string }) => {
      capturedCwd = opts.cwd;
      return { ok: true, summary: `cwd=${opts.cwd ?? "?"}`, checks: [] };
    },
  });
  assert.equal(result.result, `cwd=${dir}`, "mismatched per-call config falls back to run-level cwd");
  assert.equal(capturedCwd, dir);
});

test("Part 2: stageCheck accepts the per-step config when harness_type matches the descriptor runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-stagecheck-match-"));
  const harnessDir = writeHarnesses(dir);
  const userDir = mkdtempSync(join(tmpdir(), "percall-stagecheck-match-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  let capturedCwd: string | undefined;
  const script = `export const meta = { name: 'match', description: 'match stageCheck' }
const r = await stageCheck({ targetFile: 'foo.ts', harness_config: 'pkg-web', harness_type: 'pi' })
return r.summary`;
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        return "ok";
      },
    },
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
    stageCheck: async (opts: { cwd?: string }) => {
      capturedCwd = opts.cwd;
      return { ok: true, summary: `cwd=${opts.cwd ?? "?"}`, checks: [] };
    },
  });
  assert.equal(
    result.result,
    `cwd=${join(dir, "packages/web")}`,
    "matching per-call config uses the per-step package cwd",
  );
  assert.equal(capturedCwd, join(dir, "packages/web"));
});

test("Part 2: a per-step harness_config 'none' clears the run-level stageCheck defaults (runs at root)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-stagecheck-none-"));
  const harnessDir = writeHarnesses(dir); // pkg-web has stageCheck.cwd packages/web
  const userDir = mkdtempSync(join(tmpdir(), "percall-stagecheck-none-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  let capturedCwd: string | undefined;
  const script = `export const meta = { name: 'none_step', description: 'none clears' }
const r = await stageCheck({ targetFile: 'foo.ts', harness_config: 'none' })
return r.summary`;
  // Run-level is pkg-web (cwd packages/web); per-step "none" clears → baseCwd (dir).
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        return "ok";
      },
    },
    harness_config: "pkg-web",
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
    stageCheck: async (opts: { cwd?: string }) => {
      capturedCwd = opts.cwd;
      return { ok: true, summary: `cwd=${opts.cwd ?? "?"}`, checks: [] };
    },
  });
  assert.equal(result.result, `cwd=${dir}`, "per-step 'none' clears the run-level package cwd → root");
  assert.equal(capturedCwd, dir);
});

test("Part 1: a per-call harness_type conflicting with the SAME run-level config keeps run-level (no throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-sameconfig-mismatch-"));
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "backend-api.json"),
    JSON.stringify({ schemaVersion: 1, id: "backend-api", harness_type: "pi", tools: ["bash", "read"] }),
  );
  const userDir = mkdtempSync(join(tmpdir(), "percall-sameconfig-mismatch-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  let agentCalled = 0;
  const script = `export const meta = { name: 'samecfg', description: 'same config mismatch' }
try {
  await agent('x', { label: 'x', harness_type: 'opencode', harness_config: 'backend-api' })
  return 'ran'
} catch (e) {
  return (e && e.code) || 'threw'
}`;
  // run-level backend-api (pi); step harness_type 'opencode' conflicts with backend-api's pi
  // runtime → mismatch → keep run-level (NO HARNESS_NOT_WIRED throw). The agent runs.
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        agentCalled++;
        return "ran";
      },
    },
    harness_config: "backend-api",
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(result.result, "ran", "same-config type mismatch keeps run-level (does not throw)");
  assert.equal(agentCalled, 1, "the agent ran under the run-level harness");
});

test("Part 2: stageCheck rejects an unwired per-step config (falls back to run-level)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-stagecheck-unwired-"));
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "opencode-svc.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "opencode-svc",
      harness_type: "opencode",
      stageCheck: { cwd: "packages/oc" },
    }),
  );
  const userDir = mkdtempSync(join(tmpdir(), "percall-stagecheck-unwired-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  let capturedCwd: string | undefined;
  const script = `export const meta = { name: 'unwired_sc', description: 'unwired stageCheck' }
const r = await stageCheck({ targetFile: 'foo.ts', harness_config: 'opencode-svc' })
return r.summary`;
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        return "ok";
      },
    },
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
    stageCheck: async (opts: { cwd?: string }) => {
      capturedCwd = opts.cwd;
      return { ok: true, summary: `cwd=${opts.cwd ?? "?"}`, checks: [] };
    },
  });
  assert.equal(result.result, `cwd=${dir}`, "unwired per-step config falls back to run-level (root), not its own cwd");
  assert.equal(capturedCwd, dir);
});

test("Part 2: an accepted per-step config with no stageCheck block uses baseCwd (not run-level package)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-stagecheck-nosc-"));
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "pkg-web.json"),
    JSON.stringify({ schemaVersion: 1, id: "pkg-web", harness_type: "pi", stageCheck: { cwd: "packages/web" } }),
  );
  // A different accepted config with NO stageCheck block.
  writeFileSync(
    join(harnessDir, "other-pi.json"),
    JSON.stringify({ schemaVersion: 1, id: "other-pi", harness_type: "pi", tools: ["read"] }),
  );
  const userDir = mkdtempSync(join(tmpdir(), "percall-stagecheck-nosc-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  let capturedCwd: string | undefined;
  const script = `export const meta = { name: 'nosc', description: 'no stageCheck' }
const r = await stageCheck({ targetFile: 'foo.ts', harness_config: 'other-pi' })
return r.summary`;
  // Run-level pkg-web (cwd packages/web); per-step other-pi (accepted, no stageCheck) → baseCwd.
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        return "ok";
      },
    },
    harness_config: "pkg-web",
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
    stageCheck: async (opts: { cwd?: string }) => {
      capturedCwd = opts.cwd;
      return { ok: true, summary: `cwd=${opts.cwd ?? "?"}`, checks: [] };
    },
  });
  assert.equal(
    result.result,
    `cwd=${dir}`,
    "accepted per-step config with no stageCheck uses baseCwd, not the run-level package",
  );
  assert.equal(capturedCwd, dir);
});

test("Part 1: a per-call config equal to the run-level config with NO per-call type inherits the run-level runtime (no throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "percall-sameconfig-notype-"));
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "opencode-svc.json"),
    JSON.stringify({ schemaVersion: 1, id: "opencode-svc", harness_type: "opencode", tools: ["read"] }),
  );
  const userDir = mkdtempSync(join(tmpdir(), "percall-sameconfig-notype-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  let agentCalled = 0;
  const script = `export const meta = { name: 'samecfg_notype', description: 'same config no type' }
try {
  await agent('x', { label: 'x', harness_config: 'opencode-svc' })
  return 'ran'
} catch (e) {
  return (e && e.code) || 'threw'
}`;
  // Run-level pairs explicit pi with the opencode-svc config. A step that supplies only the
  // same config (no per-call type) inherits the run-level pi runtime → runs (no HARNESS_NOT_WIRED).
  const result = await runWorkflow(script, {
    agent: {
      async run() {
        agentCalled++;
        return "ran";
      },
    },
    harness_type: "pi",
    harness_config: "opencode-svc",
    harnessConfigRegistry: registry,
    cwd: dir,
    persistLogs: false,
  });
  assert.equal(result.result, "ran", "same-config + no per-call type inherits the run-level runtime (no throw)");
  assert.equal(agentCalled, 1);
});
