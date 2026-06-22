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
  it("lists the built-ins with the default (focused) first, and shows the main-rules column", () => {
    const out = renderModes(BUILTIN_CONTEXT_MODES);
    const rowLines = out.split("\n").filter((l) => /^\s{2}\S/.test(l));
    assert.ok(rowLines[0]?.trim().startsWith("focused"), "focused row first");
    assert.ok(out.includes("isolated"));
    assert.ok(out.includes("scoped"));
    assert.ok(out.includes("legacy"));
    assert.ok(out.includes("main-rules:out"), "main-rules column present");
    // focused listed before the others
    assert.ok(out.indexOf("focused") < out.indexOf("isolated"));
  });

  it("hides the `inherit` alias from the listing (it duplicates legacy)", () => {
    const rows = renderModes(BUILTIN_CONTEXT_MODES)
      .split("\n")
      .filter((l) => /^\s{2}\S/.test(l))
      .map((l) => l.trim().split(/\s+/)[0]);
    assert.ok(!rows.includes("inherit"), "no inherit row");
    assert.ok(rows.includes("legacy"), "legacy row present");
  });

  it("includes a project-defined mode", () => {
    const reg = buildContextModeRegistry({
      "lean-builder": {
        inheritProjectContext: false,
        systemPromptMode: "append",
        inheritSkills: true,
        inheritMainRules: false,
      },
    });
    assert.ok(renderModes(reg).includes("lean-builder"));
  });
});
