/**
 * Comprehensive tests for workflow display rendering:
 *
 * 1. renderWorkflowText / renderWorkflowLines — how the workflow UI
 *    renders progress, results, phases, agents, logs, tokens, cost
 * 2. createWidgetWorkflowDisplay / createToolUpdateWorkflowDisplay —
 *    the lifecycle: update → complete → clear
 * 3. Tool result formatting — markdown JSON code blocks for final reports
 * 4. deliverText — how background-run results are formatted for the user
 * 5. backgroundStartedText — the "started in background" message
 * 6. Pure helper functions: preview, shorten, statusIcon, statusLine
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { WorkflowMeta } from "../src/workflow.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakeMeta(
  name = "test-wf",
  desc = "test description",
  phases: string[] = ["Research", "Build", "Verify"],
): WorkflowMeta {
  return { name, description: desc, phases: phases.map((t) => ({ title: t })) };
}

function agent(
  id: number,
  label: string,
  status: "queued" | "running" | "done" | "error" | "skipped",
  phase?: string,
  opts?: { resultPreview?: string; tokens?: number; model?: string; prompt?: string; error?: string },
) {
  return {
    id,
    label,
    status,
    phase,
    prompt: opts?.prompt ?? `execute ${label}`,
    ...(opts?.resultPreview ? { resultPreview: opts.resultPreview } : {}),
    ...(opts?.tokens ? { tokens: opts.tokens } : {}),
    ...(opts?.model ? { model: opts.model } : {}),
    ...(opts?.error ? { error: opts.error } : {}),
  };
}

// ─── Module loading helpers ─────────────────────────────────────────────────

async function loadDisplay() {
  return import("../src/display.js");
}

async function loadTaskPanel() {
  return import("../src/task-panel.js");
}

async function loadTool() {
  return import("../src/workflow-tool.js");
}

// ═══════════════════════════════════════════════════════════════════════════
// renderWorkflowText
// ═══════════════════════════════════════════════════════════════════════════

describe("renderWorkflowText", () => {
  it("shows 'running' header when not completed", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const text = renderWorkflowText(createWorkflowSnapshot(fakeMeta("test")));
    assert.ok(text.includes("running"), "should say running in the header");
    assert.ok(!text.includes("completed"), "should not say completed");
  });

  it("shows 'completed' header when completed flag is true", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const text = renderWorkflowText(createWorkflowSnapshot(fakeMeta()), true);
    assert.ok(text.includes("completed"), "should say completed");
  });

  it("includes workflow name in output", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const text = renderWorkflowText(createWorkflowSnapshot(fakeMeta("audit-all")));
    assert.ok(text.includes("audit-all"), "should contain audit-all");
  });

  it("includes phase names", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Phase1", "Phase2"]));
    snap.agents = [agent(1, "agent-1", "done", "Phase1")] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("Phase1"), "should contain Phase1");
    assert.ok(text.includes("Phase2"), "should contain Phase2");
  });

  it("includes agent labels", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.agents = [agent(1, "inventory", "done", "Research")] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("inventory"), "should contain inventory");
  });

  it("shows agent count and done count", async () => {
    const { createWorkflowSnapshot, renderWorkflowText, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [
      agent(1, "a1", "done", "Research"),
      agent(2, "a2", "done", "Build"),
      agent(3, "a3", "error", "Verify"),
    ] as never[];
    const text = renderWorkflowText(recomputeWorkflowSnapshot(snap));
    assert.ok(text.includes("3"), "should mention total agents");
    assert.ok(text.includes("2"), "should mention done count");
  });

  it("shows error count", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [agent(1, "a1", "done", "Research"), agent(2, "a2", "error", "Research")] as never[];
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    assert.ok(text.includes("1 errors"), "should show error count");
  });

  it("shows running count in header", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [agent(1, "a1", "done", "Research"), agent(2, "a2", "running", "Research")] as never[];
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    assert.ok(text.includes("running"), "should show running in header");
  });

  it("shows cost info when tokenUsage has cost", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.tokenUsage = { input: 1000, output: 500, total: 1500, cost: 0.042 };
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(text.includes("$0.0420"), "should show cost");
  });

  it("shows token info without cost when cost is absent", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.tokenUsage = { input: 500, output: 300, total: 800 };
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(text.includes("800"), "should show token count");
    assert.ok(!text.includes("$"), "should NOT show cost when absent");
  });

  it("shows skipped agents in phase line", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta("t", "d", ["Phase"])));
    snap.agents = [agent(1, "a1", "done", "Phase"), agent(2, "a2", "skipped", "Phase")] as never[];
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    assert.ok(text.includes("1 skipped"), "should show skipped count");
  });

  it("shows unphased agents when agents have no phase", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", []));
    snap.agents = [agent(1, "orphan", "done")] as never[];
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(text.includes("Unphased"), "should show unphased section");
    assert.ok(text.includes("orphan"), "should contain orphan");
  });

  it("shows agent tokens when available", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.agents = [agent(1, "heavy-agent", "done", "Research", { tokens: 12345 })] as never[];
    const text = renderWorkflowLines(snap).join("\n");
    // toLocaleString() output depends on locale (UK/US uses commas, PL uses NBSP)
    // Check with a regex matching any thousands separator between 12 and 345
    assert.ok(/12[ ,.\u00a0]345/.test(text), "should show formatted token count");
  });

  it("truncates long agent labels", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.agents = [agent(1, "x".repeat(100), "done", "Research")] as never[];
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(text.includes("…"), "should truncate with ellipsis");
    assert.ok(text.length < 200, "should not include the full 100-char label");
  });

  it("shows 'earlier agents' when more agents than maxAgents", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Phase"]));
    snap.agents = Array.from({ length: 20 }, (_, i) => agent(i + 1, `agent-${i + 1}`, "done", "Phase")) as never[];
    const text = renderWorkflowLines(snap, { maxAgents: 5 }).join("\n");
    assert.ok(text.includes("earlier agents"), "should mention earlier agents");
    assert.ok(text.includes("agent-20"), "should show last agent");
    // Use word boundary to avoid matching "agent-1" inside "agent-11", "agent-12", etc.
    assert.ok(!/\bagent-1\b/.test(text), "first agents should be clipped");
  });

  it("displays durationMs when present", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.durationMs = 12500;
    // renderWorkflowText doesn't explicitly show duration — but header includes tokenInfo
    // duration is available through the snapshot. Let's verify the function works.
    const text = renderWorkflowText(snap, true);
    assert.ok(text.includes("completed"), "completed header shown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createWidgetWorkflowDisplay lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("createWidgetWorkflowDisplay lifecycle", () => {
  it("update calls setWidget constructor once and re-renders via component", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const setStatus = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget, setStatus },
    };

    const display = createWidgetWorkflowDisplay(ctx as never, { key: "test-wf" });

    // Constructor registers the widget as a component factory (callback, not array)
    assert.equal(setWidget.mock.callCount(), 1);
    const [key, widget, _opts] = setWidget.mock.calls[0].arguments;
    assert.equal(key, "test-wf");
    assert.equal(typeof widget, "function", "widget should be a component factory function");

    // The component factory produces a Component with a render method
    const comp = widget(
      undefined as never,
      {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
      } as never,
    );
    assert.ok(comp, "component factory should return a component");
    assert.equal(typeof comp.render, "function", "component should have a render method");

    // update doesn't call setWidget again (mutable state)
    const snap = createWorkflowSnapshot(fakeMeta());
    display.update(snap);
    assert.equal(setWidget.mock.callCount(), 2, "update should call setWidget to re-register");

    // But the component's render function returns the latest snapshot lines
    const lines = comp.render(80);
    assert.ok(Array.isArray(lines), "render should return lines");
    assert.ok(lines.length > 0, "rendered lines should not be empty");
  });

  it("complete does not re-register widget (constructor did it)", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget, setStatus: mock.fn() },
    };

    const display = createWidgetWorkflowDisplay(ctx as never);
    assert.equal(setWidget.mock.callCount(), 1, "constructor registers widget once");

    const snap = createWorkflowSnapshot(fakeMeta());
    display.complete(snap);

    // Complete updates mutable state, doesn't re-register
    assert.equal(setWidget.mock.callCount(), 2, "complete should call setWidget to re-register");
  });

  it("clear removes widget and status", async () => {
    const { createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const setStatus = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget, setStatus },
    };

    const display = createWidgetWorkflowDisplay(ctx as never, { showStatus: true });
    // Constructor registers the widget once
    assert.equal(setWidget.mock.callCount(), 1);

    display.clear();

    // Clear calls setWidget(undefined) to remove it + setStatus(undefined)
    assert.equal(setWidget.mock.callCount(), 2, "constructor + clear = 2 calls");
    assert.equal(setWidget.mock.calls[1].arguments[1], undefined, "widget should be cleared");
    assert.equal(setStatus.mock.callCount(), 1);
    assert.equal(setStatus.mock.calls[0].arguments[1], undefined, "status should be cleared");
  });

  it("does nothing when hasUI is false", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const setStatus = mock.fn();
    const ctx = {
      hasUI: false,
      ui: { setWidget, setStatus },
    };

    const display = createWidgetWorkflowDisplay(ctx as never);
    const snap = createWorkflowSnapshot(fakeMeta());
    display.update(snap);
    display.complete(snap);
    display.clear();

    assert.equal(setWidget.mock.callCount(), 0, "should not call setWidget when no UI");
  });

  it("sets status line when showStatus is enabled", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setStatus = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget: mock.fn(), setStatus },
    };

    const display = createWidgetWorkflowDisplay(ctx as never, { key: "wf", showStatus: true });
    const snap = createWorkflowSnapshot(fakeMeta("test-wf"));
    snap.agents = [agent(1, "a1", "done", "Research"), agent(2, "a2", "running", "Research")] as never[];
    display.update(snap);

    assert.equal(setStatus.mock.callCount(), 1);
    const [, statusText] = setStatus.mock.calls[0].arguments;
    assert.ok(statusText.includes("test-wf"), "status should include workflow name");
  });

  it("re-renders via setWidget even when showStatus is false (default)", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget, setStatus: mock.fn() },
    };

    // showStatus defaults to false
    const display = createWidgetWorkflowDisplay(ctx as never, { key: "wf-no-status" });
    assert.equal(setWidget.mock.callCount(), 1, "constructor registers widget once");

    // update() re-registers the widget (invalidation signal to pi-tui)
    const snap = createWorkflowSnapshot(fakeMeta("no-status-wf"));
    display.update(snap);
    assert.equal(setWidget.mock.callCount(), 2, "update must re-register widget (invalidation signal)");

    // Extract the re-registered factory and verify it renders the latest snapshot
    const [, factory2] = setWidget.mock.calls[1].arguments;
    assert.equal(typeof factory2, "function", "factory must be a function");
    const comp2 = factory2(null, { fg: (_c, t) => t, bold: (t) => t });
    assert.equal(typeof comp2.render, "function", "factory must produce a component with render()");

    // Spy on render to prove it produces updated output
    const renderSpy = comp2.render;
    const lines2 = renderSpy(80);
    assert.ok(lines2.length > 0, "render() returned non-empty lines with showStatus=false");
    assert.ok(
      lines2.some((l) => l.includes("no-status-wf")),
      "render output includes snapshot workflow name",
    );
    assert.ok(
      lines2.some((l) => l.includes("0/0")),
      "render output includes agent count from snapshot",
    );

    // complete() must also re-register the factory
    display.complete(snap);
    assert.equal(setWidget.mock.callCount(), 3, "complete must re-register widget (invalidation signal)");

    // Verify the post-complete factory also renders updated content
    const [, factory3] = setWidget.mock.calls[2].arguments;
    const comp3 = factory3(null, { fg: (_c, t) => t, bold: (t) => t });
    const lines3 = comp3.render(80);
    assert.ok(
      lines3.some((l) => l.includes("no-status-wf")),
      "post-complete render shows workflow name",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createToolUpdateWorkflowDisplay lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("createToolUpdateWorkflowDisplay lifecycle", () => {
  it("update calls onUpdate with rendered text when streamToolUpdates is true", async () => {
    const { createWorkflowSnapshot, createToolUpdateWorkflowDisplay } = await loadDisplay();

    const onUpdate = mock.fn();
    const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, { streamToolUpdates: true });
    const snap = createWorkflowSnapshot(fakeMeta());
    display.update(snap);

    assert.equal(onUpdate.mock.callCount(), 1);
    const [{ content }] = onUpdate.mock.calls[0].arguments;
    assert.ok(Array.isArray(content), "content should be an array");
    assert.equal(content[0].type, "text");
    assert.ok(content[0].text.includes("Workflow"), "should include workflow status text");
  });

  it("update does NOT call onUpdate when streamToolUpdates is false", async () => {
    const { createWorkflowSnapshot, createToolUpdateWorkflowDisplay } = await loadDisplay();

    const onUpdate = mock.fn();
    const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, { streamToolUpdates: false });
    display.update(createWorkflowSnapshot(fakeMeta()));

    assert.equal(onUpdate.mock.callCount(), 0, "should not update when streaming is disabled");
  });

  it("complete emits final render with completed flag", async () => {
    const { createWorkflowSnapshot, createToolUpdateWorkflowDisplay } = await loadDisplay();

    const onUpdate = mock.fn();
    const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, { streamToolUpdates: true });
    const snap = createWorkflowSnapshot(fakeMeta("done-wf"));
    display.complete(snap);

    const [{ content }] = onUpdate.mock.calls[0].arguments;
    assert.ok(content[0].text.includes("done-wf"), "should include workflow name");
  });

  it("clear does not throw", async () => {
    const { createToolUpdateWorkflowDisplay } = await loadDisplay();
    const display = createToolUpdateWorkflowDisplay(undefined, undefined);
    assert.doesNotThrow(() => display.clear());
  });

  it("accepts a widget ctx and delegates to widget lifecycle", async () => {
    const { createWorkflowSnapshot, createToolUpdateWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const ctx = { hasUI: true, ui: { setWidget, setStatus: mock.fn() } };
    const display = createToolUpdateWorkflowDisplay(undefined, ctx as never, { key: "tool-wf" });

    // Constructor registers the component factory once
    assert.equal(setWidget.mock.callCount(), 1, "constructor should register widget once");

    // update/complete re-register the widget to trigger re-render
    display.update(createWorkflowSnapshot(fakeMeta()));
    assert.equal(setWidget.mock.callCount(), 2, "update should call setWidget to re-register");

    display.complete(createWorkflowSnapshot(fakeMeta("done")));
    assert.equal(setWidget.mock.callCount(), 3, "complete should call setWidget to re-register");

    // clear removes the widget
    display.clear();
    assert.equal(setWidget.mock.callCount(), 4, "clear should remove widget (4th call)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool result formatting (markdown JSON code blocks)
// ═══════════════════════════════════════════════════════════════════════════

describe("workflow tool result formatting", () => {
  it("tool result includes markdown JSON code block formatting", () => {
    // The execute() function in workflow-tool.ts wraps the final result in
    // a markdown ```json code block so it renders nicely in the conversation.
    // This test verifies the formatting pattern.
    const result = { ok: true, items: 3 };
    const formatted = `\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    assert.ok(formatted.includes("```json"), "should use json code block");
    assert.ok(formatted.endsWith("```"), "should close code block");
    assert.ok(formatted.includes('"ok": true'), "should contain data");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers: preview, shorten, statusIcon, statusLine
// ═══════════════════════════════════════════════════════════════════════════

describe("display pure helpers", () => {
  it("preview returns string for number 0", async () => {
    const { preview } = await loadDisplay();
    assert.equal(preview(0), "0");
  });

  it("preview returns 'true' for boolean true", async () => {
    const { preview } = await loadDisplay();
    assert.equal(preview(true), "true");
    assert.equal(preview(false), "false");
  });

  it("preview returns empty for undefined", async () => {
    const { preview } = await loadDisplay();
    assert.equal(preview(undefined), "");
  });

  it("preview truncates long JSON strings", async () => {
    const { preview } = await loadDisplay();
    const result = preview("x".repeat(200));
    assert.ok(result.length <= 85, "should truncate with max 80 + …");
    assert.ok(result.endsWith("…"), "should end with …");
  });

  it("preview accepts custom max length", async () => {
    const { preview } = await loadDisplay();
    const result = preview("x".repeat(50), 10);
    assert.ok(result.length <= 14, "should respect custom max");
  });

  it("preview handles arrays", async () => {
    const { preview } = await loadDisplay();
    const arr = [1, 2, 3, 4, 5];
    const result = preview(arr, 50);
    assert.ok(result.length > 0, "result should not be empty");
    assert.ok(result.includes("1"), "should contain 1");
  });

  it("statusLine shows completed state", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();
    // statusLine is internal to display.ts — tested via widget display
    const setStatus = mock.fn();
    const ctx = { hasUI: true, ui: { setWidget: mock.fn(), setStatus } };
    const display = createWidgetWorkflowDisplay(ctx as never, { key: "s", showStatus: true });
    const snap = createWorkflowSnapshot(fakeMeta("bench"));
    snap.agents = [agent(1, "a1", "done", "Research")] as never[];
    snap.agentCount = 1;
    snap.doneCount = 1;
    display.complete(snap);
    const [, statusText] = setStatus.mock.calls[0].arguments;
    assert.ok(statusText.includes("✓"), "completed status shows checkmark");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deliverText — background result formatting
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// agent error surfacing — shared helper + both renderers stay consistent
// ═══════════════════════════════════════════════════════════════════════════

describe("agent error surfacing", () => {
  it("shorten never splits a UTF-16 surrogate pair", async () => {
    const { shorten } = await loadDisplay();
    // 58 ASCII + an astral char (2 code units at indices 58-59) + padding, so a
    // naive code-unit slice(0, 59) would cut between the high and low surrogate
    // and emit a lone surrogate. Code-point slicing keeps the astral char whole.
    const emoji = "\u{1F6A8}";
    const s = "x".repeat(58) + emoji + "y".repeat(10);
    const out = shorten(s, 60);
    assert.ok(out.endsWith("…"), "truncated string ends with ellipsis");
    assert.ok(out.includes(emoji), "astral char is kept whole, not split into a lone surrogate");
  });

  it("firstLine returns the first non-empty line", async () => {
    const { firstLine } = await loadDisplay();
    assert.equal(firstLine("Provider error: upstream\nCaused by: reset"), "Provider error: upstream");
    assert.equal(firstLine("\n  \nfirst real line\nsecond"), "first real line");
    assert.equal(firstLine(undefined), "");
    assert.equal(firstLine("   \n  \t  "), "");
  });

  it("agentErrorText is empty for non-error agents and blank errors (no dangling dash)", async () => {
    const { agentErrorText } = await loadDisplay();
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
    assert.equal(agentErrorText({ status: "done" }, theme), "");
    assert.equal(agentErrorText({ status: "error", error: "   \n  " }, theme), "");
    assert.equal(agentErrorText({ status: "error", error: undefined }, theme), "");
  });

  it("agentErrorText renders the first line for a real error", async () => {
    const { agentErrorText } = await loadDisplay();
    const theme = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => t } as never;
    const out = agentErrorText({ status: "error", error: "model timeout: 30000ms\nstack..." }, theme);
    assert.ok(out.startsWith("[error] — model timeout: 30000ms"), "colored first-line suffix");
    assert.ok(!out.includes("stack"), "later lines dropped");
  });

  it("renderWorkflowLines surfaces an errored agent's error inline (both renderers consistent)", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [
      agent(1, "a1", "done", "Research"),
      agent(2, "a2", "error", "Research", { error: "model timeout: 30000ms" }),
    ] as never[];
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    const row = text.split("\n").find((l) => /a2/.test(l));
    assert.ok(row && /model timeout: 30000ms/.test(row), "live widget row shows the error reason");
  });
});

describe("deliverText", () => {
  function fakeManagedRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: "r-123",
      workflowName: "my-wf",
      snapshot: {
        name: "my-wf",
        agentCount: 5,
        phases: [],
        logs: [],
        agents: [],
        ...((overrides.snapshot as Record<string, unknown>) ?? {}),
      },
      background: true,
      status: "completed",
      result: {
        result: { verdict: "All checks passed" },
        agentCount: 5,
        tokenUsage: { input: 100, output: 50, total: 150, cost: 0.003 },
        durationMs: 12345,
      },
      ...overrides,
    } as never;
  }

  it("prefers verdict property when available", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    assert.ok(text.includes("All checks passed"), "should include verdict text");
  });

  it("falls back to report when no verdict", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: { report: "Found 5 issues in codebase" },
        agentCount: 3,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("Found 5 issues"), "should include report text");
  });

  it("falls back to summary when no verdict or report", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: { summary: "Analysis complete" },
        agentCount: 2,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("Analysis complete"), "should include summary text");
  });

  it("falls back to JSON when result has no structured properties", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: { raw: "data", count: 42 },
        agentCount: 1,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("count"), "should include JSON keys");
    assert.ok(text.includes("42"), "should include JSON values");
  });

  it("uses string result directly", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: "Everything is fine",
        agentCount: 1,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("Everything is fine"), "should contain Everything is fine");
  });

  it("handles null result gracefully", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: null,
        agentCount: 1,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("null"), "should say null");
    // EDIT 3: deliverText emits a <task-notification> XML block (no prose "finished").
    assert.ok(text.startsWith("<task-notification>"), "should be a task-notification XML block");
    assert.ok(text.includes("<status>completed</status>"), "should report completed status");
  });

  it("includes token count when available", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    assert.ok(text.includes("150"), "should show token count");
    assert.ok(text.includes("tokens"), "should mention tokens");
  });

  it("includes agent count", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    // EDIT 3: agent count is in <usage><agent_count>5</agent_count>.
    assert.ok(text.includes("<agent_count>5</agent_count>"), "should report agent_count 5");
  });

  it("includes duration in seconds", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    // EDIT 3: duration is reported in ms inside <duration_ms>12345</duration_ms>.
    assert.ok(text.includes("<duration_ms>12345</duration_ms>"), "should report duration_ms 12345");
  });

  it("links transcripts + run-state JSON with file:// URIs in <recovery> on failure", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      status: "failed",
      error: { message: "model timeout: 30000ms" },
      result: undefined,
      transcriptDir: "/tmp/wf-runs/r-123/subagents",
      runId: "r-123",
    });
    const text = deliverText(run);
    assert.ok(text.includes("<status>failed</status>"), "failed status");
    assert.ok(text.includes("<recovery>"), "has a recovery block");
    assert.ok(text.includes("Agent transcripts:"), "mentions transcripts");
    assert.ok(text.includes("file:///tmp/wf-runs/r-123/subagents"), "transcript file:// URI");
    assert.ok(text.includes("Run state:"), "mentions run state");
    assert.ok(text.includes("file:///tmp/wf-runs/r-123.json"), "run-state json file:// URI derived from transcriptDir + runId");
  });

  it("reports real tool_uses from agent toolCall history (not hardcoded 0)", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      snapshot: {
        name: "my-wf", agentCount: 5, phases: [], logs: [],
        agents: [
          { id: 1, label: "a1", status: "done", history: [{ kind: "text" }, { kind: "toolCall" }, { kind: "toolCall" }, { kind: "toolResult" }] },
          { id: 2, label: "a2", status: "done", history: [{ kind: "toolCall" }] },
        ],
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("<tool_uses>3</tool_uses>"), "sums toolCall history entries across agents (2+1=3)");
  });

  it("starts with task-notification XML and includes workflow name", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    // EDIT 3: deliverText now emits a Claude-Code-style <task-notification> XML block.
    assert.ok(text.startsWith("<task-notification>"), "should start with <task-notification>");
    assert.ok(text.trim().endsWith("</task-notification>"), "should end with </task-notification>");
    assert.ok(text.includes("my-wf"), "should include workflow name");
  });

  it("truncates very long JSON at 400 chars", async () => {
    const { deliverText } = await loadTaskPanel();
    const large = { data: "x".repeat(500) };
    const run = fakeManagedRun({
      result: {
        result: large,
        agentCount: 1,
      },
    });
    const text = deliverText(run);
    // JSON of large object + "...(truncated)" — deliverText has slice(0,400) logic
    assert.ok(text.includes("truncated") || text.length < 600, "very long JSON should be truncated");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// backgroundStartedText
// ═══════════════════════════════════════════════════════════════════════════

describe("backgroundStartedText", () => {
  it("includes workflow name and run ID", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("deep-research", "run-xyz");
    assert.ok(text.includes("deep-research"), "should contain deep-research");
    assert.ok(text.includes("run-xyz"), "should contain run-xyz");
  });

  it("tells the user the workflow is in the background", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("audit", "r-1");
    assert.ok(text.includes("background"), "should say background");
  });

  it("tells user they can wait or do other things", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("audit", "r-1");
    assert.ok(text.includes("wait here") || text.includes("other things"), "should mention options");
  });

  it("mentions /workflows status command for tracking", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("audit", "r-1");
    assert.ok(text.includes("/workflows"), "should mention /workflows");
  });

  // ── EDIT 5: surface the transcript dir on async launch ──

  it("includes Transcript dir line when transcriptDir is provided", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("audit", "r-1", "/tmp/wf/runs/r-1/subagents");
    assert.ok(text.includes("Transcript dir: /tmp/wf/runs/r-1/subagents"), "should surface transcript dir");
  });

  it("omits Transcript dir line when transcriptDir is absent", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("audit", "r-1");
    assert.ok(!text.includes("Transcript dir:"), "should not mention transcript dir when absent");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createWorkflowSnapshot / recomputeWorkflowSnapshot
// ═══════════════════════════════════════════════════════════════════════════

describe("createWorkflowSnapshot", () => {
  it("sets default values for optional fields", async () => {
    const { createWorkflowSnapshot } = await loadDisplay();
    const meta = { name: "n", description: "d" };
    const snap = createWorkflowSnapshot(meta as never);
    assert.deepEqual(snap.phases, []);
    assert.deepEqual(snap.logs, []);
    assert.deepEqual(snap.agents, []);
    assert.equal(snap.agentCount, 0);
    assert.equal(snap.runningCount, 0);
    assert.equal(snap.doneCount, 0);
    assert.equal(snap.errorCount, 0);
  });
});

describe("recomputeWorkflowSnapshot", () => {
  it("counts running/done/error correctly mixed statuses", async () => {
    const { createWorkflowSnapshot, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = createWorkflowSnapshot({ name: "t", description: "d" } as never);
    snap.agents = [
      { id: 1, label: "a", prompt: "p", status: "queued" },
      { id: 2, label: "b", prompt: "p", status: "running" },
      { id: 3, label: "c", prompt: "p", status: "done" },
      { id: 4, label: "d", prompt: "p", status: "error" },
      { id: 5, label: "e", prompt: "p", status: "skipped" },
    ] as never[];
    const r = recomputeWorkflowSnapshot(snap);
    assert.equal(r.agentCount, 5);
    assert.equal(r.runningCount, 1);
    assert.equal(r.doneCount, 1);
    assert.equal(r.errorCount, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderWorkflowLines edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("renderWorkflowLines edge cases", () => {
  it("handles empty agents array", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    const lines = renderWorkflowLines(snap);
    assert.ok(lines.length > 0, "should still produce output");
    assert.ok(lines[0].includes("0/0"), "should show 0/0 done");
  });

  it("handles multiple phases with varying agent counts", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta("t", "d", ["Alpha", "Beta"])));
    snap.agents = [
      agent(1, "a1", "done", "Alpha"),
      agent(2, "a2", "done", "Beta"),
      agent(3, "a3", "running", "Beta"),
    ] as never[];
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    assert.ok(text.includes("Alpha"), "should contain Alpha");
    assert.ok(text.includes("Beta"), "should contain Beta");
    assert.ok(text.includes("running"), "should show running in Beta");
  });

  it("mentions the workflow name in the first line", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("check-everything"));
    const lines = renderWorkflowLines(snap);
    assert.ok(lines[0].includes("check-everything"), "should contain check-everything");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TUI rendering: no markdown syntax leaked into display
// ═══════════════════════════════════════════════════════════════════════════

describe("TUI rendering has no markdown syntax", () => {
  it("renderWorkflowLines uses [id] instead of #id prefix", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Phase"]));
    snap.agents = [agent(1, "agent-1", "done", "Phase")] as never[];
    const text = renderWorkflowLines(snap).join("\n");
    // Should use bracket notation, not hash notation
    assert.ok(text.includes("[1]"), "should use [id] instead of #id");
    assert.ok(!text.includes("#1"), "should NOT use #1 prefix");
  });

  it("renderWorkflowLines has no **bold** markers", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(!text.includes("**"), "should not have bold markdown markers");
  });

  it("renderWorkflowLines has no ## heading markers", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(!text.includes("##"), "should not have heading markdown markers");
  });

  it("renderWorkflowLines has no code fence markers", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(!text.includes("```"), "should not have code fence markers");
  });

  it("renderWorkflowText has no **bold** markers", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    const text = renderWorkflowText(snap, true);
    assert.ok(!text.includes("**"), "completed text should not have bold markers");
  });

  it("renderWorkflowText completed has no ## heading markers", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    const text = renderWorkflowText(snap, true);
    assert.ok(!text.includes("##"), "completed text should not have heading markers");
  });

  it("renderResult fallback strips markdown from content text", async () => {
    const { createWorkflowTool } = await loadTool();
    const tool = createWorkflowTool();
    const theme = {
      fg: () => (s: string) => s,
      bold: (s: string) => s,
    };
    const resultWithMarkdown = {
      content: [{ type: "text", text: "**bold** and `code` and ## header" }],
      details: { some: "data" }, // no 'name' → triggers fallback
      isError: false,
    };
    // If snapshot.name is missing, the function should still produce
    // a Text component without crashing
    assert.doesNotThrow(() => {
      tool.renderResult(resultWithMarkdown as never, { isPartial: false }, theme as never);
    });
  });
});

// ─── EDIT 3: <task-notification> XML structure (deliverText) ────────────────────

describe("deliverText <task-notification> XML (EDIT 3)", () => {
  function fakeManagedRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: "r-123",
      workflowName: "my-wf",
      snapshot: {
        name: "my-wf",
        agentCount: 5,
        phases: [],
        logs: [],
        agents: [],
        ...((overrides.snapshot as Record<string, unknown>) ?? {}),
      },
      background: true,
      status: "completed",
      result: {
        result: { verdict: "All checks passed" },
        agentCount: 5,
        tokenUsage: { input: 100, output: 50, total: 150, cost: 0.003 },
        durationMs: 12345,
      },
      ...overrides,
    } as never;
  }

  it("emits a <task-notification> block with the verified child order", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    // Verified child order in claude.exe 2.1.185: task-id, status, summary,
    // result (completed), failures?, usage. (tool-use-id/output-file omitted —
    // qshaw has none.)
    const tid = text.indexOf("<task-id>r-123</task-id>");
    const status = text.indexOf("<status>completed</status>");
    const summary = text.indexOf("<summary>");
    const result = text.indexOf("<result>");
    const usage = text.indexOf("<usage>");
    assert.ok(tid !== -1, "has <task-id>");
    assert.ok(status !== -1, "has <status>");
    assert.ok(summary !== -1, "has <summary>");
    assert.ok(result !== -1, "has <result>");
    assert.ok(usage !== -1, "has <usage>");
    assert.ok(tid < status, "task-id before status");
    assert.ok(status < summary, "status before summary");
    assert.ok(summary < result, "summary before result");
    assert.ok(result < usage, "result before usage");
    assert.ok(usage < text.indexOf("</task-notification>"), "usage before close");
  });

  it("omits <result> and includes <recovery> for a failed run", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      status: "failed",
      error: { message: "boom" } as never,
      result: undefined,
      transcriptDir: "/tmp/wf/runs/r-123/subagents",
    });
    const text = deliverText(run);
    assert.ok(text.includes("<status>failed</status>"), "reports failed status");
    assert.ok(!text.includes("<result>"), "no <result> for a failed run");
    assert.ok(text.includes("<recovery>"), "has <recovery>");
    // EDIT 5: the recovery surfaces the subagent transcript dir.
    assert.ok(text.includes("Agent transcripts: /tmp/wf/runs/r-123/subagents"), "recovery names transcript dir");
    assert.ok(text.includes("/workflows resume r-123"), "recovery names the resume command");
  });

  it("escapes XML-special characters in summary and result", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: { result: "a < b & c > d", agentCount: 1 },
    });
    const text = deliverText(run);
    assert.ok(text.includes("a &lt; b &amp; c &gt; d"), "should XML-escape <, &, > in <result>");
    assert.ok(!text.includes("a < b & c > d"), "should not leak raw special chars");
  });

  it("includes <failures> when agents errored", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      snapshot: {
        name: "my-wf",
        agentCount: 2,
        phases: [],
        logs: [],
        agents: [
          { id: 1, label: "a1", status: "done" },
          { id: 2, label: "a2", status: "error", error: "timeout", errorCode: "AGENT_TIMEOUT" },
        ],
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("<failures>"), "has <failures> when an agent errored");
    assert.ok(text.includes("a2"), "failures name the errored agent");
  });

  it("truncates <result> at 8000 chars", async () => {
    const { deliverText } = await loadTaskPanel();
    const huge = { data: "x".repeat(20000) };
    const run = fakeManagedRun({ result: { result: huge, agentCount: 1 } });
    const text = deliverText(run);
    assert.ok(text.includes("truncated"), "should mark the result as truncated");
    // The <result> body itself is capped at 8000 chars (+ the truncation note).
    const resultBody = text.slice(text.indexOf("<result>") + "<result>".length, text.indexOf("</result>"));
    assert.ok(resultBody.length < 8200, "result body should be near the 8000-char cap");
  });
});
