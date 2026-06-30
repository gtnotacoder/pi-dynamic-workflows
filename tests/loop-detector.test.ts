import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LOOP_GUARD, LoopDetector } from "../src/loop-detector.js";
import { runWorkflow } from "../src/workflow.js";

test("LoopDetector: defaults are exported and sane", () => {
  assert.equal(DEFAULT_LOOP_GUARD.action, "warn");
  assert.ok(DEFAULT_LOOP_GUARD.maxConsecutive >= 2);
});

test("LoopDetector: fires on consecutive repeats", () => {
  const d = new LoopDetector({ maxConsecutive: 3, maxRepeats: 99, window: 12 });
  assert.equal(d.record("a").looping, false);
  assert.equal(d.record("a").looping, false);
  const v = d.record("a");
  assert.equal(v.looping, true);
  assert.equal(v.consecutive, 3);
  assert.match(v.reason ?? "", /in a row/);
});

test("LoopDetector: fires on windowed repeat count even when interleaved", () => {
  const d = new LoopDetector({ maxConsecutive: 99, maxRepeats: 3, window: 12 });
  assert.equal(d.record("a").looping, false);
  assert.equal(d.record("b").looping, false);
  assert.equal(d.record("a").looping, false);
  assert.equal(d.record("b").looping, false);
  const v = d.record("a"); // third "a" within window
  assert.equal(v.looping, true);
  assert.equal(v.count, 3);
});

test("LoopDetector: varied signatures never loop; window evicts old entries", () => {
  const d = new LoopDetector({ maxConsecutive: 3, maxRepeats: 3, window: 4 });
  for (let i = 0; i < 50; i++) assert.equal(d.record(`sig-${i}`).looping, false);
  assert.equal(d.size, 4, "window caps retained signatures");
  // Two old "a"s evicted before a third arrives → no false positive.
  d.reset();
  assert.equal(d.size, 0);
  assert.equal(d.record("a").looping, false);
  d.record("x");
  d.record("y");
  d.record("z");
  assert.equal(d.record("a").looping, false, "first a fell out of the 4-wide window");
});

test("loopGuard: warn-only (default) lets a repetitive script finish", async () => {
  const script = `export const meta = { name: 'lg', description: 'loop guard warn' }
let last
for (let i = 0; i < 8; i++) last = await agent('same prompt every time')
return last`;
  const res = await runWorkflow<string>(script, {
    agent: {
      async run() {
        return "ok";
      },
    },
    persistLogs: false,
  });
  assert.equal(res.result, "ok", "run completes despite the loop");
  assert.ok(
    res.logs.some((l) => /possible loop/.test(l)),
    "a loop warning was logged",
  );
});

test("loopGuard: action=abort hard-stops the runaway loop", async () => {
  const script = `export const meta = { name: 'lga', description: 'loop guard abort' }
for (let i = 0; i < 100; i++) await agent('identical')
return 'never'`;
  await assert.rejects(
    runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      persistLogs: false,
      loopGuard: { action: "abort", maxConsecutive: 3 },
    }),
    /loop guard tripped/,
  );
});

test("loopGuard: ignored tier is excluded when explicit model wins", async () => {
  const script = `export const meta = { name: 'lgm', description: 'loop guard model' }
await agent('same', { label: 'x', model: 'provider/model', tier: 'small' })
await agent('same', { label: 'x', model: 'provider/model', tier: 'big' })
return 'never'`;
  await assert.rejects(
    runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      persistLogs: false,
      loopGuard: { action: "abort", maxConsecutive: 2 },
    }),
    /loop guard tripped/,
  );
});
