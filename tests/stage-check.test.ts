import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectDefaultStageCheckCommands,
  renderStageCheckFeedback,
  runStageCheck,
  type StageCheckCommandResult,
  type StageCheckRunner,
} from "../src/stage-check.js";

test("detectDefaultStageCheckCommands finds TypeScript and Biome checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "stage-check-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "biome.json"), "{}");
    const commands = detectDefaultStageCheckCommands(dir, "src/foo.ts");
    assert.deepEqual(
      commands.map((command) => command.name),
      ["typescript", "biome"],
    );
    assert.deepEqual(commands[0].args, ["exec", "--", "tsc", "--noEmit"]);
    assert.deepEqual(commands[1].args, ["exec", "--", "biome", "check", "src/foo.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStageCheck executes commands through an injectable host runner", async () => {
  const seen: string[] = [];
  const runner: StageCheckRunner = async (command, options): Promise<StageCheckCommandResult> => {
    seen.push(`${command.name}:${options.cwd}`);
    return {
      name: command.name,
      command: command.command,
      args: command.args ?? [],
      ok: command.name !== "bad",
      exitCode: command.name === "bad" ? 1 : 0,
      signal: null,
      durationMs: 3,
      timedOut: false,
      stdout: command.name === "bad" ? "" : "ok",
      stderr: command.name === "bad" ? "Type error" : "",
      summary: command.name === "bad" ? "bad failed (exit 1): Type error" : "good passed",
    };
  };

  const result = await runStageCheck({
    cwd: "/repo",
    targetFile: "src/foo.ts",
    commands: [
      { name: "good", command: "true" },
      { name: "bad", command: "false" },
    ],
    runner,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(seen, ["good:/repo", "bad:/repo"]);
  assert.match(result.summary, /bad/);
  const feedback = renderStageCheckFeedback(result);
  assert.match(feedback, /Type error/);
  assert.doesNotMatch(feedback, /good passed/);
});

test("runStageCheck returns ok when no default checks are present", async () => {
  const result = await runStageCheck({ includeDefaultChecks: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, []);
  assert.match(result.summary, /No host-side stage checks/);
});
