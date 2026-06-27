import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
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
    inventory: { huge: "redacted" },
    ts: "2026-06-27T07:00:00Z",
  });

  assert.equal(event?.type, "monitor_eval");
  assert.equal(event?.sessionId, "session-1");
  assert.equal(event?.contextTokens, 230_017);
  assert.equal(event?.cacheReadPct, 0.996);
  assert.equal(event?.suppressedByCacheHot, true);
  assert.equal((event as unknown as { inventory?: unknown }).inventory, undefined);
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
    assert.equal(seen.length, 1);
  } finally {
    unsubscribe();
  }
});
