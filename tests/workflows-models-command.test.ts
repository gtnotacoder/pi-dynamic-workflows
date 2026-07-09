/**
 * Tests for workflows-models-command.ts
 *
 * Since pi.registerCommand and ctx.ui functions are only available at runtime
 * inside Pi, these tests focus on the pure logic: command creation,
 * the editSingleTier single-select helper, and integration with model-tier-config.
 *
 * editSingleTier now uses ctx.ui.custom() with SelectList.
 * In tests, we mock ctx.ui.custom to directly return the expected value.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

async function loadCommand() {
  const mod = await import("../src/workflows-models-command.js");
  return mod;
}

describe("workflows-models-command", () => {
  describe("registerWorkflowModelsCommand", () => {
    it("registers the workflows-models command with Pi", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      const commands: string[] = [];
      const mockPi = {
        registerCommand: mock.fn((name: string, _opts: unknown) => {
          commands.push(name);
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);

      assert.equal(mockPi.registerCommand.mock.callCount(), 1);
      assert.equal(commands[0], "workflows-models");
    });

    it("provides a description", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      let capturedDescription = "";

      const mockPi = {
        registerCommand: mock.fn((_name: string, opts: { description?: string }) => {
          capturedDescription = opts.description ?? "";
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);
      assert.ok(capturedDescription.length > 0, "description should not be empty");
      assert.ok(capturedDescription.toLowerCase().includes("tier"), "description should mention tiers");
    });

    it("preserves routing notes when resetting only the tiers", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      const fakeHome = mkdtempSync(join(tmpdir(), "workflows-models-home-"));
      const configPath = join(fakeHome, ".pi", "workflows", "model-tiers.json");
      mkdirSync(join(fakeHome, ".pi", "workflows"), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          tiers: { small: "old/small", medium: "old/medium", big: "old/big" },
          routingNotes: ["Keep this operator policy."],
        }),
      );

      try {
        await withFakeHomeAsync(fakeHome, async () => {
          let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
          const mockPi = {
            registerCommand: mock.fn(
              (_name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
                handler = opts.handler;
              },
            ),
          };
          registerWorkflowModelsCommand(mockPi as never);
          assert.ok(handler);

          const selections = ["Reset to defaults", "Save and exit"];
          const ctx = {
            model: { provider: "openai-codex", id: "gpt-5.6-sol" },
            waitForIdle: mock.fn(async () => undefined),
            ui: {
              select: mock.fn(async () => selections.shift()),
              confirm: mock.fn(async () => true),
              notify: mock.fn(),
            },
          };
          await handler("", ctx);
        });

        const saved = JSON.parse(readFileSync(configPath, "utf8"));
        assert.deepEqual(saved.routingNotes, ["Keep this operator policy."]);
        assert.deepEqual(saved.tiers, {
          small: "openai-codex/gpt-5.6-sol",
          medium: "openai-codex/gpt-5.6-sol",
          big: "openai-codex/gpt-5.6-sol",
        });
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });

  describe("editSingleTier", () => {
    it("exports editSingleTier function", async () => {
      const mod = await import("../src/workflows-models-command.js");
      assert.equal(typeof mod.editSingleTier, "function");
    });

    it("returns null when user presses Escape (done with null)", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      // Mock ctx.ui.custom to return null (simulating user cancelling)
      const ctx = {
        ui: {
          custom: mock.fn(async () => null),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.equal(result, null);
    });

    it("returns null when user selects the same model (no change)", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      // Mock ctx.ui.custom to return the same model that's already selected
      const ctx = {
        ui: {
          custom: mock.fn(async () => "gpt-4.1-mini"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.equal(result, null); // no change
    });

    it("selects a different model and returns updated tiers", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      // Mock ctx.ui.custom to return a different model
      const ctx = {
        ui: {
          custom: mock.fn(async () => "gpt-5"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.equal(result.small, "gpt-5", "should have changed model");
      assert.equal(typeof result.small, "string", "should still be a string");
    });

    it("selects a model when no current model exists", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = {
        ui: {
          custom: mock.fn(async () => "openai/gpt-4.1-mini"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = {};

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.equal(result.small, "openai/gpt-4.1-mini");
    });
  });
});
