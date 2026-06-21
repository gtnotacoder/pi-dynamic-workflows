import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { saveWorkflowSettings } from "../src/workflow-settings.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const DEFAULT_CWD = "/tmp";

/**
 * EDIT 5 — subagent transcript logging (debuggability).
 *
 * Native Claude Code writes an incremental NDJSON transcript `agent-<id>.jsonl`
 * per subagent and surfaces the transcript dir on failure. The plugin previously
 * used `SessionManager.inMemory()`, so the whole subagent message stream was
 * discarded on disposal. These tests verify the plumbing that fixes that:
 *   - a run gets a `transcriptDir` under `<runsDir>/<runId>/subagents` (created);
 *   - that dir is threaded through `runWorkflow` into every `agent()` call;
 *   - the dir is surfaced in the failure `<recovery>` (EDIT 3) and on async launch;
 *   - the user can opt out via `persistSubagentTranscripts: false`;
 *   - the persisting SessionManager we delegate to really does write NDJSON.
 *
 * The mock agent records `options.transcriptDir` so we can assert threading
 * without burning model tokens; the actual `.jsonl` writing is pi's
 * `SessionManager.create` (verified directly in the last test).
 */

const twoAgentScript = `export const meta = { name: 'transcript_demo', description: 'two agents' }
phase('Work')
const a = await agent('do A', { label: 'a' })
const b = await agent('do B', { label: 'b' })
return { a, b }`;

/** Agent runner that records the transcriptDir it was handed per call. */
class TranscriptRecordingAgent {
  calls: Array<{ prompt: string; transcriptDir?: string }> = [];

  async run(prompt: string, options: { transcriptDir?: string; onUsage?: (u: unknown) => void }) {
    this.calls.push({ prompt, transcriptDir: options.transcriptDir });
    options.onUsage?.({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 10,
      cost: 0,
    });
    return `result:${prompt}`;
  }
}

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tx-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

/** Find the just-completed run from a fresh manager, asserting it exists. */
function completedRun(manager: WorkflowManager) {
  const run = manager.listRuns().find((r) => r.status === "completed");
  assert.ok(run, "run should complete");
  return run;
}

test(
  "runSync gives the managed run a transcriptDir under <runsDir>/<runId>/subagents and creates it",
  withTempCwd(async (cwd) => {
    const rec = new TranscriptRecordingAgent();
    const manager = new WorkflowManager({ cwd, agent: rec as never });
    const runsDir = workflowProjectPaths(cwd).runsDir;

    await manager.runSync(twoAgentScript);

    const run = completedRun(manager);
    const expectedDir = join(runsDir, run.runId, "subagents");
    // The in-memory managed run carries the transcript dir...
    const live = manager.getRun(run.runId);
    assert.equal(live?.transcriptDir, expectedDir, "managed.transcriptDir is <runsDir>/<runId>/subagents");
    // ...and it was created on disk.
    assert.ok(existsSync(expectedDir), "transcriptDir was created on disk");
  }),
);

test(
  "the transcriptDir is threaded into every agent() call",
  withTempCwd(async (cwd) => {
    const rec = new TranscriptRecordingAgent();
    const manager = new WorkflowManager({ cwd, agent: rec as never });

    await manager.runSync(twoAgentScript);

    assert.equal(rec.calls.length, 2, "two agents ran");
    const dir = rec.calls[0].transcriptDir;
    assert.ok(dir, "agent run was given a transcriptDir");
    assert.ok(dir.endsWith(join("subagents")), "transcriptDir ends with 'subagents'");
    // Both agents share the same run-level transcript dir.
    assert.equal(rec.calls[0].transcriptDir, rec.calls[1].transcriptDir, "both agents share the dir");
  }),
);

test(
  "persistSubagentTranscripts: false opts out — no transcriptDir is set or threaded",
  withTempCwd(async (cwd) => {
    // Persist the opt-out BEFORE constructing the manager (it reads settings once).
    saveWorkflowSettings({ persistSubagentTranscripts: false }, { cwd });
    const rec = new TranscriptRecordingAgent();
    const manager = new WorkflowManager({ cwd, agent: rec as never });

    await manager.runSync(twoAgentScript);

    const run = completedRun(manager);
    const live = manager.getRun(run.runId);
    assert.equal(live?.transcriptDir, undefined, "transcriptDir is undefined when opted out");
    for (const call of rec.calls) {
      assert.equal(call.transcriptDir, undefined, "agent run was NOT given a transcriptDir");
    }
  }),
);

test(
  "startInBackground also sets a transcriptDir (background runs are debuggable too)",
  withTempCwd(async (cwd) => {
    const rec = new TranscriptRecordingAgent();
    const manager = new WorkflowManager({ cwd, agent: rec as never });
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await promise;

    const live = manager.getRun(runId);
    assert.ok(live, "background run is registered");
    assert.ok(live.transcriptDir, "background run has a transcriptDir");
    assert.ok(live.transcriptDir.includes(runId), "transcriptDir is scoped to the runId");
    assert.ok(existsSync(live.transcriptDir), "transcriptDir was created");
    assert.equal(rec.calls.length, 2, "two agents ran in the background");
    assert.equal(rec.calls[0].transcriptDir, live.transcriptDir, "threaded to agent calls");
  }),
);

test("SessionManager.create(cwd, dir) writes one NDJSON .jsonl per session (the mechanism we delegate to)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-sm-"));
  try {
    const sm = SessionManager.create(DEFAULT_CWD, dir);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello subagent" }],
    } as never);
    // pi flushes the transcript to disk only once an assistant turn arrives
    // (a session with no response is not worth persisting), so append one.
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi back" }],
    } as never);
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(files.length, 1, "exactly one .jsonl transcript per session");
    const raw = readFileSync(join(dir, files[0]), "utf-8").trim();
    const lines = raw.split("\n");
    for (const line of lines) {
      // Every line must be valid JSON (NDJSON).
      assert.doesNotThrow(() => JSON.parse(line), "transcript line is NDJSON");
    }
    assert.ok(raw.includes("hello subagent"), "the user message was persisted");
    assert.ok(raw.includes("hi back"), "the assistant turn was persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
