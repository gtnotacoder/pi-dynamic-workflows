import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { type HarnessConfigRegistry, parseHarnessConfigDescriptor } from "../src/harness-config.js";
import { type HarnessSelection, serializeHarnessSelection } from "../src/harness-selector.js";
import { loadHarnessSelection, type PersistedRunState } from "../src/run-persistence.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const oneAgentScript = `export const meta = { name: 'harness_runtime', description: 'harness runtime test' }
const result = await agent('do it', { label: 'worker' })
return result`;

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "harness-runtime-"));
}

function registryFromDescriptor(raw: Record<string, unknown>): HarnessConfigRegistry {
  const config = parseHarnessConfigDescriptor(JSON.stringify({ schemaVersion: 1, ...raw }), "project", "test.json");
  assert.ok(config);
  return new Map([[config.id, config]]);
}

function countingAgent() {
  const state = { calls: 0, toolNames: undefined as string[] | undefined };
  return {
    state,
    runner: {
      async run(prompt: string, options?: { toolNames?: string[]; onUsage?: (usage: AgentUsage) => void }) {
        state.calls++;
        state.toolNames = options?.toolNames;
        return `ran:${prompt}`;
      },
    },
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
