import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CompactionEventKind = "monitor_eval" | "precompact" | "reinject" | "compaction_result" | string;

export interface CompactionTelemetryEvent {
  type: CompactionEventKind;
  timestamp?: string;
  sessionId?: string;
  workflowRunId?: string;
  host?: string;
  phase?: string;
  trigger?: string;
  contextTokens?: number;
  effectiveWindow?: number;
  configuredWindow?: number;
  runtimeContextWindow?: number;
  reserve?: number;
  windowSource?: string;
  occupancy?: number;
  staleFrac?: number;
  signals?: string[];
  estReclaim?: number;
  estReclaimFloor?: number;
  estReclaimInventory?: number;
  estReclaimSource?: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheReadPct?: number;
  cacheHot?: boolean;
  recommended?: boolean;
  suppressedByCooldown?: boolean;
  suppressedByCacheHot?: boolean;
  beforeTokens?: number;
  afterTokens?: number;
  currentTokens?: number;
  digestTokens?: number;
  compactor?: string;
  compactionPolicy?: string;
  compactionPolicyReason?: string;
  compactionCacheValue?: string;
  compactionKeepRecentTokens?: number;
  error?: string;
  source?: string;
  rawType?: string;
}

export interface CompactionEventsReadOptions {
  filePath?: string;
  since?: Date;
  until?: Date;
  sessionId?: string;
  workflowRunId?: string;
  limit?: number;
  maxBytes?: number;
}

export interface CompactionEventSummary {
  total: number;
  byType: Record<string, number>;
  recommended: number;
  suppressedByCooldown: number;
  suppressedByCacheHot: number;
  cacheHot: number;
  maxOccupancy?: number;
  maxContextTokens?: number;
  maxEstReclaim?: number;
  overEffectiveWindow: number;
  recent: CompactionTelemetryEvent[];
}

export const DEFAULT_AUTOCOMPACTOR_EVENTS_PATH = join(homedir(), ".autocompactor", "pi", "stats", "events.jsonl");

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIMIT = 500;

type Listener = (event: CompactionTelemetryEvent) => void;

const listeners = new Set<Listener>();
let lastRuntimeTimestampMs = 0;

export function onCompactionTelemetry(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitCompactionTelemetry(raw: unknown, source = "runtime-api"): CompactionTelemetryEvent | null {
  const event = normalizeCompactionEvent(withRuntimeTimestamp(raw), source);
  if (!event) return null;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Listener failures must not prevent downstream telemetry subscribers from observing this event.
    }
  }
  return event;
}

function withRuntimeTimestamp(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const value = raw as Record<string, unknown>;
  if (value.ts !== undefined || value.timestamp !== undefined || value.time !== undefined) return raw;
  return { ...value, timestamp: nextRuntimeTimestamp() };
}

function nextRuntimeTimestamp(): string {
  const now = Date.now();
  const timestampMs = now <= lastRuntimeTimestampMs ? lastRuntimeTimestampMs + 1 : now;
  lastRuntimeTimestampMs = timestampMs;
  return new Date(timestampMs).toISOString();
}

export function normalizeCompactionEvent(raw: unknown, source = "unknown"): CompactionTelemetryEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const rawType = stringField(value.type) ?? stringField(value.event);
  const type = rawType ?? "compaction_event";
  const timestamp = stringField(value.ts) ?? stringField(value.timestamp) ?? stringField(value.time);
  const event: CompactionTelemetryEvent = {
    type,
    timestamp,
    sessionId: stringField(value.session_id) ?? stringField(value.sessionId),
    workflowRunId: stringField(value.workflow_run_id) ?? stringField(value.workflowRunId) ?? stringField(value.runId),
    host: stringField(value.host),
    phase: stringField(value.phase) ?? stringField(value.post_phase),
    trigger: stringField(value.trigger),
    contextTokens: numberField(value.context_tokens) ?? numberField(value.contextTokens),
    effectiveWindow: numberField(value.effective_window) ?? numberField(value.effectiveWindow),
    configuredWindow: numberField(value.configured_window) ?? numberField(value.configuredWindow),
    runtimeContextWindow: numberField(value.runtime_context_window) ?? numberField(value.runtimeContextWindow),
    reserve: numberField(value.reserve),
    windowSource: stringField(value.window_source) ?? stringField(value.windowSource),
    occupancy: numberField(value.occupancy),
    staleFrac: numberField(value.stale_frac) ?? numberField(value.staleFrac),
    signals: stringArrayField(value.signals),
    estReclaim: numberField(value.est_reclaim) ?? numberField(value.estReclaim),
    estReclaimFloor: numberField(value.est_reclaim_floor) ?? numberField(value.estReclaimFloor),
    estReclaimInventory: numberField(value.est_reclaim_inventory) ?? numberField(value.estReclaimInventory),
    estReclaimSource: stringField(value.est_reclaim_source) ?? stringField(value.estReclaimSource),
    cacheReadTokens: numberField(value.cache_read_tokens) ?? numberField(value.cacheReadTokens),
    cacheWriteTokens: numberField(value.cache_write_tokens) ?? numberField(value.cacheWriteTokens),
    cacheReadPct: numberField(value.cache_read_pct) ?? numberField(value.cacheReadPct),
    cacheHot: boolField(value.cache_hot) ?? boolField(value.cacheHot),
    recommended: boolField(value.recommended),
    suppressedByCooldown: boolField(value.suppressed_by_cooldown) ?? boolField(value.suppressedByCooldown),
    suppressedByCacheHot: boolField(value.suppressed_by_cache_hot) ?? boolField(value.suppressedByCacheHot),
    beforeTokens: numberField(value.before_tokens) ?? numberField(value.beforeTokens),
    afterTokens: numberField(value.after_tokens) ?? numberField(value.afterTokens),
    currentTokens:
      numberField(value.current_tokens) ?? numberField(value.currentTokens) ?? numberField(value.post_tokens),
    digestTokens: numberField(value.digest_tokens) ?? numberField(value.digestTokens),
    compactor: stringField(value.compactor),
    compactionPolicy: stringField(value.compaction_policy) ?? stringField(value.compactionPolicy),
    compactionPolicyReason: stringField(value.compaction_policy_reason) ?? stringField(value.compactionPolicyReason),
    compactionCacheValue: stringField(value.compaction_cache_value) ?? stringField(value.compactionCacheValue),
    compactionKeepRecentTokens:
      numberField(value.compaction_keep_recent_tokens) ?? numberField(value.compactionKeepRecentTokens),
    error: stringField(value.error),
    source: stringField(value.source) ?? source,
    rawType,
  };
  return compactObject(event as unknown as Record<string, unknown>) as unknown as CompactionTelemetryEvent;
}

export function readCompactionEvents(options: CompactionEventsReadOptions = {}): CompactionTelemetryEvent[] {
  const filePath = options.filePath ?? DEFAULT_AUTOCOMPACTOR_EVENTS_PATH;
  const text = readTail(filePath, options.maxBytes ?? DEFAULT_MAX_BYTES);
  if (!text) return [];
  const events: CompactionTelemetryEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const event = normalizeCompactionEvent(parsed, filePath);
    if (!event || !matchesCompactionFilter(event, options)) continue;
    events.push(event);
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  return events.slice(Math.max(0, events.length - limit));
}

export function summarizeCompactionEvents(
  events: CompactionTelemetryEvent[],
  recentLimit = 10,
): CompactionEventSummary {
  const summary: CompactionEventSummary = {
    total: events.length,
    byType: {},
    recommended: 0,
    suppressedByCooldown: 0,
    suppressedByCacheHot: 0,
    cacheHot: 0,
    overEffectiveWindow: 0,
    recent: events.slice(Math.max(0, events.length - recentLimit)),
  };

  for (const event of events) {
    summary.byType[event.type] = (summary.byType[event.type] ?? 0) + 1;
    if (event.recommended) summary.recommended++;
    if (event.suppressedByCooldown) summary.suppressedByCooldown++;
    if (event.suppressedByCacheHot) summary.suppressedByCacheHot++;
    if (event.cacheHot) summary.cacheHot++;
    if (event.occupancy !== undefined) {
      summary.maxOccupancy = Math.max(summary.maxOccupancy ?? 0, event.occupancy);
      if (event.occupancy >= 1) summary.overEffectiveWindow++;
    }
    if (event.contextTokens !== undefined) {
      summary.maxContextTokens = Math.max(summary.maxContextTokens ?? 0, event.contextTokens);
    }
    if (event.estReclaim !== undefined) {
      summary.maxEstReclaim = Math.max(summary.maxEstReclaim ?? 0, event.estReclaim);
    }
  }

  return summary;
}

export interface CompactionEventTail {
  read(): CompactionTelemetryEvent[];
}

export function createCompactionEventTail(
  options: { filePath?: string; startAtEnd?: boolean } = {},
): CompactionEventTail {
  const filePath = options.filePath ?? DEFAULT_AUTOCOMPACTOR_EVENTS_PATH;
  let offset = 0;
  let carry = "";
  try {
    offset = options.startAtEnd === false ? 0 : statSync(filePath).size;
  } catch {
    offset = 0;
  }

  return {
    read(): CompactionTelemetryEvent[] {
      if (!existsSync(filePath)) return [];
      let text = "";
      try {
        const stat = statSync(filePath);
        if (stat.size < offset) {
          offset = 0;
          carry = "";
        }
        if (stat.size === offset) return [];
        const buf = readByteRange(filePath, offset, stat.size);
        text = buf.toString("utf8");
        offset = stat.size;
      } catch {
        return [];
      }
      const combined = carry + text;
      const lastNewline = combined.lastIndexOf("\n");
      if (lastNewline < 0) {
        carry = combined;
        return [];
      }
      carry = combined.slice(lastNewline + 1);
      const completeText = combined.slice(0, lastNewline + 1);
      const events: CompactionTelemetryEvent[] = [];
      for (const line of completeText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const event = normalizeCompactionEvent(JSON.parse(trimmed), filePath);
          if (event) events.push(event);
        } catch {
          // Ignore partial trailing lines and corrupt diagnostics.
        }
      }
      return events;
    },
  };
}

function matchesCompactionFilter(event: CompactionTelemetryEvent, options: CompactionEventsReadOptions): boolean {
  if (options.sessionId && event.sessionId !== options.sessionId) return false;
  if (options.workflowRunId && event.workflowRunId !== options.workflowRunId) return false;
  const ts = event.timestamp ? Date.parse(event.timestamp) : undefined;
  if (options.since && ts !== undefined && ts < options.since.getTime()) return false;
  if (options.until && ts !== undefined && ts > options.until.getTime()) return false;
  return true;
}

function readByteRange(filePath: string, start: number, endExclusive: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const len = endExclusive - start;
    const buf = Buffer.alloc(len);
    const bytesRead = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function readTail(filePath: string, maxBytes: number): string {
  try {
    const stat = statSync(filePath);
    const size = stat.size;
    if (size <= maxBytes) {
      const buf = readByteRange(filePath, 0, size);
      return buf.toString("utf8");
    }
    const start = size - maxBytes;
    let buf: Buffer;
    let skippedBoundary = false;
    if (start > 0) {
      const boundaryStart = start - 1;
      const rawBuf = readByteRange(filePath, boundaryStart, size);
      const leadingByte = rawBuf[0];
      if (leadingByte === 10) {
        buf = rawBuf.subarray(1);
        skippedBoundary = true;
      } else {
        buf = readByteRange(filePath, start, size);
      }
    } else {
      buf = readByteRange(filePath, start, size);
    }
    let text = buf.toString("utf8");
    // Only strip to first newline when we had a mid-byte boundary (not clean newline skip).
    // When skippedBoundary is true, buf already starts with a complete line.
    const firstNewline = text.indexOf("\n");
    if (firstNewline > 0 && start > 0 && !skippedBoundary) {
      text = text.slice(firstNewline + 1);
    }
    return text;
  } catch {
    return "";
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function boolField(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return out.length ? out : undefined;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined));
}
