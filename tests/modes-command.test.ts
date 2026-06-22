import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_CONTEXT_MODES, buildContextModeRegistry } from "../src/context-mode.js";
import { extractModeFlag, renderModes } from "../src/modes-command.js";

describe("extractModeFlag", () => {
  it("returns no mode and trimmed args when the flag is absent", () => {
    assert.deepEqual(extractModeFlag("  review the auth module  "), { rest: "review the auth module" });
  });

  it("parses `--mode <name>` and strips it from the rest", () => {
    const { mode, rest } = extractModeFlag("--mode isolated review the auth module");
    assert.equal(mode, "isolated");
    assert.equal(rest, "review the auth module");
  });

  it("parses `--mode=<name>` form", () => {
    const { mode, rest } = extractModeFlag("review the auth module --mode=scoped");
    assert.equal(mode, "scoped");
    assert.equal(rest, "review the auth module");
  });

  it("parses a flag in the middle without mangling the surrounding args", () => {
    const { mode, rest } = extractModeFlag("high --mode isolated src/auth");
    assert.equal(mode, "isolated");
    assert.equal(rest, "high src/auth");
  });

  it("is case-insensitive on the flag, not the value", () => {
    const { mode } = extractModeFlag("--MODE Isolated task");
    assert.equal(mode, "Isolated");
  });
});

describe("renderModes", () => {
  it("lists the built-ins with inherit first", () => {
    const out = renderModes(BUILTIN_CONTEXT_MODES);
    const firstModeLine = out.split("\n").find((l) => l.trim().startsWith("inherit"));
    assert.ok(firstModeLine, "inherit row present");
    assert.ok(out.includes("isolated"));
    assert.ok(out.includes("scoped"));
    // inherit should be listed before isolated/scoped
    assert.ok(out.indexOf("inherit") < out.indexOf("isolated"));
  });

  it("includes a project-defined mode", () => {
    const reg = buildContextModeRegistry({
      "lean-builder": { inheritProjectContext: false, systemPromptMode: "append", inheritSkills: true },
    });
    assert.ok(renderModes(reg).includes("lean-builder"));
  });
});
