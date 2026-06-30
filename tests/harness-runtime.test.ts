import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunOptions, AgentRunResult, WorkflowAgent } from "../src/agent.js";
import { type HarnessConfigRegistry, parseHarnessConfigDescriptor } from "../src/harness-config.js";
import { type HarnessSelection, serializeHarnessSelection } from "../src/harness-selector.js";
import { loadHarnessSelection, type PersistedRunState } from "../src/run-persistence.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const oneAgentScript = `export const meta = { name: 'harness_runtime', description: 'harness runtime test' }
const result = await agent('do it', { label: 'worker' })
return result`;

const stageCheckScript = `export const meta = { name: 'harness_stage_check', description: 'harness stageCheck test' }
const result = await stageCheck({ targetFile: 'packages/web/src/App.vue' })
return result.summary`;

const stageCheckDefaultTargetScript = `export const meta = { name: 'harness_stage_check_default', description: 'harness stageCheck default target test' }
const result = await stageCheck({})
return result.summary`;

const stageCheckPackageLocalTargetScript = `export const meta = { name: 'harness_stage_check_local', description: 'harness stageCheck package-local target test' }
const result = await stageCheck({ targetFile: 'src/App.vue' })
return result.summary`;

const stageCheckOutsidePackageTargetScript = `export const meta = { name: 'harness_stage_check_outside', description: 'harness stageCheck outside package target test' }
const result = await stageCheck({ targetFile: 'packages/api/src/foo.ts' })
return result.summary`;

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "harness-runtime-"));
}

function registryFromDescriptor(raw: Record<string, unknown>): HarnessConfigRegistry {
  const config = parseHarnessConfigDescriptor(JSON.stringify({ schemaVersion: 1, ...raw }), "project", "test.json");
  if (!config) throw new Error("test descriptor failed to parse");
  return new Map([[config.id, config]]);
}

function countingAgent() {
  const state = { calls: 0, toolNames: undefined as string[] | undefined };
  return {
    state,
    runner: {
      async run<TSchemaDef extends import("typebox").TSchema | undefined = undefined>(
        prompt: string,
        options: AgentRunOptions<TSchemaDef> = {},
      ): Promise<AgentRunResult<TSchemaDef>> {
        state.calls++;
        state.toolNames = options.toolNames;
        return `ran:${prompt}` as AgentRunResult<TSchemaDef>;
      },
    } satisfies Pick<WorkflowAgent, "run">,
  };
}

test("read-only harness expansion cannot add write tools", async () => {
  const cwd = tempCwd();
  try {
    const agent = countingAgent();
    await runWorkflow(oneAgentScript, {
      cwd,
      agent: agent.runner,
      persistLogs: false,
      readOnly: true,
      harness_config: "readonly-review",
      harnessConfigRegistry: registryFromDescriptor({
        id: "readonly-review",
        harness_type: "pi",
        tools: ["read", "write", "bash", "edit"],
      }),
    });

    assert.equal(agent.state.calls, 1);
    assert.deepEqual(agent.state.toolNames, ["read"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("non-pi harness types clean-skip without spawning agents", async () => {
  const cwd = tempCwd();
  try {
    const agent = countingAgent();
    const result = await runWorkflow(oneAgentScript, {
      cwd,
      agent: agent.runner,
      persistLogs: false,
      harness_type: "opencode",
      harness_config: "go-backend",
    });

    assert.equal(agent.state.calls, 0);
    assert.equal(result.agentCount, 0);
    assert.deepEqual(result.result, {
      status: "harness-not-wired",
      harness_type: "opencode",
      harness_config: "go-backend",
      reason: "Harness 'opencode' is not wired to the current runtime.",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("harness_config-only explicit selection preserves the descriptor runtime", async () => {
  const cwd = tempCwd();
  try {
    const agent = countingAgent();
    const result = await runWorkflow(oneAgentScript, {
      cwd,
      agent: agent.runner,
      persistLogs: false,
      harness_config: "go-backend",
      harnessConfigRegistry: registryFromDescriptor({ id: "go-backend", harness_type: "opencode" }),
    });

    assert.equal(agent.state.calls, 0);
    assert.equal(result.harnessSelection?.harness_type, "opencode");
    assert.equal(result.harnessSelection?.harness_config, "go-backend");
    assert.equal((result.result as { status?: string }).status, "harness-not-wired");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("explicit harness_type wins when supplied alongside harness_config", async () => {
  const cwd = tempCwd();
  try {
    const agent = countingAgent();
    const result = await runWorkflow(oneAgentScript, {
      cwd,
      agent: agent.runner,
      persistLogs: false,
      harness_type: "hermes",
      harness_config: "frontend-react-shadcn",
      harnessConfigRegistry: registryFromDescriptor({ id: "frontend-react-shadcn", harness_type: "pi" }),
    });

    assert.equal(agent.state.calls, 0);
    assert.equal(result.harnessSelection?.harness_type, "hermes");
    assert.equal(result.harnessSelection?.harness_config, "frontend-react-shadcn");
    assert.equal((result.result as { status?: string }).status, "harness-not-wired");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("explicit invalid harness_config clean-skips instead of running Pi defaults", async () => {
  const cwd = tempCwd();
  try {
    const agent = countingAgent();
    const result = await runWorkflow(oneAgentScript, {
      cwd,
      agent: agent.runner,
      persistLogs: false,
      harness_config: "bad-runtime",
      harnessConfigRegistry: registryFromDescriptor({ id: "bad-runtime", harness_type: "p1" }),
    });

    assert.equal(agent.state.calls, 0);
    assert.equal(result.harnessSelection?.harness_config, "bad-runtime");
    assert.equal((result.result as { status?: string }).status, "harness-not-wired");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("explicit pi harness_type can override an invalid descriptor runtime", async () => {
  const cwd = tempCwd();
  try {
    const agent = countingAgent();
    const result = await runWorkflow(oneAgentScript, {
      cwd,
      agent: agent.runner,
      persistLogs: false,
      harness_type: "pi",
      harness_config: "bad-runtime",
      harnessConfigRegistry: registryFromDescriptor({ id: "bad-runtime", harness_type: "p1" }),
    });

    assert.equal(agent.state.calls, 1);
    assert.equal(result.harnessSelection?.harness_type, "pi");
    assert.equal(result.harnessSelection?.harness_config, "bad-runtime");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--no-harness normalizes to a valid pi/none selection snapshot", async () => {
  const cwd = tempCwd();
  try {
    const agent = countingAgent();
    const result = await runWorkflow(oneAgentScript, {
      cwd,
      agent: agent.runner,
      persistLogs: false,
      harness_type: "none",
    });

    assert.equal(agent.state.calls, 1);
    assert.equal(result.harnessSelection?.harness_type, "pi");
    assert.equal(result.harnessSelection?.harness_config, "none");
    assert.equal(result.harnessSelection?.source, "explicit");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume uses persisted harnessSelection instead of re-detecting", async () => {
  const cwd = tempCwd();
  try {
    const persistedSelection: HarnessSelection = {
      harness_type: "opencode",
      harness_config: "persisted-go",
      source: "explicit",
      detectorVersion: 1,
    };
    const persistedRunState = {
      runId: "run-harness-persisted",
      workflowName: "harness_runtime",
      status: "failed",
      harnessSelection: serializeHarnessSelection(persistedSelection),
    } as PersistedRunState;
    const agent = countingAgent();

    const result = await runWorkflow(oneAgentScript, {
      cwd,
      agent: agent.runner,
      persistLogs: false,
      persistedRunState,
    });

    assert.equal(agent.state.calls, 0, "persisted opencode selection should skip before any agent call");
    assert.equal((result.result as { status?: string }).status, "harness-not-wired");
    assert.equal(result.harnessSelection?.harness_type, persistedSelection.harness_type);
    assert.equal(result.harnessSelection?.harness_config, persistedSelection.harness_config);
    assert.equal(result.harnessSelection?.source, persistedSelection.source);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("harness_config changes invalidate cached agent results", async () => {
  const cwd = tempCwd();
  try {
    const journal: JournalEntry[] = [];
    const first = countingAgent();
    await runWorkflow(oneAgentScript, {
      cwd,
      agent: first.runner,
      persistLogs: false,
      harness_config: "alpha",
      onAgentJournal: (entry) => journal.push(entry),
    });
    assert.equal(first.state.calls, 1);

    const same = countingAgent();
    await runWorkflow(oneAgentScript, {
      cwd,
      agent: same.runner,
      persistLogs: false,
      harness_config: "alpha",
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    });
    assert.equal(same.state.calls, 0, "same harness_config should replay cached result");

    const changed = countingAgent();
    await runWorkflow(oneAgentScript, {
      cwd,
      agent: changed.runner,
      persistLogs: false,
      harness_config: "beta",
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    });
    assert.equal(changed.state.calls, 1, "changed harness_config should miss the resume cache");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("expanded harness tool policy changes invalidate cached agent results", async () => {
  const cwd = tempCwd();
  try {
    const journal: JournalEntry[] = [];
    const first = countingAgent();
    await runWorkflow(oneAgentScript, {
      cwd,
      agent: first.runner,
      persistLogs: false,
      harness_config: "alpha",
      harnessConfigRegistry: registryFromDescriptor({ id: "alpha", harness_type: "pi", tools: ["read"] }),
      onAgentJournal: (entry) => journal.push(entry),
    });
    assert.equal(first.state.calls, 1);

    const changedPolicy = countingAgent();
    await runWorkflow(oneAgentScript, {
      cwd,
      agent: changedPolicy.runner,
      persistLogs: false,
      harness_config: "alpha",
      harnessConfigRegistry: registryFromDescriptor({ id: "alpha", harness_type: "pi", tools: ["read", "grep"] }),
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    });
    assert.equal(changedPolicy.state.calls, 1, "changed harness tools should miss the resume cache");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("harness stageCheck defaults supply cwd and rebase root-relative targets when a call omits cwd", async () => {
  const cwd = tempCwd();
  const packageCwd = join(cwd, "packages", "web");
  try {
    const seen: string[] = [];
    const result = await runWorkflow(stageCheckScript, {
      cwd,
      persistLogs: false,
      harness_config: "web",
      harnessConfigRegistry: registryFromDescriptor({
        id: "web",
        harness_type: "pi",
        stageCheck: { cwd: "packages/web" },
      }),
      stageCheck: async (options) => {
        seen.push(`${options.cwd ?? ""}:${options.targetFile ?? ""}`);
        return { ok: true, checks: [], summary: "ok" };
      },
    });

    assert.equal(result.result, "ok");
    assert.deepEqual(seen, [`${packageCwd}:src/App.vue`]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("harness stageCheck defaults preserve descriptor targetFile", async () => {
  const cwd = tempCwd();
  const packageCwd = join(cwd, "packages", "web");
  try {
    const seen: string[] = [];
    await runWorkflow(stageCheckDefaultTargetScript, {
      cwd,
      persistLogs: false,
      harness_config: "web",
      harnessConfigRegistry: registryFromDescriptor({
        id: "web",
        harness_type: "pi",
        stageCheck: { cwd: "packages/web", targetFile: "packages/web/src/App.vue" },
      }),
      stageCheck: async (options) => {
        seen.push(`${options.cwd ?? ""}:${options.targetFile ?? ""}`);
        return { ok: true, checks: [], summary: "ok" };
      },
    });

    assert.deepEqual(seen, [`${packageCwd}:src/App.vue`]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("harness stageCheck defaults keep package-local targetFile relative to the harness cwd", async () => {
  const cwd = tempCwd();
  const packageCwd = join(cwd, "packages", "web");
  try {
    const seen: string[] = [];
    await runWorkflow(stageCheckPackageLocalTargetScript, {
      cwd,
      persistLogs: false,
      harness_config: "web",
      harnessConfigRegistry: registryFromDescriptor({
        id: "web",
        harness_type: "pi",
        stageCheck: { cwd: "packages/web" },
      }),
      stageCheck: async (options) => {
        seen.push(`${options.cwd ?? ""}:${options.targetFile ?? ""}`);
        return { ok: true, checks: [], summary: "ok" };
      },
    });

    assert.deepEqual(seen, [`${packageCwd}:src/App.vue`]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("harness stageCheck defaults fall back to project root for sibling package targets", async () => {
  const cwd = tempCwd();
  try {
    const seen: string[] = [];
    await runWorkflow(stageCheckOutsidePackageTargetScript, {
      cwd,
      persistLogs: false,
      harness_config: "web",
      harnessConfigRegistry: registryFromDescriptor({
        id: "web",
        harness_type: "pi",
        stageCheck: { cwd: "apps/web" },
      }),
      stageCheck: async (options) => {
        seen.push(`${options.cwd ?? ""}:${options.targetFile ?? ""}`);
        return { ok: true, checks: [], summary: "ok" };
      },
    });

    assert.deepEqual(seen, [`${cwd}:packages/api/src/foo.ts`]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowManager persists the harness selection snapshot", async () => {
  const cwd = tempCwd();
  const fakeHome = mkdtempSync(join(tmpdir(), "harness-runtime-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd, agent: countingAgent().runner });
      await manager.runSync(oneAgentScript, undefined, { harness_config: "persisted-config" });
      const [persisted] = manager.listRuns();
      assert.ok(persisted);
      const selection = loadHarnessSelection(persisted);
      assert.equal(selection?.harness_type, "pi");
      assert.equal(selection?.harness_config, "persisted-config");
      assert.equal(selection?.source, "explicit");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
