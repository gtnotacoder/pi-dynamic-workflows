import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { loadHarnessConfigRegistry } from "../src/harness-config.js";
import { runWorkflow } from "../src/workflow.js";

interface CapturedCall {
  label: string | undefined;
  toolNames: readonly string[] | undefined;
}

function capturingRunner(calls: CapturedCall[]) {
  return {
    async run(prompt: string, options: Record<string, unknown>) {
      calls.push({
        label: options.label as string | undefined,
        toolNames: options.toolNames as readonly string[] | undefined,
      });
      return `ran:${prompt}`;
    },
  };
}

function writeHarness(dir: string, file: string, payload: Record<string, unknown>) {
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, file), JSON.stringify(payload), "utf-8");
  return harnessDir;
}

// ── Finding 1: run-level requiredTools must be enforced against the effective tool
//    set even when runWorkflow is called WITHOUT options.tools (the default path). ──

test("finding 1: run-level requiredTools clean-skips when options.tools is undefined and the required tool is absent from the default coding tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-f1-"));
  try {
    const harnessDir = writeHarness(dir, "needs-web.json", {
      schemaVersion: 1,
      id: "needs-web",
      harness_type: "pi",
      requiredTools: ["web_search"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-f1-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const result = await runWorkflow(
      `export const meta = { name: 'f1', description: 'run-level required tool absent' }
return 'ran'`,
      {
        agent: capturingRunner([]),
        harness_config: "needs-web",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
      } as Record<string, unknown>,
    );
    // The run must clean-skip (harness-not-wired) because web_search is not in the
    // default coding tool set and was not supplied via options.tools.
    assert.equal((result.result as { status?: string }).status, "harness-not-wired");
    assert.match(JSON.stringify(result.logs), /Missing required tool\(s\): web_search/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding 1: run-level requiredTools passes when the required tool IS in the default coding tool set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-f1-ok-"));
  try {
    const harnessDir = writeHarness(dir, "needs-read.json", {
      schemaVersion: 1,
      id: "needs-read",
      harness_type: "pi",
      requiredTools: ["read"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-f1-ok-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const calls: CapturedCall[] = [];
    const result = await runWorkflow(
      `export const meta = { name: 'f1ok', description: 'run-level required tool present' }
const a = await agent('step', { label: 'step' })
return a`,
      {
        agent: capturingRunner(calls),
        harness_config: "needs-read",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
      } as Record<string, unknown>,
    );
    assert.notEqual((result.result as { status?: string }).status, "harness-not-wired");
    assert.equal(calls.length, 1, "the agent ran (required tool was available)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Finding 2: per-call harness_config overrides re-run checkToolRequirements. ──

test("finding 2: per-call harness_config requiring an absent tool throws (clean failure, not silent run)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-f2-"));
  try {
    // Run-level config has no requiredTools; per-call config requires web_search (absent).
    const harnessDir = writeHarness(dir, "runlevel.json", {
      schemaVersion: 1,
      id: "runlevel",
      harness_type: "pi",
    });
    writeHarness(dir, "needs-web-percall.json", {
      schemaVersion: 1,
      id: "needs-web-percall",
      harness_type: "pi",
      requiredTools: ["web_search"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-f2-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const calls: CapturedCall[] = [];
    await runWorkflow(
      `export const meta = { name: 'f2', description: 'per-call required tool absent' }
const a = await agent('step', { label: 'step', harness_config: 'needs-web-percall' })
return a`,
      {
        agent: capturingRunner(calls),
        harness_config: "runlevel",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
      } as Record<string, unknown>,
    );
    assert.equal(calls.length, 0, "the agent must NOT run when the per-call required tool is absent");
  } catch (error) {
    // The throw path: agent() rejects with a non-recoverable HARNESS_NOT_WIRED error.
    assert.ok(error instanceof WorkflowError, `expected WorkflowError, got ${(error as Error).name}`);
    assert.equal(error.code, WorkflowErrorCode.HARNESS_NOT_WIRED);
    assert.match(error.message, /missing required tool/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding 2: per-call harness_config requiring a present tool runs the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-f2-ok-"));
  try {
    const harnessDir = writeHarness(dir, "runlevel2.json", {
      schemaVersion: 1,
      id: "runlevel2",
      harness_type: "pi",
    });
    writeHarness(dir, "needs-read-percall.json", {
      schemaVersion: 1,
      id: "needs-read-percall",
      harness_type: "pi",
      requiredTools: ["read"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-f2-ok-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const calls: CapturedCall[] = [];
    await runWorkflow(
      `export const meta = { name: 'f2ok', description: 'per-call required tool present' }
const a = await agent('step', { label: 'step', harness_config: 'needs-read-percall' })
return a`,
      {
        agent: capturingRunner(calls),
        harness_config: "runlevel2",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
      } as Record<string, unknown>,
    );
    assert.equal(calls.length, 1, "the agent ran (per-call required tool was available)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Finding 2 (preferred): a per-call preferred tool missing logs a degradation warning. ──

test("finding 2/4: per-call preferredTools missing logs a degradation warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-f2pref-"));
  try {
    const harnessDir = writeHarness(dir, "runlevel3.json", {
      schemaVersion: 1,
      id: "runlevel3",
      harness_type: "pi",
    });
    writeHarness(dir, "wants-web-percall.json", {
      schemaVersion: 1,
      id: "wants-web-percall",
      harness_type: "pi",
      preferredTools: ["web_search"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-f2pref-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const calls: CapturedCall[] = [];
    const result = await runWorkflow(
      `export const meta = { name: 'f2pref', description: 'per-call preferred tool absent' }
const a = await agent('step', { label: 'step', harness_config: 'wants-web-percall' })
return a`,
      {
        agent: capturingRunner(calls),
        harness_config: "runlevel3",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
      } as Record<string, unknown>,
    );
    assert.equal(calls.length, 1, "preferred-missing degrades but still runs");
    assert.match(
      JSON.stringify(result.logs),
      /Degraded: missing preferred tool\(s\): web_search/,
      "a degradation warning is logged",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Finding 4: preferred-tool degradation state folds into the resume hash. ──

test("finding 4: a cached result produced with a preferred tool available does NOT replay after the tool disappears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-f4-"));
  try {
    // Two configs: one whose preferredTools are satisfied by the default coding tools
    // (read), and one whose preferredTools are NOT (web_search). The same script agent
    // call hashes differently under each because the degradation state is folded in.
    const harnessDir = writeHarness(dir, "pref-present.json", {
      schemaVersion: 1,
      id: "pref-present",
      harness_type: "pi",
      preferredTools: ["read"],
    });
    writeHarness(dir, "pref-absent.json", {
      schemaVersion: 1,
      id: "pref-absent",
      harness_type: "pi",
      preferredTools: ["web_search"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-f4-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });

    // First run: pref-present (not degraded). Capture the journal hash for the single call.
    const journal: Map<number, { index: number; hash: string; result: unknown }> = new Map();
    let capturedHash: string | undefined;
    const callsA: CapturedCall[] = [];
    await runWorkflow(
      `export const meta = { name: 'f4', description: 'resume hash includes degradation' }
const a = await agent('step', { label: 'step', harness_config: 'pref-present' })
return a`,
      {
        agent: capturingRunner(callsA),
        harness_config: "pref-present",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
        onAgentJournal: (entry: { index: number; hash: string; result: unknown }) => {
          capturedHash = entry.hash;
          journal.set(entry.index, entry);
        },
      } as Record<string, unknown>,
    );
    assert.ok(capturedHash, "the first run journaled a hash");

    // Second run: same script + same call index, but pref-absent (degraded). Resume with
    // the pref-present journal. The degradation state changed, so the hash must NOT match
    // and the call must run live instead of replaying the cached result.
    const callsB: CapturedCall[] = [];
    await runWorkflow(
      `export const meta = { name: 'f4', description: 'resume hash includes degradation' }
const a = await agent('step', { label: 'step', harness_config: 'pref-absent' })
return a`,
      {
        agent: capturingRunner(callsB),
        harness_config: "pref-absent",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
        resumeJournal: journal,
      } as Record<string, unknown>,
    );
    // The cached result was produced with `read` available (not degraded). After switching
    // to pref-absent (degraded), the hash changes and the call runs live — callsB has an
    // entry, proving the cache did NOT replay.
    assert.equal(callsB.length, 1, "degradation state changed ⇒ cache miss ⇒ live re-run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Finding 1: per-agent narrowing (agentType/per-call `tools`) that drops a required
//    tool must fail that agent call, not pass silently. The run-level gate only
//    applies the harness allow/deny policy to runLevelBaseToolNames, so a required
//    tool later removed by an agentType or per-call `tools` allowlist would slip
//    through unless re-checked at the narrowing seam. ──

test("finding 1: a per-call tools allowlist that drops a required tool fails the agent call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-f1-narrow-"));
  try {
    // Harness requires `bash` (present in the default coding tool set, so the run-level
    // gate passes). A per-call `tools: ['read']` allowlist narrows `bash` away.
    const harnessDir = writeHarness(dir, "needs-bash.json", {
      schemaVersion: 1,
      id: "needs-bash",
      harness_type: "pi",
      requiredTools: ["bash"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-f1-narrow-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const calls: CapturedCall[] = [];
    let thrown: unknown;
    try {
      await runWorkflow(
        `export const meta = { name: 'f1narrow', description: 'per-call tools drops required tool' }
const a = await agent('step', { label: 'step', tools: ['read'] })
return a`,
        {
          agent: capturingRunner(calls),
          harness_config: "needs-bash",
          harnessConfigRegistry: registry,
          cwd: dir,
          concurrency: 1,
          persistLogs: false,
        } as Record<string, unknown>,
      );
    } catch (error) {
      thrown = error;
    }
    assert.equal(calls.length, 0, "the agent must NOT run when per-call tools drops the required tool");
    assert.ok(thrown instanceof WorkflowError, `expected WorkflowError, got ${(thrown as Error)?.name ?? thrown}`);
    assert.equal((thrown as WorkflowError).code, WorkflowErrorCode.HARNESS_NOT_WIRED);
    assert.match((thrown as Error).message, /missing required tool/);
    assert.match((thrown as Error).message, /bash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding 1: an agentType tools allowlist that drops a required tool fails the agent call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-f1-agenttype-"));
  try {
    const harnessDir = writeHarness(dir, "needs-bash2.json", {
      schemaVersion: 1,
      id: "needs-bash2",
      harness_type: "pi",
      requiredTools: ["bash"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-f1-agenttype-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    // agentType narrows to read-only tools (no bash).
    const agentRegistry = new Map([
      [
        "reader",
        {
          name: "reader",
          description: "r",
          tools: ["read", "grep"],
          prompt: "be a reader",
          source: "project" as const,
        },
      ],
    ]);
    const calls: CapturedCall[] = [];
    let thrown: unknown;
    try {
      await runWorkflow(
        `export const meta = { name: 'f1at', description: 'agentType drops required tool' }
const a = await agent('step', { label: 'step', agentType: 'reader' })
return a`,
        {
          agent: capturingRunner(calls),
          harness_config: "needs-bash2",
          harnessConfigRegistry: registry,
          agentRegistry,
          cwd: dir,
          concurrency: 1,
          persistLogs: false,
        } as Record<string, unknown>,
      );
    } catch (error) {
      thrown = error;
    }
    assert.equal(calls.length, 0, "the agent must NOT run when the agentType drops the required tool");
    assert.ok(thrown instanceof WorkflowError, `expected WorkflowError, got ${(thrown as Error)?.name ?? thrown}`);
    assert.equal((thrown as WorkflowError).code, WorkflowErrorCode.HARNESS_NOT_WIRED);
    assert.match((thrown as Error).message, /bash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding 1: per-agent narrowing that still satisfies the required tool runs the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-f1-narrow-ok-"));
  try {
    const harnessDir = writeHarness(dir, "needs-read2.json", {
      schemaVersion: 1,
      id: "needs-read2",
      harness_type: "pi",
      requiredTools: ["read"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-f1-narrow-ok-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const calls: CapturedCall[] = [];
    await runWorkflow(
      `export const meta = { name: 'f1narrowok', description: 'per-call tools keeps required tool' }
const a = await agent('step', { label: 'step', tools: ['read', 'grep'] })
return a`,
      {
        agent: capturingRunner(calls),
        harness_config: "needs-read2",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
      } as Record<string, unknown>,
    );
    assert.equal(calls.length, 1, "the agent runs when the narrowed set still contains the required tool");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Round-3 finding 1: per-agent worktree isolation uses the agent's REAL tool base
//    (createCodingTools output), not the possibly-custom run-level options.tools.
//    When isolation:"worktree" rebuilds coding tools for the worktree cwd, any custom
//    run-level options.tools override is DROPPED — the harness check must not treat
//    those dropped tools as still available. ──

test("round-3 finding 1: worktree isolation drops a custom run-level tool from the available base (required tool only in options.tools fails under isolation)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-r3-f1-"));
  try {
    // Run-level options.tools supplies a custom tool "custom_x" that is NOT in the default
    // coding tool set. A harness requires "custom_x". Without worktree isolation the
    // run-level base includes custom_x (from options.tools), so the check passes. With
    // per-agent isolation:"worktree" the agent rebuilds via createCodingTools(runCwd),
    // dropping custom_x — the required tool is now absent and the agent call must fail
    // closed (clean failure), not silently run.
    const harnessDir = writeHarness(dir, "needs-custom.json", {
      schemaVersion: 1,
      id: "needs-custom",
      harness_type: "pi",
      requiredTools: ["custom_x"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-r3-f1-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const calls: CapturedCall[] = [];
    let thrown: unknown;
    try {
      await runWorkflow(
        `export const meta = { name: 'r3f1', description: 'worktree drops custom tool' }
const a = await agent('step', { label: 'step', isolation: 'worktree' })
return a`,
        {
          agent: capturingRunner(calls),
          harness_config: "needs-custom",
          tools: [
            { name: "custom_x", description: "x", schema: {}, run: async () => "ok" },
            { name: "read", description: "r", schema: {}, run: async () => "ok" },
          ],
          harnessConfigRegistry: registry,
          cwd: dir,
          concurrency: 1,
          persistLogs: false,
        } as Record<string, unknown>,
      );
    } catch (error) {
      thrown = error;
    }
    assert.equal(calls.length, 0, "the agent must NOT run when worktree isolation drops the required custom tool");
    assert.ok(thrown instanceof WorkflowError, `expected WorkflowError, got ${(thrown as Error)?.name ?? thrown}`);
    assert.equal((thrown as WorkflowError).code, WorkflowErrorCode.HARNESS_NOT_WIRED);
    assert.match((thrown as Error).message, /custom_x/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Round-3 finding 2: the default availability set is derived from the actual base
//    constructor (createCodingTools → read, bash, edit, write), NOT the read-only
//    factories. A required read-only tool (grep/find/ls) must clean-skip on the default
//    path because those tools are never built by createCodingTools. ──

test("round-3 finding 2: a required read-only tool (grep) clean-skips on the default path (not in createCodingTools output)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-r3-f2-"));
  try {
    const harnessDir = writeHarness(dir, "needs-grep.json", {
      schemaVersion: 1,
      id: "needs-grep",
      harness_type: "pi",
      requiredTools: ["grep"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-r3-f2-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const result = await runWorkflow(
      `export const meta = { name: 'r3f2', description: 'required grep absent from default base' }
return 'ran'`,
      {
        agent: capturingRunner([]),
        harness_config: "needs-grep",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
      } as Record<string, unknown>,
    );
    // grep is NOT created by createCodingTools(cwd) — the default path only builds
    // read/bash/edit/write — so requiring it must clean-skip rather than silently pass.
    assert.equal((result.result as { status?: string }).status, "harness-not-wired");
    assert.match(JSON.stringify(result.logs), /Missing required tool\(s\): grep/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Round-3 finding 3: run-level requiredTools are preserved across an explicit
//    per-call harness_config:"none" (or any narrowing config that does not declare its
//    own requiredTools). A per-step tools allowlist that drops the run-level required
//    tool must fail, not silently pass because the per-call "none" cleared the requirement. ──

test("round-3 finding 3: per-call harness_config:'none' carries run-level requiredTools through (narrowing that drops the required tool fails)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-r3-f3-"));
  try {
    // Run-level config requires bash (present in the default coding tool set, so the
    // run-level gate passes). A per-call harness_config:"none" resolves to a candidate
    // expansion with undefined requiredTools; without carrying the run-level requirement
    // through, a per-call tools:['read'] allowlist would silently drop bash. The fix
    // inherits run-level requiredTools so the narrowing re-check still catches the drop.
    const harnessDir = writeHarness(dir, "needs-bash-rl.json", {
      schemaVersion: 1,
      id: "needs-bash-rl",
      harness_type: "pi",
      requiredTools: ["bash"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-r3-f3-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const calls: CapturedCall[] = [];
    let thrown: unknown;
    try {
      await runWorkflow(
        `export const meta = { name: 'r3f3', description: 'none carries run-level required' }
const a = await agent('step', { label: 'step', harness_config: 'none', tools: ['read'] })
return a`,
        {
          agent: capturingRunner(calls),
          harness_config: "needs-bash-rl",
          harnessConfigRegistry: registry,
          cwd: dir,
          concurrency: 1,
          persistLogs: false,
        } as Record<string, unknown>,
      );
    } catch (error) {
      thrown = error;
    }
    assert.equal(calls.length, 0, "the agent must NOT run when 'none' + narrowing drops the run-level required tool");
    assert.ok(thrown instanceof WorkflowError, `expected WorkflowError, got ${(thrown as Error)?.name ?? thrown}`);
    assert.equal((thrown as WorkflowError).code, WorkflowErrorCode.HARNESS_NOT_WIRED);
    assert.match((thrown as Error).message, /bash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("round-3 finding 3: per-call harness_config:'none' with a satisfying narrowing runs the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-gating-r3-f3-ok-"));
  try {
    const harnessDir = writeHarness(dir, "needs-read-rl.json", {
      schemaVersion: 1,
      id: "needs-read-rl",
      harness_type: "pi",
      requiredTools: ["read"],
    });
    const userDir = mkdtempSync(join(tmpdir(), "wf-gating-r3-f3-ok-user-"));
    const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
    const calls: CapturedCall[] = [];
    await runWorkflow(
      `export const meta = { name: 'r3f3ok', description: 'none + narrowing keeps required' }
const a = await agent('step', { label: 'step', harness_config: 'none', tools: ['read', 'bash'] })
return a`,
      {
        agent: capturingRunner(calls),
        harness_config: "needs-read-rl",
        harnessConfigRegistry: registry,
        cwd: dir,
        concurrency: 1,
        persistLogs: false,
      } as Record<string, unknown>,
    );
    assert.equal(calls.length, 1, "the agent runs when 'none' + narrowing still contains the run-level required tool");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
