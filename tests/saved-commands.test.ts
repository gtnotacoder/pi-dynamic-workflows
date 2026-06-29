import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SavedWorkflow } from "../src/workflow-saved.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

function savedWorkflow(overrides: Partial<SavedWorkflow> & Pick<SavedWorkflow, "name" | "script">): SavedWorkflow {
  return {
    description: "Test workflow",
    location: "user",
    path: `/tmp/${overrides.name}.json`,
    savedAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

async function load() {
  return import("../src/saved-commands.js");
}

function parseInlineArgsReport(content: string | undefined): { _?: string; _raw?: string; mode?: string } {
  try {
    return JSON.parse(content ?? "{}") as { _?: string; _raw?: string; mode?: string };
  } catch (error) {
    assert.fail(`expected inline workflow report to be valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function toolNames(tools: unknown): string[] {
  return Array.isArray(tools)
    ? tools.map((tool) => String((tool as { name?: unknown }).name ?? "")).filter(Boolean)
    : [];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("parseCommandArgs", () => {
  it("parses key=value pairs", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar count=42");
    assert.equal(result.foo, "bar");
    assert.equal(result.count, "42");
  });

  it("collects positional args into _", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello world");
    assert.equal(result._, "hello world");
  });

  it("handles mixed positional and key=value", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("task=test hello world");
    assert.equal(result.task, "test");
    assert.equal(result._, "hello world");
  });

  it("sets _raw to the trimmed input", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("  foo=bar  ");
    assert.equal(result._raw, "foo=bar");
  });

  it("returns empty when input is empty", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("");
    assert.equal(result._, "");
    assert.equal(result._raw, "");
  });

  it("fills parameter defaults for missing keys", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar", {
      foo: { type: "string" },
      limit: { type: "number", default: 10 },
      label: { type: "string", default: "test" },
    });
    assert.equal(result.foo, "bar");
    assert.equal(result.limit, 10);
    assert.equal(result.label, "test");
  });

  it("does NOT override explicit values with defaults", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("limit=5", { limit: { type: "number", default: 10 } });
    assert.equal(result.limit, "5");
  });

  it("handles value-only token as positional", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello key=value world");
    assert.equal(result._, "hello world");
    assert.equal(result.key, "value");
  });

  it("handles URLs as positional arguments", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("https://example.com");
    assert.equal(result._, "https://example.com");
  });
});

describe("registerSavedWorkflow", () => {
  it("registers a command with the workflow name", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const wf = savedWorkflow({
      name: "test-workflow",
      script: "export const meta = { name: 't', description: 't' };",
      description: "A test",
    });

    registerSavedWorkflow(pi, "/cwd", wf);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "test-workflow");
  });

  it("advertises [--mode <name>] in the description while preserving the workflow's own description", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const wf = savedWorkflow({
      name: "with-desc",
      script: "export const meta = { name: 't', description: 't' };",
      description: "Run a deep research sweep",
    });

    registerSavedWorkflow(pi, "/cwd", wf);
    assert.equal(commands[0].description, "Run a deep research sweep [--mode <name>]");
  });

  it("does not duplicate the --mode hint when the description already mentions --mode", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const wf = savedWorkflow({
      name: "mentions-mode",
      script: "export const meta = { name: 't', description: 't' };",
      description: "Research [--mode <name>] <question>",
    });

    registerSavedWorkflow(pi, "/cwd", wf);
    assert.equal(commands[0].description, "Research [--mode <name>] <question>");
  });

  it("strips --mode from args and threads it into the manager run as contextMode", async () => {
    const { registerSavedWorkflow } = await load();
    let captured: { args?: unknown; contextMode?: string } = {};
    const manager = {
      startInBackground: (_script: string, args: unknown, exec?: { contextMode?: string }) => {
        captured = { args, contextMode: exec?.contextMode };
        return { runId: "run-1", promise: Promise.resolve({ result: { report: "ok" } }) };
      },
      getRun: () => ({ transcriptDir: "/tmp/t" }),
    };

    const { pi, commands } = makeCommandRegistryPi();
    const wf = savedWorkflow({ name: "mode-flow", script: "export..." });
    registerSavedWorkflow(pi, "/cwd", wf, manager as never);

    const { ctx } = makeNotifyCtx();
    await commands[0].handler("--mode isolated review the auth module", ctx);

    assert.equal(captured.contextMode, "isolated", "mode should be threaded into the manager run");
    assert.equal((captured.args as { _?: string })._, "review the auth module", "flag should be stripped from args");
    assert.equal((captured.args as { _raw?: string })._raw, "review the auth module");
  });

  it("accepts the --mode=<name> (equals) form and still threads contextMode + strips the flag", async () => {
    const { registerSavedWorkflow } = await load();
    let captured: { args?: unknown; contextMode?: string } = {};
    const manager = {
      startInBackground: (_script: string, args: unknown, exec?: { contextMode?: string }) => {
        captured = { args, contextMode: exec?.contextMode };
        return { runId: "run-2", promise: Promise.resolve({ result: { report: "ok" } }) };
      },
      getRun: () => ({ transcriptDir: "/tmp/t" }),
    };

    const { pi, commands } = makeCommandRegistryPi();
    const wf = savedWorkflow({ name: "mode-eq", script: "export..." });
    registerSavedWorkflow(pi, "/cwd", wf, manager as never);

    const { ctx } = makeNotifyCtx();
    await commands[0].handler("--mode=scoped review the auth module", ctx);

    assert.equal(captured.contextMode, "scoped", "--mode=<name> should set contextMode");
    assert.equal(
      (captured.args as { _?: string })._,
      "review the auth module",
      "--mode=<name> flag should be stripped from args",
    );
    assert.equal((captured.args as { _raw?: string })._raw, "review the auth module");
  });

  it("passes mode=value (no -- prefix) through as a normal workflow parameter", async () => {
    const { registerSavedWorkflow } = await load();
    let captured: { args?: unknown; contextMode?: string } = {};
    const manager = {
      startInBackground: (_script: string, args: unknown, exec?: { contextMode?: string }) => {
        captured = { args, contextMode: exec?.contextMode };
        return { runId: "run-3", promise: Promise.resolve({ result: { report: "ok" } }) };
      },
      getRun: () => ({ transcriptDir: "/tmp/t" }),
    };

    const { pi, commands } = makeCommandRegistryPi();
    const wf = savedWorkflow({ name: "mode-param", script: "export..." });
    registerSavedWorkflow(pi, "/cwd", wf, manager as never);

    const { ctx } = makeNotifyCtx();
    await commands[0].handler("mode=fast review the auth module", ctx);

    assert.equal(
      captured.contextMode,
      undefined,
      "mode=... without -- must NOT be treated as the run-level context-mode flag",
    );
    assert.equal(
      (captured.args as { mode?: string }).mode,
      "fast",
      "mode=value should remain a normal parsed workflow parameter",
    );
    assert.equal((captured.args as { _?: string })._, "review the auth module");
  });

  it("inline fallback strips --mode from args._/args._raw and does not pass it as a parameter", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();

    // A no-agent script that echoes its parsed args back as the report. This
    // proves the inline runWorkflow path receives args with `--mode` already
    // stripped by extractModeFlag (via parseCommandArgs on the `rest` string).
    const wf = savedWorkflow({
      name: "inline-strip",
      script: "export const meta = { name: 't', description: 't' };\nreturn { report: JSON.stringify(args) };",
    });
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      registerSavedWorkflow(pi, "/cwd", wf); // no manager → inline runWorkflow path

      const { ctx } = makeNotifyCtx();
      await withFakeHomeAsync(fakeHome, async () => {
        await commands[0].handler("--mode isolated review the auth module", ctx);
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }

    assert.equal(sent.length, 1, "inline fallback should deliver exactly one result message");
    const payload = parseInlineArgsReport(sent[0].content);
    assert.equal(
      payload._,
      "review the auth module",
      "--mode should be stripped from args._ before the script sees it",
    );
    assert.equal(payload._raw, "review the auth module", "--mode should be stripped from args._raw");
    assert.equal(payload.mode, undefined, "the stripped --mode value must not leak through as a `mode` parameter");
  });

  it("is idempotent — second registration is skipped", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi(["test-workflow"]);
    const wf = savedWorkflow({ name: "test-workflow", script: "export const meta = { name: 't', description: 't' };" });

    registerSavedWorkflow(pi, "/cwd", wf);
    assert.equal(commands.length, 0, "should not re-register when already present");
  });

  it("skips a saved workflow whose name collides with an existing command and warns the user", async () => {
    const { registerSavedWorkflow } = await load();
    // Pretend a builtin/reserved command named `fugu` is already registered.
    const { pi, commands, sent } = makeCommandRegistryPi(["fugu"]);
    const wf = savedWorkflow({
      name: "fugu",
      script: "export const meta = { name: 't', description: 't' };",
    });

    registerSavedWorkflow(pi, "/cwd", wf);

    // No command is registered — the collision is NOT silently shadowed.
    assert.equal(commands.length, 0, "colliding saved workflow must not be registered as a command");

    // A deterministic warning message is delivered so the user knows it was skipped.
    assert.equal(sent.length, 1, "exactly one collision warning should be sent");
    assert.equal(sent[0].customType, "workflow:saved-command-collision");
    assert.match(
      sent[0].content ?? "",
      /\/fugu.*already exists/i,
      "warning should explain /fugu already exists and the saved workflow was skipped",
    );
    assert.match(sent[0].content ?? "", /rename/i, "warning should suggest renaming the saved workflow");
  });

  it("registers multiple saved workflows", async () => {
    const { registerAllSavedWorkflows } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const storage = {
      list: () => [
        { name: "wf1", script: "export..." },
        { name: "wf2", script: "export..." },
      ],
    };

    registerAllSavedWorkflows(pi, "/cwd", storage as never);
    assert.deepEqual(
      commands.map((c) => c.name),
      ["wf1", "wf2"],
    );
  });

  it("runs through WorkflowManager when provided", async () => {
    const { registerSavedWorkflow } = await load();
    let startedBackground = false;
    const manager = {
      startInBackground: (_script: string, _args: unknown) => {
        startedBackground = true;
        return { runId: "test-run", promise: Promise.resolve({ result: { report: "done" } }) };
      },
      getRun: (_runId: string) => ({ transcriptDir: "/tmp/subagents" }),
    };

    const { pi, commands, sent } = makeCommandRegistryPi();
    const wf = savedWorkflow({ name: "run-via-manager", script: "export..." });
    registerSavedWorkflow(pi, "/cwd", wf, manager as never);

    const { ctx } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.equal(startedBackground, true, "should use startInBackground when manager provided");
    assert.equal(sent.length, 1, "manager path should immediately announce the background run");
    assert.equal(sent[0].customType, "workflow:run-via-manager:started");
    assert.match(sent[0].content ?? "", /Run ID: test-run/);
  });

  it("runs saved review workflows with read-only tools and keeps one-shot panes non-interactive until completion", async () => {
    const { registerSavedWorkflow } = await load();
    const run = deferred<{ result: { report: string } }>();
    let capturedExec: { tools?: unknown } | undefined;
    const manager = {
      startInBackground: (_script: string, _args: unknown, exec?: { tools?: unknown }) => {
        capturedExec = exec;
        return { runId: "review-run", promise: run.promise };
      },
      getRun: (_runId: string) => ({ transcriptDir: "/tmp/subagents" }),
    };

    const { pi, commands, sent } = makeCommandRegistryPi();
    const wf = savedWorkflow({
      name: "pr_adversarial_review",
      description: "Read-only adversarial PR review",
      script: "export...",
    });
    registerSavedWorkflow(pi, "/cwd", wf, manager as never);

    const { ctx } = makeNotifyCtx();
    let settled = false;
    const handlerPromise = Promise.resolve(commands[0].handler("prNumber=52", ctx)).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sent.length, 1, "review command should still announce the background run");
    assert.equal(settled, false, "review command should await completion instead of returning to an interactive pane");
    const names = toolNames(capturedExec?.tools);
    assert.ok(names.length > 0, "review workflow should receive an explicit read-only tool set");
    assert.equal(names.includes("edit"), false, "read-only review workflow must not expose edit");
    assert.equal(names.includes("write"), false, "read-only review workflow must not expose write");

    run.resolve({ result: { report: "done" } });
    await handlerPromise;
    assert.equal(settled, true);
  });

  it("keeps explicit repair saved workflows on the mutating tool policy and returns immediately", async () => {
    const { registerSavedWorkflow } = await load();
    let capturedExec: { tools?: unknown } | undefined;
    const manager = {
      startInBackground: (_script: string, _args: unknown, exec?: { tools?: unknown }) => {
        capturedExec = exec;
        return { runId: "repair-run", promise: Promise.resolve({ result: { report: "done" } }) };
      },
      getRun: (_runId: string) => ({ transcriptDir: "/tmp/subagents" }),
    };

    const { pi, commands } = makeCommandRegistryPi();
    const wf = savedWorkflow({
      name: "surgical_pr_repair",
      description: "Repair review findings",
      script: "export...",
    });
    registerSavedWorkflow(pi, "/cwd", wf, manager as never);

    const { ctx } = makeNotifyCtx();
    await commands[0].handler("prNumber=52", ctx);

    const names = toolNames(capturedExec?.tools);
    assert.ok(names.includes("edit") || names.includes("write"), "repair workflows should retain mutating tools");
  });

  it("falls back to runWorkflow (inline) when no manager is provided", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();

    // A script with no agent() calls runs to completion inline without a manager.
    const wf = savedWorkflow({
      name: "run-inline",
      script: "export const meta = { name: 't', description: 't' };\nreturn { report: 'done' };",
    });
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      registerSavedWorkflow(pi, "/cwd", wf); // no manager

      const { ctx } = makeNotifyCtx();
      await withFakeHomeAsync(fakeHome, async () => {
        await commands[0].handler("", ctx);
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }

    // The inline fallback ran to completion and delivered the report — proving it
    // did not crash on the missing manager and actually executed runWorkflow().
    assert.equal(sent.length, 1, "fallback should deliver exactly one result message");
    assert.equal(sent[0].customType, "workflow:run-inline");
    assert.ok(sent[0].content?.includes("done"), "delivered content should include the workflow's report");
  });

  it("a deleted workflow's lingering command notifies and does not run", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();

    const wf = savedWorkflow({
      name: "gone",
      script: "export const meta = { name: 't', description: 't' };\nreturn 1;",
    });
    // exists() reports the workflow has been deleted from storage.
    registerSavedWorkflow(pi, "/cwd", wf, undefined, () => false);

    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.equal(sent.length, 0, "a deleted workflow should not run or deliver a result");
    assert.equal(notified.length, 1, "the user should be told the command is stale");
    assert.match(notified[0].message, /deleted/i);
  });
});
