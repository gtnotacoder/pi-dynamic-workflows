import assert from "node:assert/strict";
import test from "node:test";
import { createEffortState, effortDirective, isSubstantive, registerEffortCommand } from "../src/effort-command.js";
import { buildForcedWorkflowPrompt } from "../src/workflow-editor.js";

test("effortDirective returns a tier nudge for high/ultra, nothing for off", () => {
  assert.equal(effortDirective("off"), undefined);
  assert.match(effortDirective("high") ?? "", /HIGH/);
  assert.match(effortDirective("ultra") ?? "", /ULTRA/);
});

test("isSubstantive accepts real requests, rejects terse text and slash commands", () => {
  assert.equal(isSubstantive("audit the auth module for race conditions"), true);
  assert.equal(isSubstantive("ok"), false);
  assert.equal(isSubstantive("/workflows"), false);
  assert.equal(isSubstantive("    "), false);
});

test("buildForcedWorkflowPrompt appends the extra directive only when provided", () => {
  const base = buildForcedWorkflowPrompt("do X");
  assert.ok(!/ULTRA/.test(base), "no directive by default");
  assert.ok(base.startsWith("do X"));
  const ultra = buildForcedWorkflowPrompt("do X", effortDirective("ultra"));
  assert.match(ultra, /ULTRA/, "ultra directive appended");
  assert.ok(ultra.startsWith("do X"));
});

type CmdDef = { handler: (a: string, c: unknown) => Promise<void> };

function registerAndCapture(state: ReturnType<typeof createEffortState>) {
  const cmds = new Map<string, CmdDef>();
  const pi = {
    registerCommand: (name: string, d: unknown) => cmds.set(name, d as CmdDef),
    sendMessage: () => {},
  };
  registerEffortCommand(pi as never, state);
  return cmds;
}

test("registerEffortCommand: /effort toggles the shared state", async () => {
  const state = createEffortState();
  const effort = registerAndCapture(state).get("effort");
  assert.ok(effort, "/effort registered");
  assert.equal(state.level, "off");

  await effort?.handler("ultra", {});
  assert.equal(state.level, "ultra");
  await effort?.handler("high", {});
  assert.equal(state.level, "high");
  await effort?.handler("off", {});
  assert.equal(state.level, "off");
  await effort?.handler("bogus", {});
  assert.equal(state.level, "off", "unknown arg leaves the level unchanged");
});

test("registerEffortCommand: /maxeffort turns ultra on, /maxeffort off turns it off", async () => {
  const state = createEffortState();
  const maxeffort = registerAndCapture(state).get("maxeffort");
  assert.ok(maxeffort, "/maxeffort registered");

  await maxeffort?.handler("", {});
  assert.equal(state.level, "ultra", "/maxeffort (no arg) sets ultra");
  await maxeffort?.handler("off", {});
  assert.equal(state.level, "off", "/maxeffort off turns it off");
  await maxeffort?.handler("anything", {});
  assert.equal(state.level, "ultra", "/maxeffort <anything-but-off> sets ultra");
});
