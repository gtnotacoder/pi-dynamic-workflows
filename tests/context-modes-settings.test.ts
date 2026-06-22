import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadWorkflowSettings } from "../src/workflow-settings.js";

describe("WorkflowSettings.contextModes normalization", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-ctxmodes-"));
    path = join(dir, "settings.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const load = (obj: unknown) => {
    writeFileSync(path, JSON.stringify(obj), "utf-8");
    return loadWorkflowSettings(path);
  };

  it("keeps a fully-specified valid mode", () => {
    const mode = {
      inheritProjectContext: false,
      systemPromptMode: "append",
      inheritSkills: true,
      inheritMainRules: false,
    };
    const s = load({ contextModes: { "lean-builder": mode } });
    assert.deepEqual(s.contextModes, { "lean-builder": mode });
  });

  it("drops entries missing a field (incl. inheritMainRules) or with a bad systemPromptMode", () => {
    const s = load({
      contextModes: {
        partial: { inheritProjectContext: true }, // missing fields
        noMainRules: { inheritProjectContext: true, systemPromptMode: "append", inheritSkills: true }, // missing inheritMainRules
        badmode: {
          inheritProjectContext: true,
          systemPromptMode: "nonsense",
          inheritSkills: true,
          inheritMainRules: false,
        },
        good: {
          inheritProjectContext: true,
          systemPromptMode: "replace",
          inheritSkills: false,
          inheritMainRules: true,
        },
      },
    });
    assert.deepEqual(Object.keys(s.contextModes ?? {}), ["good"]);
  });

  it("ignores reserved built-in names (inherit, focused, legacy, isolated, scoped)", () => {
    const triple = {
      inheritProjectContext: false,
      systemPromptMode: "replace",
      inheritSkills: false,
      inheritMainRules: false,
    };
    const s = load({
      contextModes: {
        inherit: triple,
        focused: triple,
        legacy: triple,
        isolated: triple,
        scoped: triple,
        custom: triple,
      },
    });
    assert.deepEqual(Object.keys(s.contextModes ?? {}), ["custom"]);
  });

  it("leaves contextModes undefined when none are valid (built-ins used unchanged)", () => {
    const s = load({ contextModes: { bad: { inheritProjectContext: 1 } } });
    assert.equal(s.contextModes, undefined);
  });

  it("leaves contextModes undefined when the key is absent", () => {
    const s = load({ defaultConcurrency: 4 });
    assert.equal(s.contextModes, undefined);
  });
});
