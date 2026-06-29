import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ConductorRunStatus } from "../src/conductor-types.js";
import {
  type ActiveRunView,
  herdrPaneTarget,
  installHerdrReporter,
  summarizeActiveRuns,
} from "../src/herdr-reporter.js";

const agents = (spec: Array<[status: string, tokens?: number]>): ActiveRunView["agents"] =>
  spec.map(([status, tokens]) => ({ status, tokens }));

// ── summarizeActiveRuns (pure) ──────────────────────────────────────────────

test("summarizeActiveRuns: no active runs → null (clears the cell)", () => {
  assert.equal(summarizeActiveRuns([]), null);
});

test("summarizeActiveRuns: single run shows name, phase, done/total, tokens", () => {
  const s = summarizeActiveRuns([
    {
      workflowName: "research_topic",
      status: "running",
      currentPhase: "Synthesize",
      agents: agents([["done"], ["done"], ["running", 1200], ["pending"]]),
    },
  ]);
  assert.equal(s, "◆ research_topic Synthesize 2/4 · 1.2K tok");
});

test("summarizeActiveRuns: paused run uses the pause glyph", () => {
  const s = summarizeActiveRuns([{ workflowName: "wf", status: "paused", agents: agents([["done"], ["pending"]]) }]);
  assert.ok(s?.startsWith("⏸ wf"), s ?? "(null)");
});

test("summarizeActiveRuns: semantic status overrides icon and appends label", () => {
  const semanticStatus: ConductorRunStatus = { status: "needs-human", reason: "blocked on review" };
  const s = summarizeActiveRuns([
    { workflowName: "wf", status: "running", agents: agents([["done"]]), semanticStatus },
  ]);
  // ? icon (needs-human) + "Needs human" label from the conductor taxonomy.
  assert.ok(s?.startsWith("? wf"), s ?? "(null)");
  assert.ok(s?.includes("Needs human"), s ?? "(null)");
});

test("summarizeActiveRuns: multiple runs aggregate and flag attention", () => {
  const needsFinalize: ConductorRunStatus = { status: "needs-finalize", reason: "awaiting finalize" };
  const s = summarizeActiveRuns([
    { workflowName: "a", status: "running", agents: agents([["done"], ["running", 500]]) },
    { workflowName: "b", status: "running", agents: agents([["done"], ["done"]]), semanticStatus: needsFinalize },
  ]);
  assert.equal(s, "◆ 2 workflows · 3/4 agents · 500 tok · 1 need attention");
});

// ── herdrPaneTarget (feature detection) ─────────────────────────────────────

test("herdrPaneTarget: returns the pane id when inside herdr", () => {
  assert.equal(herdrPaneTarget({ HERDR_PANE_ID: "wH:p4" } as NodeJS.ProcessEnv), "wH:p4");
});

test("herdrPaneTarget: null when not in herdr", () => {
  assert.equal(herdrPaneTarget({} as NodeJS.ProcessEnv), null);
});

test("herdrPaneTarget: opt-out wins even inside herdr", () => {
  assert.equal(herdrPaneTarget({ HERDR_PANE_ID: "wH:p4", PI_WORKFLOWS_HERDR: "0" } as NodeJS.ProcessEnv), null);
});

// ── installHerdrReporter (event wiring) ─────────────────────────────────────

/** Minimal stand-in for WorkflowManager: an EventEmitter + the read methods used. */
class FakeManager extends EventEmitter {
  runs: Array<{ runId: string; status: string; workflowName: string; agents: ActiveRunView["agents"] }> = [];
  live = new Map<
    string,
    { background?: boolean; snapshot?: { name?: string; currentPhase?: string; agents?: ActiveRunView["agents"] } }
  >();
  listRuns() {
    return this.runs;
  }
  getRun(runId: string) {
    return this.live.get(runId);
  }
}

test("installHerdrReporter: no-op when not inside herdr", () => {
  const mgr = new FakeManager();
  const calls: string[][] = [];
  installHerdrReporter(mgr as never, { env: {} as NodeJS.ProcessEnv, run: (a) => calls.push(a) });
  mgr.emit("agentEnd", {});
  assert.equal(calls.length, 0);
  assert.equal(mgr.listenerCount("agentEnd"), 0);
});

test("installHerdrReporter: enabled:false is a no-op even inside herdr", () => {
  const mgr = new FakeManager();
  const calls: string[][] = [];
  installHerdrReporter(mgr as never, { paneId: "wH:p4", enabled: false, run: (a) => calls.push(a), throttleMs: 0 });
  mgr.emit("agentEnd", {});
  assert.equal(calls.length, 0);
  assert.equal(mgr.listenerCount("agentEnd"), 0);
});

test("installHerdrReporter: pushes a custom-status frame on activity", async () => {
  const mgr = new FakeManager();
  const calls: string[][] = [];
  mgr.runs = [{ runId: "r1", status: "running", workflowName: "demo", agents: agents([["done"], ["running", 300]]) }];
  installHerdrReporter(mgr as never, {
    paneId: "wH:p4",
    run: (a) => calls.push(a),
    throttleMs: 0,
  });
  mgr.emit("agentEnd", { runId: "r1" });
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(calls.length, 1);
  const argv = calls[0];
  assert.deepEqual(argv.slice(0, 6), [
    "pane",
    "report-metadata",
    "wH:p4",
    "--source",
    "pi-workflows",
    "--applies-to-source",
  ]);
  assert.ok(argv.includes("--custom-status"));
  assert.ok(argv.includes("--ttl-ms"));
  const status = argv[argv.indexOf("--custom-status") + 1];
  assert.equal(status, "◆ demo 1/2 · 300 tok");
});

test("installHerdrReporter: clears the cell when the last run finishes, and notifies", async () => {
  const mgr = new FakeManager();
  const calls: string[][] = [];
  mgr.runs = [{ runId: "r1", status: "running", workflowName: "demo", agents: agents([["running", 10]]) }];
  mgr.live.set("r1", { background: true, snapshot: { name: "demo" } });
  installHerdrReporter(mgr as never, { paneId: "wH:p4", run: (a) => calls.push(a), throttleMs: 0 });

  // run finishes: listRuns now reports it complete (not active)
  mgr.runs = [{ runId: "r1", status: "completed", workflowName: "demo", agents: agents([["done", 42]]) }];
  mgr.emit("complete", { runId: "r1" });
  await new Promise((r) => setTimeout(r, 5));

  const cleared = calls.find((a) => a.includes("--clear-custom-status"));
  assert.ok(cleared, "expected a --clear-custom-status frame");
  const notified = calls.find((a) => a[0] === "notification");
  assert.ok(notified, "expected a desktop notification");
  assert.deepEqual(notified?.slice(0, 2), ["notification", "show"]);
  assert.ok(notified?.includes("--sound"));
});

test("installHerdrReporter: is idempotent across re-install", () => {
  const mgr = new FakeManager();
  const run = () => {};
  installHerdrReporter(mgr as never, { paneId: "wH:p4", run, throttleMs: 0 });
  installHerdrReporter(mgr as never, { paneId: "wH:p4", run, throttleMs: 0 });
  assert.equal(mgr.listenerCount("agentEnd"), 1);
});
