import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHarnessConfigRegistry } from "../src/harness-config.js";
import { runWorkflow } from "../src/workflow.js";

interface CapturedCall {
  label: string | undefined;
  toolNames: readonly string[] | undefined;
  ctxReadGuardrail: unknown;
  readOnly: boolean | undefined;
  inheritProjectContext: boolean | undefined;
}

function capturingRunner(calls: CapturedCall[]) {
  return {
    async run(prompt: string, options: Record<string, unknown>) {
      calls.push({
        label: options.label as string | undefined,
        toolNames: options.toolNames as readonly string[] | undefined,
        ctxReadGuardrail: options.ctxReadGuardrail,
        readOnly: options.readOnly as boolean | undefined,
        inheritProjectContext: options.inheritProjectContext as boolean | undefined,
      });
      return `ran:${prompt}`;
    },
  };
}

function writeHarnesses(dir: string) {
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  // Frontend config: default componentExtensions (→ ctxReadGuardrail set); edit tool present.
  writeFileSync(
    join(harnessDir, "frontend-react-shadcn.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "frontend-react-shadcn",
      harness_type: "pi",
      tools: ["edit", "read", "grep"],
    }),
  );
  // Backend config: no componentExtensions (→ ctxReadGuardrail undefined); bash tool present.
  writeFileSync(
    join(harnessDir, "backend-api.json"),
    JSON.stringify({ schemaVersion: 1, id: "backend-api", harness_type: "pi", tools: ["bash", "read"] }),
  );
  // An opencode-runtime config (unwired) to test per-call type/config mismatch handling.
  writeFileSync(
    join(harnessDir, "opencode-svc.json"),
    JSON.stringify({ schemaVersion: 1, id: "opencode-svc", harness_type: "opencode", tools: ["read"] }),
  );
  return harnessDir;
}

function freshRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "per-call-harness-"));
  const harnessDir = writeHarnesses(dir);
  const userDir = mkdtempSync(join(tmpdir(), "per-call-harness-user-"));
  return { registry: loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir }), cwd: dir };
}

async function runCapture(
  script: string,
  opts: Record<string, unknown> & { harness_config?: string; agentRegistry?: Map<string, unknown> },
): Promise<Map<string, CapturedCall>> {
  const calls: CapturedCall[] = [];
  const { registry, cwd } = freshRegistry();
  await runWorkflow(script, {
    agent: capturingRunner(calls),
    harnessConfigRegistry: registry,
    cwd,
    concurrency: 1,
    persistLogs: false,
    ...opts,
  } as Record<string, unknown>);
  return new Map(calls.map((c) => [c.label, c]));
}

test("mixed plan routes each worker to its own config (run-level neutral)", async () => {
  const byLabel = await runCapture(
    `export const meta = { name: 'mixed', description: 'mixed plan' }
const a = await agent('frontend-step', { label: 'fe', harness_config: 'frontend-react-shadcn' })
const b = await agent('backend-step', { label: 'be' })
const c = await agent('backend-explicit', { label: 'be2', harness_config: 'backend-api' })
return { a, b, c }`,
    { harness_config: "none" },
  );
  const fe = byLabel.get("fe");
  const be = byLabel.get("be");
  const be2 = byLabel.get("be2");
  assert.ok(fe && be && be2, "all three calls captured");

  // Per-call frontend override: frontend tools + ctx-read guardrail.
  assert.ok(fe.ctxReadGuardrail, "frontend per-call step has a ctx-read guardrail");
  assert.ok(fe.toolNames?.includes("edit"), "frontend per-call step got the frontend write tool");
  assert.ok(fe.toolNames?.includes("read"), "frontend per-call step keeps read tools");
  assert.ok(!fe.toolNames?.includes("bash"), "frontend step did NOT get the backend tool");

  // Inherit (run-level none): no guardrail, no tool restriction.
  assert.equal(be.ctxReadGuardrail, undefined, "inherit step has no guardrail");
  assert.equal(be.toolNames, undefined, "inherit step has no tool restriction (run-level none)");

  // Explicit backend: backend tools, no guardrail.
  assert.equal(be2.ctxReadGuardrail, undefined, "explicit-backend step has no guardrail");
  assert.ok(be2.toolNames?.includes("bash"), "explicit-backend step got the backend tool");
  assert.ok(!be2.toolNames?.includes("edit"), "backend step did NOT get the frontend write tool");
});

test("read-only fence holds per-call: a per-step config cannot widen authority", async () => {
  const byLabel = await runCapture(
    `export const meta = { name: 'ro', description: 'read-only fence' }
const a = await agent('frontend-step', { label: 'fe', harness_config: 'frontend-react-shadcn' })
const c = await agent('backend-explicit', { label: 'be2', harness_config: 'backend-api' })
return { a, c }`,
    { harness_config: "none", readOnly: true },
  );
  const fe = byLabel.get("fe");
  const be2 = byLabel.get("be2");
  assert.ok(fe && be2, "calls captured");
  assert.equal(fe.readOnly, true, "readOnly forwarded to the runner");
  // Under readOnly, write tools (edit/bash) are fenced out of BOTH per-call configs.
  assert.ok(!fe.toolNames?.includes("edit"), "frontend per-call write tool is fenced out under readOnly");
  assert.ok(fe.toolNames?.includes("read"), "frontend per-call keeps read tools under readOnly");
  assert.ok(!be2.toolNames?.includes("bash"), "backend per-call write tool is fenced out under readOnly");
  assert.ok(be2.toolNames?.includes("read"), "backend per-call keeps read tools under readOnly");
  // The guardrail still applies per-call under readOnly (the fence narrows tools, not read hints).
  assert.ok(fe.ctxReadGuardrail, "frontend per-call guardrail still applies under readOnly");
});

test("unknown per-call harness_config id is rejected (keeps the run-level fence, does not widen)", async () => {
  // agentType carries a broad tool set; a rejected per-call config must NOT widen beyond
  // the run-level fence. With always-intersect tool policy, the rejected typo is ignored
  // and the runner intersects the agentType tools with the run-level harness (keeps the fence).
  const agentRegistry = new Map([
    [
      "specialized-worker",
      { name: "specialized-worker", tools: ["read", "edit", "write", "bash"], prompt: "", source: "project" as const },
    ],
  ]);
  const byLabel = await runCapture(
    `export const meta = { name: 'typo', description: 'unknown config' }
const a = await agent('step', { label: 'typo', agentType: 'specialized-worker', harness_config: 'frontend-react-shacdn' })
return { a }`,
    { harness_config: "backend-api", agentRegistry: agentRegistry as unknown as Map<string, unknown> },
  );
  const typo = byLabel.get("typo");
  assert.ok(typo, "call captured");
  // Run-level is backend-api (bash,read). The typo config is rejected → the runner intersects
  // specialized-worker [read,edit,write,bash] with run-level [bash,read] = [bash,read].
  // The run-level fence holds: edit/write (broad agentType tools) are NOT granted.
  assert.ok(typo.toolNames?.includes("bash"), "rejected override keeps the run-level backend tool");
  assert.ok(typo.toolNames?.includes("read"), "rejected override keeps the run-level read tool");
  assert.ok(!typo.toolNames?.includes("edit"), "rejected override does NOT widen beyond the run-level fence");
  assert.equal(typo.ctxReadGuardrail, undefined, "unknown per-call config keeps run-level (no guardrail)");
});

test("explicit harness_config 'none' is a real override that clears the guardrail", async () => {
  const byLabel = await runCapture(
    `export const meta = { name: 'none', description: 'explicit none' }
const a = await agent('none-step', { label: 'none', harness_config: 'none' })
const b = await agent('inherit-step', { label: 'inherit' })
return { a, b }`,
    { harness_config: "frontend-react-shadcn" },
  );
  const noneStep = byLabel.get("none");
  const inherit = byLabel.get("inherit");
  assert.ok(noneStep && inherit, "calls captured");
  // Run-level is frontend (guardrail set, tools [edit,read,grep]). Explicit "none" keeps the
  // run-level tool fence (cannot widen) but clears the read-path guardrail (Pi defaults);
  // inherit keeps both.
  assert.equal(noneStep.ctxReadGuardrail, undefined, "explicit 'none' clears the read-path guardrail");
  assert.ok(noneStep.toolNames?.includes("edit"), "explicit 'none' preserves the run-level tool fence (no widening)");
  assert.ok(inherit.ctxReadGuardrail, "inherit keeps the run-level guardrail");
  assert.ok(inherit.toolNames?.includes("edit"), "inherit keeps the run-level frontend tools");
});

test("harness_type-only inherits the run-level config (does not drop it to none)", async () => {
  const byLabel = await runCapture(
    `export const meta = { name: 'type-only', description: 'type only' }
const a = await agent('type-only', { label: 'to', harness_type: 'pi' })
return { a }`,
    { harness_config: "frontend-react-shadcn" },
  );
  const to = byLabel.get("to");
  assert.ok(to, "call captured");
  // Run-level is frontend (guardrail + edit). Setting only harness_type keeps the config.
  assert.ok(to.ctxReadGuardrail, "harness_type-only inherits the run-level guardrail");
  assert.ok(to.toolNames?.includes("edit"), "harness_type-only inherits the run-level frontend tools");
});

test("per-step tools are narrowed by the run-level allowlist (cannot widen)", async () => {
  const byLabel = await runCapture(
    `export const meta = { name: 'narrow', description: 'narrow' }
const a = await agent('fe', { label: 'fe', harness_config: 'frontend-react-shadcn' })
return { a }`,
    { harness_config: "backend-api" },
  );
  const fe = byLabel.get("fe");
  assert.ok(fe, "call captured");
  // Run-level backend allows [bash,read]; per-call frontend allows [edit,read,grep].
  // Intersection = [read] — the per-step cannot re-grant edit/bash the run-level revoked.
  assert.deepEqual([...(fe.toolNames ?? [])], ["read"], "per-step tools are intersected with the run-level allowlist");
});

test("an agentType tool allowlist is narrowed by the per-step harness_config (not masked)", async () => {
  // Mirror the real issue-delivery worker: specialized-worker carries a broad tool set.
  // A per-step harness_config must narrow it, not be ignored.
  const agentRegistry = new Map([
    [
      "specialized-worker",
      {
        name: "specialized-worker",
        tools: ["read", "edit", "write", "bash"],
        prompt: "",
        source: "project" as const,
      },
    ],
  ]);
  const byLabel = await runCapture(
    `export const meta = { name: 'agenttype', description: 'agentType narrow' }
const a = await agent('fe', { label: 'fe', agentType: 'specialized-worker', harness_config: 'frontend-react-shadcn' })
const b = await agent('be', { label: 'be', agentType: 'specialized-worker', harness_config: 'backend-api' })
return { a, b }`,
    { harness_config: "none", agentRegistry: agentRegistry as unknown as Map<string, unknown> },
  );
  const fe = byLabel.get("fe");
  const be = byLabel.get("be");
  assert.ok(fe && be, "calls captured");
  // specialized-worker allows [read,edit,write,bash]; per-step frontend allows [edit,read,grep].
  // Intersection = [edit,read] (grep is not in the agentType set, so it is narrowed out too).
  assert.deepEqual(
    [...(fe.toolNames ?? [])].sort(),
    ["edit", "read"],
    "frontend per-step config narrows the agentType tool allowlist",
  );
  // Backend: intersect([bash,read],[read,edit,write,bash]) = [bash,read].
  assert.deepEqual(
    [...(be.toolNames ?? [])].sort(),
    ["bash", "read"],
    "backend per-step config narrows the agentType tool allowlist",
  );
});

test("a disjoint per-step/run-level allowlist yields deny-all (never all tools)", async () => {
  // Custom configs: run-level restricts to [read]; per-step wants [bash] (disjoint).
  const dir = mkdtempSync(join(tmpdir(), "per-call-disjoint-"));
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "restrictive-ro.json"),
    JSON.stringify({ schemaVersion: 1, id: "restrictive-ro", harness_type: "pi", tools: ["read"] }),
  );
  writeFileSync(
    join(harnessDir, "bash-only.json"),
    JSON.stringify({ schemaVersion: 1, id: "bash-only", harness_type: "pi", tools: ["bash"] }),
  );
  const userDir = mkdtempSync(join(tmpdir(), "per-call-disjoint-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  const calls: CapturedCall[] = [];
  await runWorkflow(
    `export const meta = { name: 'disjoint', description: 'disjoint' }
const a = await agent('step', { label: 'step', harness_config: 'bash-only' })
return { a }`,
    {
      agent: capturingRunner(calls),
      harness_config: "restrictive-ro",
      harnessConfigRegistry: registry,
      cwd: dir,
      concurrency: 1,
      persistLogs: false,
    },
  );
  const step = calls[0];
  assert.ok(step, "call captured");
  // Disjoint intersection ⇒ deny-all (applyToolPolicy honors [] as no-tools), never "all tools".
  assert.equal(step.toolNames?.length, 0, "disjoint per-step/run-level allowlist ⇒ deny-all, not all tools");
  assert.ok(!step.toolNames?.includes("bash"), "the per-step bash tool is NOT granted beyond the run-level fence");
  assert.ok(!step.toolNames?.includes("read"), "the run-level read tool is NOT granted beyond the per-step fence");
});

test("a disjoint agentType/harness intersection yields deny-all (never all tools)", async () => {
  // agentType allows only [bash]; the per-step frontend harness allows [edit,read,grep].
  // They are disjoint → the runner intersection is [], which must mean deny-all, not all.
  const agentRegistry = new Map([
    ["bash-only", { name: "bash-only", tools: ["bash"], prompt: "", source: "project" as const }],
  ]);
  const byLabel = await runCapture(
    `export const meta = { name: 'denyall', description: 'deny-all' }
const a = await agent('step', { label: 'step', agentType: 'bash-only', harness_config: 'frontend-react-shadcn' })
return { a }`,
    { harness_config: "none", agentRegistry: agentRegistry as unknown as Map<string, unknown> },
  );
  const step = byLabel.get("step");
  assert.ok(step, "call captured");
  assert.equal(step.toolNames?.length, 0, "disjoint agentType/harness ⇒ empty (deny-all) allowlist, not all tools");
});

test("a per-call harness_type conflicting with the config's runtime is rejected (keep run-level)", async () => {
  // harness_config 'opencode-svc' declares runtime opencode; per-call harness_type 'pi'
  // conflicts → reject the override and keep the run-level (backend) harness/fence.
  const byLabel = await runCapture(
    `export const meta = { name: 'mismatch', description: 'type/config mismatch' }
const a = await agent('step', { label: 'step', harness_type: 'pi', harness_config: 'opencode-svc' })
return { a }`,
    { harness_config: "backend-api" },
  );
  const step = byLabel.get("step");
  assert.ok(step, "call captured");
  // Run-level backend-api (bash,read) is kept; the opencode-svc config (tools [read]) is NOT applied.
  assert.ok(step.toolNames?.includes("bash"), "mismatched override keeps the run-level backend tool");
  assert.equal(step.ctxReadGuardrail, undefined, "mismatched override keeps run-level (no guardrail)");
});

test("per-call readOnly fences write tools (verifier stays read-only under a mutating step harness)", async () => {
  const byLabel = await runCapture(
    `export const meta = { name: 'vro', description: 'verifier ro' }
const a = await agent('verify', { label: 'verify', harness_config: 'frontend-react-shadcn', readOnly: true })
return { a }`,
    { harness_config: "none" },
  );
  const v = byLabel.get("verify");
  assert.ok(v, "call captured");
  assert.equal(v.readOnly, true, "per-call readOnly is forwarded");
  // frontend-react-shadcn has tools [edit,read,grep]; readOnly filters edit (write) out.
  assert.ok(!v.toolNames?.includes("edit"), "per-call readOnly fences the write tool");
  assert.ok(v.toolNames?.includes("read"), "per-call readOnly keeps read tools");
});

test("per-call readOnly is narrow-only (cannot lift a run-level readOnly fence)", async () => {
  const byLabel = await runCapture(
    `export const meta = { name: 'narrow-ro', description: 'narrow ro' }
const a = await agent('step', { label: 'step', harness_config: 'frontend-react-shadcn', readOnly: false })
return { a }`,
    { harness_config: "none", readOnly: true },
  );
  const s = byLabel.get("step");
  assert.ok(s, "call captured");
  assert.equal(s.readOnly, true, "run-level readOnly is preserved even when per-call readOnly=false");
  assert.ok(!s.toolNames?.includes("edit"), "write tool still fenced out under run-level readOnly");
});

test("a per-step config without context fields preserves the run-level context fence", async () => {
  // Run-level config sets contextMode 'isolated' (inheritProjectContext=false) + tools.
  // A per-step config with only tools (no contextMode) must NOT clear the isolation.
  const dir = mkdtempSync(join(tmpdir(), "per-call-ctx-"));
  const harnessDir = join(dir, ".pi", "workflows", "harnesses");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "iso-backend.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "iso-backend",
      harness_type: "pi",
      tools: ["bash", "read"],
      contextMode: "isolated",
    }),
  );
  writeFileSync(
    join(harnessDir, "fe-tools-only.json"),
    JSON.stringify({ schemaVersion: 1, id: "fe-tools-only", harness_type: "pi", tools: ["edit", "read", "grep"] }),
  );
  const userDir = mkdtempSync(join(tmpdir(), "per-call-ctx-user-"));
  const registry = loadHarnessConfigRegistry("/unused", { projectDir: harnessDir, userDir });
  const calls: CapturedCall[] = [];
  await runWorkflow(
    `export const meta = { name: 'ctx', description: 'context fence' }
const a = await agent('step', { label: 'step', harness_config: 'fe-tools-only' })
return { a }`,
    {
      agent: capturingRunner(calls),
      harness_config: "iso-backend",
      harnessConfigRegistry: registry,
      cwd: dir,
      concurrency: 1,
      persistLogs: false,
    },
  );
  const step = calls[0];
  assert.ok(step, "call captured");
  // The per-step config has no contextMode → the run-level 'isolated' fence is preserved.
  assert.equal(
    step.inheritProjectContext,
    false,
    "run-level isolated context fence is preserved (not widened to focused)",
  );
  // Tools are narrowed: fe [edit,read,grep] ∩ run-level [bash,read] = [read].
  assert.deepEqual([...(step.toolNames ?? [])], ["read"], "per-step tools narrowed by the run-level allowlist");
});
