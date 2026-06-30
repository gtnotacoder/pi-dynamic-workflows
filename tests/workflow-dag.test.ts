import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";
import { type DagNode, runDag, validateDag, type WaveResult } from "../src/workflow-dag.js";

// A trivial wave executor that runs each node's run() and never throws fatally.
const runWaveSafe = async <T>(batch: ReadonlyArray<{ node: DagNode<T>; deps: Record<string, T> }>) =>
  Promise.all(
    batch.map(async ({ node, deps }): Promise<WaveResult<T>> => {
      try {
        return { id: node.id, ok: true, value: await node.run(deps) };
      } catch (e) {
        return { id: node.id, ok: false, error: (e as Error).message };
      }
    }),
  );

test("validateDag: rejects duplicate ids, missing deps, and cycles", () => {
  assert.throws(
    () =>
      validateDag([
        { id: "a", run: () => 1 },
        { id: "a", run: () => 2 },
      ]),
    /duplicate/,
  );
  assert.throws(() => validateDag([{ id: "a", dependsOn: ["x"], run: () => 1 }]), /unknown id/);
  assert.throws(
    () =>
      validateDag([
        { id: "a", dependsOn: ["b"], run: () => 1 },
        { id: "b", dependsOn: ["a"], run: () => 2 },
      ]),
    /cycle/,
  );
});

test("runDag: fan-in — D waits on B and C, sees their results", async () => {
  const order: string[] = [];
  const out = await runDag<string>(
    [
      {
        id: "a",
        run: () => {
          order.push("a");
          return "A";
        },
      },
      {
        id: "b",
        dependsOn: ["a"],
        run: () => {
          order.push("b");
          return "B";
        },
      },
      {
        id: "c",
        dependsOn: ["a"],
        run: () => {
          order.push("c");
          return "C";
        },
      },
      {
        id: "d",
        dependsOn: ["b", "c"],
        run: (deps) => {
          order.push("d");
          return `${deps.b}+${deps.c}`;
        },
      },
    ],
    runWaveSafe,
  );
  assert.equal(out.ok, true);
  assert.equal(out.results.d, "B+C");
  assert.equal(order[0], "a", "root ran first");
  assert.equal(order.at(-1), "d", "fan-in ran last");
});

test("runDag: a failed node cascade-skips its transitive dependents", async () => {
  const ran: string[] = [];
  const out = await runDag<string>(
    [
      {
        id: "ok",
        run: () => {
          ran.push("ok");
          return "ok";
        },
      },
      {
        id: "boom",
        run: () => {
          ran.push("boom");
          throw new Error("kaboom");
        },
      },
      {
        id: "child",
        dependsOn: ["boom"],
        run: () => {
          ran.push("child");
          return "x";
        },
      },
      {
        id: "grandchild",
        dependsOn: ["child"],
        run: () => {
          ran.push("grandchild");
          return "y";
        },
      },
    ],
    runWaveSafe,
  );
  assert.equal(out.ok, false);
  assert.equal(out.status.ok, "done");
  assert.equal(out.status.boom, "failed");
  assert.equal(out.status.child, "skipped");
  assert.equal(out.status.grandchild, "skipped");
  assert.equal(out.skipped.child, "boom", "skip attributed to the failed upstream");
  assert.equal(out.skipped.grandchild, "child");
  assert.ok(!ran.includes("child"), "skipped nodes never run");
  assert.ok(!ran.includes("grandchild"));
});

test("runDag: independent branch still completes when a sibling branch fails", async () => {
  const out = await runDag<string>(
    [
      { id: "x", run: () => "X" },
      { id: "x2", dependsOn: ["x"], run: () => "X2" },
      {
        id: "y",
        run: () => {
          throw new Error("dead");
        },
      },
      { id: "y2", dependsOn: ["y"], run: () => "Y2" },
    ],
    runWaveSafe,
  );
  assert.equal(out.status.x2, "done", "healthy branch finishes");
  assert.equal(out.status.y2, "skipped", "dead branch skips");
  assert.equal(out.ok, false);
});

// ── Integration: the real dag() vm primitive inside a workflow script ──

test("dag(): wired primitive runs agent() nodes with dependency results", async () => {
  const script = `export const meta = { name: 'd', description: 'dag' }
const out = await dag([
  { id: 'fetch', run: async () => await agent('fetch data') },
  { id: 'parse', dependsOn: ['fetch'], run: async (deps) => 'parsed:' + deps.fetch },
  { id: 'report', dependsOn: ['parse'], run: async (deps) => deps.parse + ':report' },
])
return { ok: out.ok, report: out.results.report }`;
  const res = await runWorkflow<{ ok: boolean; report: string }>(script, {
    agent: {
      async run() {
        return "RAW";
      },
    },
    persistLogs: false,
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.report, "parsed:RAW:report");
});

test("dag(): node failure inside a script cascade-skips dependents, run survives", async () => {
  const script = `export const meta = { name: 'ds', description: 'dag skip' }
const out = await dag([
  { id: 'good', run: async () => 'g' },
  { id: 'bad', run: async () => { throw new Error('node boom') } },
  { id: 'after', dependsOn: ['bad'], run: async () => 'unreached' },
])
return { ok: out.ok, status: out.status, skipped: out.skipped }`;
  const res = await runWorkflow<{
    ok: boolean;
    status: Record<string, string>;
    skipped: Record<string, string>;
  }>(script, {
    agent: {
      async run() {
        return "ok";
      },
    },
    persistLogs: false,
  });
  assert.equal(res.result.ok, false);
  assert.equal(res.result.status.good, "done");
  assert.equal(res.result.status.bad, "failed");
  assert.equal(res.result.status.after, "skipped");
  assert.equal(res.result.skipped.after, "bad");
});

test("dag(): invalid graph surfaces as a validation error", async () => {
  const script = `export const meta = { name: 'dv', description: 'dag validate' }
return await dag([{ id: 'a', dependsOn: ['nope'], run: async () => 1 }])`;
  await assert.rejects(
    runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      persistLogs: false,
    }),
    /unknown id/,
  );
});
