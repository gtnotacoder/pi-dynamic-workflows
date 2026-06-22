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
    const s = load({
      contextModes: {
        "lean-builder": { inheritProjectContext: false, systemPromptMode: "append", inheritSkills: true },
      },
    });
    assert.deepEqual(s.contextModes, {
      "lean-builder": { inheritProjectContext: false, systemPromptMode: "append", inheritSkills: true },
    });
  });

  it("drops entries missing a field or with a bad systemPromptMode", () => {
    const s = load({
      contextModes: {
        partial: { inheritProjectContext: true }, // missing fields
        badmode: { inheritProjectContext: true, systemPromptMode: "nonsense", inheritSkills: true },
        good: { inheritProjectContext: true, systemPromptMode: "replace", inheritSkills: false },
      },
    });
    assert.deepEqual(Object.keys(s.contextModes ?? {}), ["good"]);
  });

  it("ignores the reserved name `inherit`", () => {
    const s = load({
      contextModes: {
        inherit: { inheritProjectContext: false, systemPromptMode: "replace", inheritSkills: false },
        custom: { inheritProjectContext: false, systemPromptMode: "replace", inheritSkills: false },
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
