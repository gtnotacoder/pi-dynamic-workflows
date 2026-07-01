import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCompactionEventTail,
  emitCompactionTelemetry,
  normalizeCompactionEvent,
  onCompactionTelemetry,
  readCompactionEvents,
  summarizeCompactionEvents,
} from "../src/compaction-telemetry.js";

test("normalizeCompactionEvent maps autocompactor JSONL fields into a stable schema", () => {
  const event = normalizeCompactionEvent({
    type: "monitor_eval",
    session_id: "session-1",
    context_tokens: 230_017,
    effective_window: 232_000,
    occupancy: 0.9915,
    stale_frac: 0.9,
    signals: ["stale output"],
    cache_read_pct: 0.996,
    cache_hot: true,
    suppressed_by_cache_hot: true,
    compaction_policy: "aggressive-local",
    compaction_policy_reason: "local/no-cache model",
    compaction_cache_value: "none",
    compaction_keep_recent_tokens: 12000,
    inventory: { huge: "redacted" },
    ts: "2026-06-27T07:00:00Z",
  });

  assert.equal(event?.type, "monitor_eval");
  assert.equal(event?.sessionId, "session-1");
  assert.equal(event?.contextTokens, 230_017);
  assert.equal(event?.cacheReadPct, 0.996);
  assert.equal(event?.suppressedByCacheHot, true);
  assert.equal(event?.compactionPolicy, "aggressive-local");
  assert.equal(event?.compactionPolicyReason, "local/no-cache model");
  assert.equal(event?.compactionCacheValue, "none");
  assert.equal(event?.compactionKeepRecentTokens, 12000);
  assert.equal((event as unknown as { inventory?: unknown }).inventory, undefined);
});

test("normalizeCompactionEvent preserves an explicit telemetry source", () => {
  const event = normalizeCompactionEvent({ type: "workflow_compaction_policy", source: "openai/gpt-5" });

  assert.equal(event?.source, "openai/gpt-5");
});

test("normalizeCompactionEvent keeps rawType tied to an explicit source discriminator", () => {
  const fromEvent = normalizeCompactionEvent({ event: "legacy_precompact" });
  assert.equal(fromEvent?.type, "legacy_precompact");
  assert.equal(fromEvent?.rawType, "legacy_precompact");

  const fallback = normalizeCompactionEvent({ session_id: "s1" });
  assert.equal(fallback?.type, "compaction_event");
  assert.equal(fallback?.rawType, undefined);
});

test("readCompactionEvents filters JSONL by time window and session", () => {
  const dir = mkdtempSync(join(tmpdir(), "compaction-events-"));
  const file = join(dir, "events.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "monitor_eval", session_id: "a", ts: "2026-06-27T00:00:00Z" }),
      JSON.stringify({ type: "precompact", session_id: "b", ts: "2026-06-27T01:00:00Z" }),
      "not-json",
      JSON.stringify({ type: "reinject", session_id: "a", ts: "2026-06-27T02:00:00Z" }),
    ].join("\n"),
  );

  const events = readCompactionEvents({
    filePath: file,
    sessionId: "a",
    since: new Date("2026-06-27T00:30:00Z"),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "reinject");
});

test("readCompactionEvents maxBytes tailing preserves multibyte emoji phase", () => {
  const dir = mkdtempSync(join(tmpdir(), "compaction-events-multibyte-"));
  const filePath = join(dir, "events.jsonl");
  const emoji = "🎉🎊🎎🎏";
  const oldLine = JSON.stringify({
    type: "precompact",
    session_id: "s1",
    phase: `warmup ${emoji}`,
    ts: "2026-06-27T00:00:00Z",
  });
  const finalLine = JSON.stringify({
    type: "monitor_eval",
    session_id: "s2",
    phase: `review ${emoji}`,
    ts: "2026-06-27T01:00:00Z",
  });
  writeFileSync(filePath, `${oldLine}\n${finalLine}\n`);
  const maxBytes = Buffer.byteLength(`${finalLine}\n`);
  const events = readCompactionEvents({ filePath, maxBytes });
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, `review ${emoji}`);
});

test("createCompactionEventTail incremental offsets survive multibyte UTF-8", () => {
  const dir = mkdtempSync(join(tmpdir(), "compaction-tail-multibyte-"));
  const filePath = join(dir, "events.jsonl");
  const emoji = "🎉🎊🎎🎏";
  const firstLine = JSON.stringify({
    type: "precompact",
    session_id: "s1",
    phase: `batch ${emoji}`,
    ts: "2026-06-27T00:00:00Z",
  });
  const secondLine = JSON.stringify({
    type: "monitor_eval",
    session_id: "s2",
    phase: `final ${emoji}`,
    ts: "2026-06-27T01:00:00Z",
  });
  writeFileSync(filePath, `${firstLine}\n`);
  const tail = createCompactionEventTail({ filePath, startAtEnd: false });
  const firstEvents = tail.read();
  assert.equal(firstEvents.length, 1);
  assert.equal(firstEvents[0].phase, `batch ${emoji}`);
  appendFileSync(filePath, `${secondLine}\n`);
  const secondEvents = tail.read();
  assert.equal(secondEvents.length, 1);
  assert.equal(secondEvents[0].phase, `final ${emoji}`);
});

test("createCompactionEventTail preserves partial trailing JSONL until newline arrives", () => {
  const dir = mkdtempSync(join(tmpdir(), "compaction-tail-partial-"));
  const filePath = join(dir, "events.jsonl");
  const line = JSON.stringify({ type: "monitor_eval", session_id: "s-partial", ts: "2026-06-27T03:00:00Z" });
  writeFileSync(filePath, "");
  const tail = createCompactionEventTail({ filePath, startAtEnd: false });

  appendFileSync(filePath, line.slice(0, -2));
  assert.equal(tail.read().length, 0, "partial line should not be parsed or dropped");
  appendFileSync(filePath, `${line.slice(-2)}\n`);

  const events = tail.read();
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, "s-partial");
});

test("summarizeCompactionEvents captures suppression and over-window counts", () => {
  const summary = summarizeCompactionEvents([
    { type: "monitor_eval", recommended: true, occupancy: 1.1, suppressedByCacheHot: true },
    { type: "precompact", occupancy: 0.8 },
  ]);

  assert.equal(summary.total, 2);
  assert.equal(summary.byType.monitor_eval, 1);
  assert.equal(summary.recommended, 1);
  assert.equal(summary.suppressedByCacheHot, 1);
  assert.equal(summary.overEffectiveWindow, 1);
  assert.equal(summary.maxOccupancy, 1.1);
});

test("emitCompactionTelemetry notifies subscribers with normalized events", () => {
  const seen: unknown[] = [];
  const unsubscribe = onCompactionTelemetry((event) => seen.push(event));
  try {
    const event = emitCompactionTelemetry({ type: "monitor_eval", workflowRunId: "run-1" });
    assert.equal(event?.workflowRunId, "run-1");
    assert.ok(event?.timestamp, "runtime-emitted events receive a correlation timestamp");
    assert.equal(seen.length, 1);
  } finally {
    unsubscribe();
  }
});

test("emitCompactionTelemetry survives a failing subscriber and continues notifying downstream listeners", () => {
  const recorded: string[] = [];
  const unsub1 = onCompactionTelemetry(() => {
    throw new Error("subscriber-1 failed");
  });
  const unsub2 = onCompactionTelemetry((event) => {
    recorded.push(event.type);
  });
  try {
    const event = emitCompactionTelemetry({ type: "monitor_eval" });
    assert.equal(event?.type, "monitor_eval");
    assert.deepStrictEqual(recorded, ["monitor_eval"]);
  } finally {
    unsub1();
    unsub2();
  }
});
