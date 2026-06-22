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
  it("with no layers resolves to the inherit default (today's behavior)", () => {
    const { primitives, unknownMode } = resolveContextMode(undefined, undefined);
    assert.deepEqual(primitives, DEFAULT_PRIMITIVES);
    assert.equal(unknownMode, undefined);
    // inherit must equal the default triple, byte for byte.
    assert.deepEqual(BUILTIN_CONTEXT_MODES.inherit, DEFAULT_PRIMITIVES);
  });

  it("expands a built-in mode (isolated) to its full triple", () => {
    const { primitives } = resolveContextMode(undefined, { contextMode: "isolated" });
    assert.deepEqual(primitives, {
      inheritProjectContext: false,
      systemPromptMode: "replace",
      inheritSkills: false,
    });
  });

  it("expands scoped: project context kept, prompt replaced, skills dropped", () => {
    const { primitives } = resolveContextMode(undefined, { contextMode: "scoped" });
    assert.deepEqual(primitives, {
      inheritProjectContext: true,
      systemPromptMode: "replace",
      inheritSkills: false,
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
  });

  it("runtime mode beats a frontmatter explicit field", () => {
    // frontmatter says keep skills; runtime mode `isolated` drops them → runtime wins.
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

  it("frontmatter explicit field overrides frontmatter mode", () => {
    const { primitives } = resolveContextMode({ contextMode: "isolated", inheritProjectContext: true }, undefined);
    assert.equal(primitives.inheritProjectContext, true);
  });

  it("full chain: runtime field > runtime mode > frontmatter field > frontmatter mode", () => {
    const { primitives } = resolveContextMode(
      { contextMode: "inherit", systemPromptMode: "replace" }, // fm mode + fm field
      { contextMode: "isolated", inheritProjectContext: true }, // rt mode + rt field
    );
    // runtime mode isolated → (false, replace, false); runtime field flips ctx → true.
    assert.deepEqual(primitives, {
      inheritProjectContext: true,
      systemPromptMode: "replace",
      inheritSkills: false,
    });
  });

  it("unknown mode falls back to default and surfaces the name", () => {
    const { primitives, unknownMode } = resolveContextMode(undefined, { contextMode: "nope" });
    assert.deepEqual(primitives, DEFAULT_PRIMITIVES);
    assert.equal(unknownMode, "nope");
  });
});

// ── needsResourceLoader: the backward-compat gate ───────────────────────────

describe("needsResourceLoader", () => {
  it("is false for the inherit default (no loader → identical session)", () => {
    assert.equal(needsResourceLoader(DEFAULT_PRIMITIVES), false);
  });

  it("is true when project context is dropped", () => {
    assert.equal(needsResourceLoader({ ...DEFAULT_PRIMITIVES, inheritProjectContext: false }), true);
  });

  it("is true when skills are dropped", () => {
    assert.equal(needsResourceLoader({ ...DEFAULT_PRIMITIVES, inheritSkills: false }), true);
  });

  it("is true under systemPromptMode replace", () => {
    assert.equal(needsResourceLoader({ ...DEFAULT_PRIMITIVES, systemPromptMode: "replace" }), true);
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
    };
    const reg = buildContextModeRegistry({ "lean-builder": custom });
    assert.deepEqual(reg["lean-builder"], custom);
    // built-ins still present
    assert.deepEqual(reg.isolated, BUILTIN_CONTEXT_MODES.isolated);
    const { primitives } = resolveContextMode(undefined, { contextMode: "lean-builder" }, reg);
    assert.deepEqual(primitives, custom);
  });

  it("refuses to let a project mode shadow inherit", () => {
    const reg = buildContextModeRegistry({
      inherit: { inheritProjectContext: false, systemPromptMode: "replace", inheritSkills: false },
    });
    assert.deepEqual(reg[DEFAULT_CONTEXT_MODE], DEFAULT_PRIMITIVES);
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
  it("parses contextMode, inheritProjectContext, systemPromptMode, inheritSkills", () => {
    const md = [
      "---",
      "name: reviewer",
      "contextMode: scoped",
      "inheritProjectContext: true",
      "systemPromptMode: replace",
      "inheritSkills: false",
      "---",
      "You are an independent reviewer.",
    ].join("\n");
    const def = parseAgentDefinition(md, "project", "reviewer.md");
    assert.ok(def);
    assert.equal(def.contextMode, "scoped");
    assert.equal(def.inheritProjectContext, true);
    assert.equal(def.systemPromptMode, "replace");
    assert.equal(def.inheritSkills, false);
  });

  it("accepts string booleans and ignores an invalid systemPromptMode", () => {
    const md = ["---", "name: x", 'inheritProjectContext: "false"', "systemPromptMode: nonsense", "---", "body"].join(
      "\n",
    );
    const def = parseAgentDefinition(md, "user", "x.md");
    assert.ok(def);
    assert.equal(def.inheritProjectContext, false);
    assert.equal(def.systemPromptMode, undefined); // invalid → dropped, resolver uses default
  });

  it("leaves the fields undefined when absent (backward compatible)", () => {
    const def = parseAgentDefinition("just a body, no frontmatter", "project", "plain.md");
    assert.ok(def);
    assert.equal(def.contextMode, undefined);
    assert.equal(def.inheritProjectContext, undefined);
    assert.equal(def.systemPromptMode, undefined);
    assert.equal(def.inheritSkills, undefined);
  });

  it("agentDefinitionKey changes when a context field changes (resume invalidation)", () => {
    const base = parseAgentDefinition(["---", "name: a", "---", "b"].join("\n"), "project", "a.md");
    const withMode = parseAgentDefinition(
      ["---", "name: a", "contextMode: isolated", "---", "b"].join("\n"),
      "project",
      "a.md",
    );
    assert.notEqual(agentDefinitionKey(base ?? undefined), agentDefinitionKey(withMode ?? undefined));
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
    // base: isolated (false, replace, false); frontmatter: inherit mode resets all
    // three to (true, append, true); runtime: drop skills only.
    const { primitives } = resolveContextModeLayers([
      { contextMode: "isolated" }, // run-level (lowest)
      { contextMode: "inherit" }, // frontmatter
      { inheritSkills: false }, // per-call (highest)
    ]);
    assert.deepEqual(primitives, {
      inheritProjectContext: true,
      systemPromptMode: "append",
      inheritSkills: false,
    });
  });

  it("a run-level --mode applies when nothing downstream sets context", () => {
    const { primitives } = resolveContextModeLayers([{ contextMode: "isolated" }, undefined, undefined]);
    assert.deepEqual(primitives, BUILTIN_CONTEXT_MODES.isolated);
  });

  it("resolves a project mode through a custom registry across layers", () => {
    const reg = buildContextModeRegistry({
      "lean-builder": { inheritProjectContext: false, systemPromptMode: "append", inheritSkills: true },
    });
    const { primitives, unknownMode } = resolveContextModeLayers([{ contextMode: "lean-builder" }], reg);
    assert.equal(unknownMode, undefined);
    assert.deepEqual(primitives, { inheritProjectContext: false, systemPromptMode: "append", inheritSkills: true });
  });
});

// ── resourceLoaderFlags: the enforcement mapping (pure) ─────────────────────

describe("resourceLoaderFlags", () => {
  it("inherit default → no loader flags engaged, no system prompt", () => {
    assert.deepEqual(resourceLoaderFlags(DEFAULT_PRIMITIVES, "role prompt"), {
      noContextFiles: false,
      noSkills: false,
      systemPrompt: undefined,
    });
  });

  it("isolated → drops context + skills and installs the role prompt", () => {
    assert.deepEqual(resourceLoaderFlags(BUILTIN_CONTEXT_MODES.isolated, "  You are a reviewer.  "), {
      noContextFiles: true,
      noSkills: true,
      systemPrompt: "You are a reviewer.",
    });
  });

  it("scoped → keeps context, drops skills, installs the role prompt", () => {
    const flags = resourceLoaderFlags(BUILTIN_CONTEXT_MODES.scoped, "Reviewer.");
    assert.equal(flags.noContextFiles, false);
    assert.equal(flags.noSkills, true);
    assert.equal(flags.systemPrompt, "Reviewer.");
  });

  it("replace with empty/whitespace prompt yields undefined systemPrompt (no blank prompt)", () => {
    assert.equal(
      resourceLoaderFlags({ ...DEFAULT_PRIMITIVES, systemPromptMode: "replace" }, "   ").systemPrompt,
      undefined,
    );
    assert.equal(
      resourceLoaderFlags({ ...DEFAULT_PRIMITIVES, systemPromptMode: "replace" }, undefined).systemPrompt,
      undefined,
    );
  });

  it("append never installs a system prompt even when text is supplied", () => {
    assert.equal(
      resourceLoaderFlags({ ...DEFAULT_PRIMITIVES, systemPromptMode: "append" }, "ignored").systemPrompt,
      undefined,
    );
  });
});
