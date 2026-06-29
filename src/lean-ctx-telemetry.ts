import type { AgentHistoryEntry } from "./agent-history.js";

export interface LeanCtxTelemetryAgentSource {
  history?: AgentHistoryEntry[];
}

export interface LeanCtxTelemetrySummary {
  agents: number;
  toolCalls: number;
  ctxToolCalls: number;
  rawToolCalls: number;
  tools: Record<string, number>;
  rawTools: Record<string, number>;
  compressionEvents: number;
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  savedPct: number;
  bridgeMentions: number;
  cacheStubHits: number;
  warnings: string[];
}

const RAW_TOOL_NAMES = new Set(["bash", "read", "grep", "find", "ls"]);
const COMPRESSED_TOKENS_RE = /([\d,.]+\s*k?)\s*→\s*([\d,.]+\s*k?)\s*tok\b/gi;
const CACHE_STUB_HIT_RE =
  /second_read_is_stub\s*[=:]\s*true|\bstub(?:bed)?\s+(?:read|result|output)\b|\b(?:cache|cached)[_-]?(?:hit|stub|read)?\s*[=:]\s*true\b/i;

export function summarizeLeanCtxFromAgents(agents: LeanCtxTelemetryAgentSource[]): LeanCtxTelemetrySummary {
  const summary: LeanCtxTelemetrySummary = {
    agents: agents.length,
    toolCalls: 0,
    ctxToolCalls: 0,
    rawToolCalls: 0,
    tools: counterMap(),
    rawTools: counterMap(),
    compressionEvents: 0,
    originalTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
    savedPct: 0,
    bridgeMentions: 0,
    cacheStubHits: 0,
    warnings: [],
  };

  for (const agent of agents) {
    for (const entry of agent.history ?? []) {
      if (entry.kind === "toolCall" && entry.toolName) recordToolCall(summary, entry.toolName);
      if (entry.kind === "toolResult" || entry.kind === "error") recordToolResult(summary, entry.text, entry.toolName);
    }
  }

  summary.savedTokens = Math.max(0, summary.originalTokens - summary.compressedTokens);
  summary.savedPct = summary.originalTokens > 0 ? summary.savedTokens / summary.originalTokens : 0;
  summary.warnings = leanCtxWarnings(summary);
  return {
    ...summary,
    tools: sortedCounter(summary.tools),
    rawTools: sortedCounter(summary.rawTools),
  };
}

function recordToolCall(summary: LeanCtxTelemetrySummary, toolName: string): void {
  summary.toolCalls++;
  increment(summary.tools, toolName);
  if (isCtxTool(toolName)) summary.ctxToolCalls++;
  if (RAW_TOOL_NAMES.has(toolName)) {
    summary.rawToolCalls++;
    increment(summary.rawTools, toolName);
  }
}

function recordToolResult(summary: LeanCtxTelemetrySummary, text: string, toolName: string | undefined): void {
  const hasBridgeMarker = /\bsource\s*=\s*lean-ctx-bridge\b/i.test(text);
  const hasLeanCtxContext = hasBridgeMarker || isCtxTool(toolName ?? "");
  if (!hasLeanCtxContext) return;
  if (hasBridgeMarker) summary.bridgeMentions++;
  if (CACHE_STUB_HIT_RE.test(text)) summary.cacheStubHits++;

  COMPRESSED_TOKENS_RE.lastIndex = 0;
  for (const match of text.matchAll(COMPRESSED_TOKENS_RE)) {
    const original = parseTokenCount(match[1]);
    const compressed = parseTokenCount(match[2]);
    if (original === undefined || compressed === undefined || original <= compressed) continue;
    summary.compressionEvents++;
    summary.originalTokens += original;
    summary.compressedTokens += compressed;
  }
}

function isCtxTool(toolName: string): boolean {
  return toolName === "lean_ctx" || toolName.startsWith("ctx_");
}

function parseTokenCount(value: string): number | undefined {
  const normalized = value.trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, "");
  const multiplier = normalized.endsWith("k") ? 1000 : 1;
  const numeric = normalized.endsWith("k") ? normalized.slice(0, -1) : normalized;
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : undefined;
}

function leanCtxWarnings(summary: LeanCtxTelemetrySummary): string[] {
  const warnings: string[] = [];
  if (summary.toolCalls > 0 && summary.ctxToolCalls === 0 && summary.rawToolCalls > 0) {
    warnings.push("No ctx_* tool calls observed; workflow agents may be bypassing lean-ctx cache/compression.");
  }
  if (summary.rawToolCalls > summary.ctxToolCalls) {
    warnings.push("Raw bash/read/find/grep calls outnumber ctx_* calls; consider compression-aware ctx_* tools.");
  }
  if (summary.toolCalls > 0 && summary.compressionEvents === 0 && summary.bridgeMentions === 0) {
    warnings.push("No lean-ctx compression/cache evidence observed in persisted tool results.");
  }
  return warnings;
}

function counterMap(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function sortedCounter(counter: Record<string, number>): Record<string, number> {
  const sorted = counterMap();
  for (const [key, count] of Object.entries(counter).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    sorted[key] = count;
  }
  return sorted;
}
