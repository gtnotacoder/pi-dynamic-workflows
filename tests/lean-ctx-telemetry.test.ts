import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLeanCtxFromAgents } from "../src/lean-ctx-telemetry.js";

test("summarizeLeanCtxFromAgents counts ctx tools, raw tools, compression, and bridge hits", () => {
  const summary = summarizeLeanCtxFromAgents([
    {
      history: [
        { role: "assistant", kind: "toolCall", toolName: "ctx_read", text: '{"path":"a.ts"}' },
        {
          role: "tool",
          kind: "toolResult",
          toolName: "ctx_read",
          text: "source=lean-ctx-bridge\nCompressed 20.7k → 1,702 tok (↓92%)\nsecond_read_is_stub=true",
        },
        { role: "assistant", kind: "toolCall", toolName: "bash", text: "{}" },
        { role: "tool", kind: "toolResult", toolName: "bash", text: "ok" },
      ],
    },
  ]);

  assert.equal(summary.agents, 1);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.ctxToolCalls, 1);
  assert.equal(summary.rawToolCalls, 1);
  assert.equal(summary.tools.ctx_read, 1);
  assert.equal(summary.rawTools.bash, 1);
  assert.equal(summary.compressionEvents, 1);
  assert.equal(summary.originalTokens, 20_700);
  assert.equal(summary.compressedTokens, 1_702);
  assert.equal(summary.savedTokens, 18_998);
  assert.ok(summary.savedPct > 0.9);
  assert.equal(summary.bridgeMentions, 1);
  assert.equal(summary.cacheStubHits, 1);
});

test("summarizeLeanCtxFromAgents does not count ordinary bridge compression as a cache hit", () => {
  const summary = summarizeLeanCtxFromAgents([
    {
      history: [
        { role: "assistant", kind: "toolCall", toolName: "ctx_read", text: "{}" },
        {
          role: "tool",
          kind: "toolResult",
          toolName: "ctx_read",
          text: "source=lean-ctx-bridge\nCompressed 2,000 → 500 tok (↓75%)",
        },
      ],
    },
  ]);

  assert.equal(summary.bridgeMentions, 1);
  assert.equal(summary.compressionEvents, 1);
  assert.equal(summary.cacheStubHits, 0);
});

test("summarizeLeanCtxFromAgents ignores negative cache-hit phrases", () => {
  const summary = summarizeLeanCtxFromAgents([
    {
      history: [
        { role: "assistant", kind: "toolCall", toolName: "ctx_read", text: "{}" },
        { role: "tool", kind: "toolResult", toolName: "ctx_read", text: "cache hit: false\nno cache hit" },
      ],
    },
  ]);

  assert.equal(summary.cacheStubHits, 0);
});

test("summarizeLeanCtxFromAgents ignores raw lean-ctx documentation snippets", () => {
  const summary = summarizeLeanCtxFromAgents([
    {
      history: [
        { role: "assistant", kind: "toolCall", toolName: "bash", text: "{}" },
        {
          role: "tool",
          kind: "toolResult",
          toolName: "bash",
          text: "docs mention lean-ctx and stubbed output; Compressed 1,000 → 100 tok",
        },
      ],
    },
  ]);

  assert.equal(summary.bridgeMentions, 0);
  assert.equal(summary.cacheStubHits, 0);
  assert.equal(summary.compressionEvents, 0);
  assert.equal(summary.savedTokens, 0);
});

test("summarizeLeanCtxFromAgents ignores compression-looking text without lean-ctx evidence", () => {
  const summary = summarizeLeanCtxFromAgents([
    {
      history: [
        { role: "assistant", kind: "toolCall", toolName: "bash", text: "{}" },
        { role: "tool", kind: "toolResult", toolName: "bash", text: "docs say: Compressed 1,000 → 100 tok" },
      ],
    },
  ]);

  assert.equal(summary.compressionEvents, 0);
  assert.equal(summary.savedTokens, 0);
});

test("summarizeLeanCtxFromAgents warns when raw tools bypass ctx tools", () => {
  const summary = summarizeLeanCtxFromAgents([
    {
      history: [
        { role: "assistant", kind: "toolCall", toolName: "bash", text: "{}" },
        { role: "assistant", kind: "toolCall", toolName: "read", text: "{}" },
      ],
    },
  ]);

  assert.equal(summary.ctxToolCalls, 0);
  assert.equal(summary.rawToolCalls, 2);
  assert.ok(summary.warnings.some((warning) => warning.includes("No ctx_*")));
});
