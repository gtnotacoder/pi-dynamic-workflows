import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentDefinitionKey, parseAgentDefinition } from "../src/agent-registry.js";
import {
  BUILTIN_CONTEXT_MODES,
  buildContextModeRegistry,
  type ContextPrimitives,
  DEFAULT_CONTEXT_MODE,
  DEFAULT_PRIMITIVES,
  isSystemPromptMode,
  needsResourceLoader,
  resolveContextMode,
  resolveContextModeLayers,
  resourceLoaderFlags,
} from "../src/context-mode.js";

// ── resolveContextMode: defaults & built-in expansion ───────────────────────

describe("resolveContextMode", () => {
  it("with no layers resolves to the `focused` default (shared context+skills, main rules OUT)", () => {
    const { primitives, unknownMode } = resolveContextMode(undefined, undefined);
    assert.deepEqual(primitives, DEFAULT_PRIMITIVES);
    assert.equal(unknownMode, undefined);
    assert.equal(DEFAULT_CONTEXT_MODE, "focused");
    // the default mode equals the default set, byte for byte.
    assert.deepEqual(BUILTIN_CONTEXT_MODES.focused, DEFAULT_PRIMITIVES);
    assert.deepEqual(primitives, {
      inheritProjectContext: true,
      systemPromptMode: "append",
      inheritSkills: true,
      inheritMainRules: false,
    });
  });

  it("`legacy` restores full pre-feature inheritance (incl. main rules)", () => {
    const { primitives } = resolveContextMode(undefined, { contextMode: "legacy" });
    assert.deepEqual(primitives, {
      inheritProjectContext: true,
      systemPromptMode: "append",
      inheritSkills: true,
      inheritMainRules: true,
    });
  });

  it("`inherit` is a back-compat alias of `legacy`", () => {
    const a = resolveContextMode(undefined, { contextMode: "inherit" }).primitives;
    const b = resolveContextMode(undefined, { contextMode: "legacy" }).primitives;
    assert.deepEqual(a, b);
  });

  it("expands `isolated`: no context, role replaces prompt, no skills, no main rules", () => {
    const { primitives } = resolveContextMode(undefined, { contextMode: "isolated" });
    assert.deepEqual(primitives, {
      inheritProjectContext: false,
      systemPromptMode: "replace",
      inheritSkills: false,
      inheritMainRules: false,
    });
  });

  it("expands `scoped`: context kept, prompt replaced, skills dropped, no main rules", () => {
    const { primitives } = resolveContextMode(undefined, { contextMode: "scoped" });
    assert.deepEqual(primitives, {
      inheritProjectContext: true,
      systemPromptMode: "replace",
      inheritSkills: false,
      inheritMainRules: false,
    });
  });

  // ── precedence chain ──────────────────────────────────────────────────────

  it("explicit field overrides the mode in the same layer", () => {
    const { primitives } = resolveContextMode(undefined, {
      contextMode: "isolated",
      inheritProjectContext: true, // override one slot of isolated
    });
    assert.equal(primitives.inheritProjectContext, true);
    assert.equal(primitives.systemPromptMode, "replace"); // untouched slot from mode
    assert.equal(primitives.inheritSkills, false);
    assert.equal(primitives.inheritMainRules, false);
  });

  it("explicit inheritMainRules:true overrides the default block", () => {
    const { primitives } = resolveContextMode(undefined, { inheritMainRules: true });
    assert.equal(primitives.inheritMainRules, true);
    // everything else stays at the focused default
    assert.equal(primitives.inheritProjectContext, true);
    assert.equal(primitives.inheritSkills, true);
  });

  it("runtime mode beats a frontmatter explicit field", () => {
    const { primitives } = resolveContextMode({ inheritSkills: true }, { contextMode: "isolated" });
    assert.equal(primitives.inheritSkills, false);
  });

  it("runtime explicit field beats runtime mode", () => {
    const { primitives } = resolveContextMode(undefined, {
      contextMode: "isolated",
      inheritSkills: true,
    });
    assert.equal(primitives.inheritSkills, true);
  });

  it("frontmatter mode applies when runtime sets nothing", () => {
    const { primitives } = resolveContextMode({ contextMode: "scoped" }, undefined);
    assert.deepEqual(primitives, BUILTIN_CONTEXT_MODES.scoped);
  });

  it("full chain: runtime field > runtime mode > frontmatter field > frontmatter mode", () => {
    const { primitives } = resolveContextMode(
      { contextMode: "legacy", systemPromptMode: "replace" }, // fm mode + fm field
      { contextMode: "isolated", inheritProjectContext: true }, // rt mode + rt field
    );
    // runtime mode isolated → (false, replace, false, false); runtime field flips ctx → true.
    assert.deepEqual(primitives, {
      inheritProjectContext: true,
      systemPromptMode: "replace",
      inheritSkills: false,
      inheritMainRules: false,
    });
  });

  it("unknown mode falls back to the default and surfaces the name", () => {
    const { primitives, unknownMode } = resolveContextMode(undefined, { contextMode: "nope" });
    assert.deepEqual(primitives, DEFAULT_PRIMITIVES);
    assert.equal(unknownMode, "nope");
  });
});

// ── needsResourceLoader: the backward-compat gate ───────────────────────────

describe("needsResourceLoader", () => {
  it("is FALSE only for `legacy` (no loader → byte-identical pre-feature session)", () => {
    assert.equal(needsResourceLoader(BUILTIN_CONTEXT_MODES.legacy), false);
  });

  it("is TRUE for the `focused` default (must block the main-rules channel)", () => {
    assert.equal(needsResourceLoader(DEFAULT_PRIMITIVES), true);
  });

  it("is true when project context is dropped", () => {
    assert.equal(needsResourceLoader({ ...BUILTIN_CONTEXT_MODES.legacy, inheritProjectContext: false }), true);
  });

  it("is true when skills are dropped", () => {
    assert.equal(needsResourceLoader({ ...BUILTIN_CONTEXT_MODES.legacy, inheritSkills: false }), true);
  });

  it("is true under systemPromptMode replace", () => {
    assert.equal(needsResourceLoader({ ...BUILTIN_CONTEXT_MODES.legacy, systemPromptMode: "replace" }), true);
  });

  it("is true when main rules are blocked", () => {
    assert.equal(needsResourceLoader({ ...BUILTIN_CONTEXT_MODES.legacy, inheritMainRules: false }), true);
  });
});

// ── project-defined modes ───────────────────────────────────────────────────

describe("buildContextModeRegistry", () => {
  it("returns the built-ins unchanged when no project modes are given", () => {
    assert.equal(buildContextModeRegistry(undefined), BUILTIN_CONTEXT_MODES);
  });

  it("merges a project-defined mode over the built-ins", () => {
    const custom: ContextPrimitives = {
      inheritProjectContext: false,
      systemPromptMode: "append",
      inheritSkills: true,
      inheritMainRules: false,
    };
    const reg = buildContextModeRegistry({ "lean-builder": custom });
    assert.deepEqual(reg["lean-builder"], custom);
    assert.deepEqual(reg.isolated, BUILTIN_CONTEXT_MODES.isolated);
    const { primitives } = resolveContextMode(undefined, { contextMode: "lean-builder" }, reg);
    assert.deepEqual(primitives, custom);
  });

  it("refuses to let a project mode shadow a reserved built-in name", () => {
    const reg = buildContextModeRegistry({
      focused: {
        inheritProjectContext: false,
        systemPromptMode: "replace",
        inheritSkills: false,
        inheritMainRules: true,
      },
      legacy: {
        inheritProjectContext: false,
        systemPromptMode: "replace",
        inheritSkills: false,
        inheritMainRules: false,
      },
    });
    assert.deepEqual(reg.focused, DEFAULT_PRIMITIVES);
    assert.deepEqual(reg.legacy, BUILTIN_CONTEXT_MODES.legacy);
  });
});

// ── isSystemPromptMode guard ────────────────────────────────────────────────

describe("isSystemPromptMode", () => {
  it("accepts only append/replace", () => {
    assert.equal(isSystemPromptMode("append"), true);
    assert.equal(isSystemPromptMode("replace"), true);
    assert.equal(isSystemPromptMode("REPLACE"), false);
    assert.equal(isSystemPromptMode("task"), false);
    assert.equal(isSystemPromptMode(undefined), false);
    assert.equal(isSystemPromptMode(true), false);
  });
});

// ── frontmatter parsing of the new fields ───────────────────────────────────

describe("parseAgentDefinition — context fields", () => {
  it("parses contextMode, inheritProjectContext, systemPromptMode, inheritSkills, inheritMainRules", () => {
    const md = [
      "---",
      "name: reviewer",
      "contextMode: scoped",
      "inheritProjectContext: true",
      "systemPromptMode: replace",
      "inheritSkills: false",
      "inheritMainRules: true",
      "---",
      "You are an independent reviewer.",
    ].join("\n");
    const def = parseAgentDefinition(md, "project", "reviewer.md");
    assert.ok(def);
    assert.equal(def.contextMode, "scoped");
    assert.equal(def.inheritProjectContext, true);
    assert.equal(def.systemPromptMode, "replace");
    assert.equal(def.inheritSkills, false);
    assert.equal(def.inheritMainRules, true);
  });

  it("accepts string booleans and ignores an invalid systemPromptMode", () => {
    const md = [
      "---",
      "name: x",
      'inheritProjectContext: "false"',
      'inheritMainRules: "true"',
      "systemPromptMode: nonsense",
      "---",
      "body",
    ].join("\n");
    const def = parseAgentDefinition(md, "user", "x.md");
    assert.ok(def);
    assert.equal(def.inheritProjectContext, false);
    assert.equal(def.inheritMainRules, true);
    assert.equal(def.systemPromptMode, undefined);
  });

  it("leaves the fields undefined when absent (backward compatible)", () => {
    const def = parseAgentDefinition("just a body, no frontmatter", "project", "plain.md");
    assert.ok(def);
    assert.equal(def.contextMode, undefined);
    assert.equal(def.inheritProjectContext, undefined);
    assert.equal(def.systemPromptMode, undefined);
    assert.equal(def.inheritSkills, undefined);
    assert.equal(def.inheritMainRules, undefined);
  });

  it("agentDefinitionKey changes when inheritMainRules changes (resume invalidation)", () => {
    const base = parseAgentDefinition(["---", "name: a", "---", "b"].join("\n"), "project", "a.md");
    const withRules = parseAgentDefinition(
      ["---", "name: a", "inheritMainRules: true", "---", "b"].join("\n"),
      "project",
      "a.md",
    );
    assert.notEqual(agentDefinitionKey(base ?? undefined), agentDefinitionKey(withRules ?? undefined));
  });
});

// ── resolveContextModeLayers: run-level base layer ──────────────────────────

describe("resolveContextModeLayers", () => {
  it("matches resolveContextMode for the [frontmatter, runtime] case", () => {
    const a = resolveContextModeLayers([{ contextMode: "scoped" }, { inheritSkills: true }]);
    const b = resolveContextMode({ contextMode: "scoped" }, { inheritSkills: true });
    assert.deepEqual(a.primitives, b.primitives);
  });

  it("run-level base is overridden by frontmatter, which is overridden by runtime", () => {
    const { primitives } = resolveContextModeLayers([
      { contextMode: "isolated" }, // run-level (lowest)
      { contextMode: "legacy" }, // frontmatter resets all to legacy
      { inheritSkills: false }, // per-call (highest)
    ]);
    assert.deepEqual(primitives, {
      inheritProjectContext: true,
      systemPromptMode: "append",
      inheritSkills: false,
      inheritMainRules: true,
    });
  });

  it("a run-level --mode applies when nothing downstream sets context", () => {
    const { primitives } = resolveContextModeLayers([{ contextMode: "isolated" }, undefined, undefined]);
    assert.deepEqual(primitives, BUILTIN_CONTEXT_MODES.isolated);
  });

  it("resolves a project mode through a custom registry across layers", () => {
    const reg = buildContextModeRegistry({
      "lean-builder": {
        inheritProjectContext: false,
        systemPromptMode: "append",
        inheritSkills: true,
        inheritMainRules: false,
      },
    });
    const { primitives, unknownMode } = resolveContextModeLayers([{ contextMode: "lean-builder" }], reg);
    assert.equal(unknownMode, undefined);
    assert.deepEqual(primitives, {
      inheritProjectContext: false,
      systemPromptMode: "append",
      inheritSkills: true,
      inheritMainRules: false,
    });
  });
});

// ── resourceLoaderFlags: the enforcement mapping (pure) ─────────────────────

describe("resourceLoaderFlags", () => {
  it("`focused` default → block ONLY the main-rules append channel", () => {
    assert.deepEqual(resourceLoaderFlags(DEFAULT_PRIMITIVES, "role prompt"), {
      noContextFiles: false,
      noSkills: false,
      systemPrompt: undefined,
      appendSystemPrompt: [],
    });
  });

  it("`legacy` → no flags engaged at all (loader not even constructed upstream)", () => {
    assert.deepEqual(resourceLoaderFlags(BUILTIN_CONTEXT_MODES.legacy, "role prompt"), {
      noContextFiles: false,
      noSkills: false,
      systemPrompt: undefined,
      appendSystemPrompt: undefined,
    });
  });

  it("isolated → drops context + skills + main rules and installs the role prompt", () => {
    assert.deepEqual(resourceLoaderFlags(BUILTIN_CONTEXT_MODES.isolated, "  You are a reviewer.  "), {
      noContextFiles: true,
      noSkills: true,
      systemPrompt: "You are a reviewer.",
      appendSystemPrompt: [],
    });
  });

  it("scoped → keeps context, drops skills + main rules, installs the role prompt", () => {
    const flags = resourceLoaderFlags(BUILTIN_CONTEXT_MODES.scoped, "Reviewer.");
    assert.equal(flags.noContextFiles, false);
    assert.equal(flags.noSkills, true);
    assert.equal(flags.systemPrompt, "Reviewer.");
    assert.deepEqual(flags.appendSystemPrompt, []);
  });

  it("replace with empty/whitespace prompt yields undefined systemPrompt (no blank prompt)", () => {
    assert.equal(
      resourceLoaderFlags({ ...BUILTIN_CONTEXT_MODES.legacy, systemPromptMode: "replace" }, "   ").systemPrompt,
      undefined,
    );
    assert.equal(
      resourceLoaderFlags({ ...BUILTIN_CONTEXT_MODES.legacy, systemPromptMode: "replace" }, undefined).systemPrompt,
      undefined,
    );
  });

  it("append never installs a system prompt even when text is supplied", () => {
    assert.equal(
      resourceLoaderFlags({ ...BUILTIN_CONTEXT_MODES.legacy, systemPromptMode: "append" }, "ignored").systemPrompt,
      undefined,
    );
  });

  it("inheritMainRules true → appendSystemPrompt undefined (loader discovers the file); false → []", () => {
    assert.equal(
      resourceLoaderFlags({ ...DEFAULT_PRIMITIVES, inheritMainRules: true }, undefined).appendSystemPrompt,
      undefined,
    );
    assert.deepEqual(
      resourceLoaderFlags({ ...DEFAULT_PRIMITIVES, inheritMainRules: false }, undefined).appendSystemPrompt,
      [],
    );
  });
});
