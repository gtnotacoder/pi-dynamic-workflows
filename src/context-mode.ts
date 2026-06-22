/**
 * Context modes — named per-subagent governance presets.
 *
 * A context mode bundles inheritance primitives into one named posture, so a
 * workflow author (or an agentType `.md`) selects `focused` / `isolated` instead
 * of hand-tuning booleans. Modes are macros: a mode expands to a primitive set,
 * and any explicit primitive set alongside the mode overrides just that slot.
 *
 * Primitives — what the session actually enforces, via the SDK resource loader
 * (`DefaultResourceLoader`, wired in agent.ts):
 *   - inheritProjectContext  load project AGENTS.md / context files (→ noContextFiles)
 *   - systemPromptMode        "append": leave the inherited base system prompt intact
 *                             and carry the agentType role prompt as task guidance
 *                             (the default); "replace": install the role prompt AS
 *                             the session base system prompt (→ systemPrompt). NOTE
 *                             replace drops pi's whole base prompt (tools/guidelines),
 *                             so it is reserved for true clean-room agents.
 *   - inheritSkills           load skills into the session (→ noSkills)
 *   - inheritMainRules        load the MAIN-agent append channel (`.pi/APPEND_SYSTEM.md`)
 *                             into the subagent (→ appendSystemPrompt:[] when false).
 *                             This is the OpenCode-style "driver rules don't leak to
 *                             subagents" control. Default OFF for subagents.
 *
 * The DEFAULT mode is `focused`: a subagent inherits the SHARED project context
 * (AGENTS.md) and skills, runs under pi's base prompt + its role-as-task, but does
 * NOT inherit the main agent's rules (the append channel). That keeps subagents
 * un-confused by orchestration-only instructions ("spawn waves of subagents",
 * "use superpowers") that live on the main session. `legacy` restores the exact
 * pre-feature behavior (everything inherited, no resource loader constructed).
 *
 * Precedence (highest first), implemented as ordered layers in resolveContextMode:
 *   runtime explicit field > runtime contextMode
 *     > frontmatter explicit field > frontmatter contextMode
 *       > run-level field > run-level contextMode
 *         > global default (`focused`)
 */

export type SystemPromptMode = "append" | "replace";

/** The resolved set the session enforces. */
export interface ContextPrimitives {
  inheritProjectContext: boolean;
  systemPromptMode: SystemPromptMode;
  inheritSkills: boolean;
  /** Inherit the main-agent append channel (`.pi/APPEND_SYSTEM.md`). Default false. */
  inheritMainRules: boolean;
}

/** A single layer of overrides (a mode name plus any explicit per-field overrides). */
export interface ContextOverrides {
  contextMode?: string;
  inheritProjectContext?: boolean;
  systemPromptMode?: SystemPromptMode;
  inheritSkills?: boolean;
  inheritMainRules?: boolean;
}

/**
 * The default posture (`focused`): shared project context + skills + pi base
 * prompt with role-as-task, but the main agent's rules do NOT leak in.
 */
export const DEFAULT_PRIMITIVES: ContextPrimitives = Object.freeze({
  inheritProjectContext: true,
  systemPromptMode: "append",
  inheritSkills: true,
  inheritMainRules: false,
});

export const DEFAULT_CONTEXT_MODE = "focused";

export type ContextModeRegistry = Readonly<Record<string, ContextPrimitives>>;

/**
 * Built-in named modes. Project-defined modes merge OVER these, except the
 * reserved built-in names, which may not be shadowed.
 *
 *   focused   (default) shared context + skills · base prompt + role-as-task · NO main rules
 *   isolated  clean room: no project context · role replaces prompt · no skills · no main rules
 *   scoped    reviewer:  project context in · role replaces prompt · no skills · no main rules
 *   legacy    pre-feature: everything inherited INCLUDING the main-agent rules (byte-identical)
 *   inherit   alias for `legacy` (back-compat for configs/docs that named it)
 */
export const BUILTIN_CONTEXT_MODES: ContextModeRegistry = Object.freeze({
  focused: Object.freeze({
    inheritProjectContext: true,
    systemPromptMode: "append",
    inheritSkills: true,
    inheritMainRules: false,
  }),
  isolated: Object.freeze({
    inheritProjectContext: false,
    systemPromptMode: "replace",
    inheritSkills: false,
    inheritMainRules: false,
  }),
  scoped: Object.freeze({
    inheritProjectContext: true,
    systemPromptMode: "replace",
    inheritSkills: false,
    inheritMainRules: false,
  }),
  legacy: Object.freeze({
    inheritProjectContext: true,
    systemPromptMode: "append",
    inheritSkills: true,
    inheritMainRules: true,
  }),
  inherit: Object.freeze({
    inheritProjectContext: true,
    systemPromptMode: "append",
    inheritSkills: true,
    inheritMainRules: true,
  }),
});

/** Built-in names a project `contextModes` entry may not shadow. */
export const RESERVED_MODE_NAMES: ReadonlySet<string> = new Set(Object.keys(BUILTIN_CONTEXT_MODES));

/** Type guard for a frontmatter/runtime systemPromptMode value. */
export function isSystemPromptMode(value: unknown): value is SystemPromptMode {
  return value === "append" || value === "replace";
}

export interface ResolveResult {
  primitives: ContextPrimitives;
  /** First unknown mode name encountered (ignored → falls back), surfaced for a warning. */
  unknownMode?: string;
}

/** Apply one override layer on top of a base set. A mode name (if known) resets
 *  all slots to the mode's set; explicit fields then override individual slots. */
function applyLayer(
  base: ContextPrimitives,
  layer: ContextOverrides,
  registry: ContextModeRegistry,
): { primitives: ContextPrimitives; unknownMode?: string } {
  let primitives = base;
  let unknownMode: string | undefined;
  if (layer.contextMode) {
    const found = registry[layer.contextMode];
    if (found) primitives = found;
    else unknownMode = layer.contextMode;
  }
  primitives = {
    inheritProjectContext: layer.inheritProjectContext ?? primitives.inheritProjectContext,
    systemPromptMode: layer.systemPromptMode ?? primitives.systemPromptMode,
    inheritSkills: layer.inheritSkills ?? primitives.inheritSkills,
    inheritMainRules: layer.inheritMainRules ?? primitives.inheritMainRules,
  };
  return { primitives, unknownMode };
}

/**
 * Resolve the final primitive set from a frontmatter layer (agentType `.md`)
 * and a runtime layer (the `agent()` call options), in precedence order. Either
 * layer may be omitted. Single source of truth — every entry point (frontmatter,
 * slash command, code-mode spawn) flows through here.
 */
export function resolveContextMode(
  frontmatter: ContextOverrides | undefined,
  runtime: ContextOverrides | undefined,
  registry: ContextModeRegistry = BUILTIN_CONTEXT_MODES,
): ResolveResult {
  return resolveContextModeLayers([frontmatter, runtime], registry);
}

/**
 * Resolve from an arbitrary ordered list of override layers, lowest precedence
 * first. Used when a run-level default (e.g. a `/cmd --mode` flag) sits beneath
 * the agentType frontmatter and the per-call `agent()` options:
 *   [runLevel, frontmatter, runtime]
 * The two-argument `resolveContextMode` is the common [frontmatter, runtime] case.
 */
export function resolveContextModeLayers(
  layers: ReadonlyArray<ContextOverrides | undefined>,
  registry: ContextModeRegistry = BUILTIN_CONTEXT_MODES,
): ResolveResult {
  let primitives: ContextPrimitives = DEFAULT_PRIMITIVES;
  let unknownMode: string | undefined;
  for (const layer of layers) {
    if (!layer) continue;
    const applied = applyLayer(primitives, layer, registry);
    primitives = applied.primitives;
    if (applied.unknownMode && !unknownMode) unknownMode = applied.unknownMode;
  }
  return { primitives, unknownMode };
}

/**
 * Whether a resolved set requires a custom resource loader. When false (the
 * `legacy` posture: everything inherited), agent.ts constructs NO loader and the
 * session is identical to the pre-feature behavior — the backward-compat gate.
 * The DEFAULT (`focused`) returns true because it must block the main-rules
 * append channel.
 */
export function needsResourceLoader(primitives: ContextPrimitives): boolean {
  return (
    !primitives.inheritProjectContext ||
    !primitives.inheritSkills ||
    !primitives.inheritMainRules ||
    primitives.systemPromptMode === "replace"
  );
}

/** Flags handed to the SDK's DefaultResourceLoader. */
export interface ResourceLoaderFlags {
  noContextFiles: boolean;
  noSkills: boolean;
  systemPrompt: string | undefined;
  /**
   * Append-channel override. `[]` blocks the main-agent rules
   * (`.pi/APPEND_SYSTEM.md`) from leaking into the subagent; `undefined` lets the
   * loader discover them as usual (legacy posture).
   */
  appendSystemPrompt: string[] | undefined;
}

/**
 * Map a resolved set (+ the agentType role prompt) onto the resource-loader
 * options that actually enforce it. Pure and exported so the enforcement mapping
 * is unit-tested directly rather than only through the SDK glue in agent.ts:
 *   - inheritProjectContext:false → noContextFiles (drop AGENTS.md/context files)
 *   - inheritSkills:false         → noSkills
 *   - inheritMainRules:false      → appendSystemPrompt:[] (drop the main-agent append channel)
 *   - systemPromptMode:"replace"  → install the role prompt AS the base system prompt
 *     (only when a non-empty prompt is supplied; the workflow layer omits it from
 *     the task to avoid duplication). "append" leaves systemPrompt undefined.
 */
export function resourceLoaderFlags(
  primitives: ContextPrimitives,
  systemPromptText: string | undefined,
): ResourceLoaderFlags {
  return {
    noContextFiles: !primitives.inheritProjectContext,
    noSkills: !primitives.inheritSkills,
    systemPrompt: primitives.systemPromptMode === "replace" ? systemPromptText?.trim() || undefined : undefined,
    appendSystemPrompt: primitives.inheritMainRules ? undefined : [],
  };
}

/**
 * Merge project-defined modes over the built-ins. Reserved built-in names cannot
 * be shadowed (a project entry reusing one is ignored). Returns a frozen registry
 * ready for resolveContextMode.
 */
export function buildContextModeRegistry(
  projectModes: Record<string, ContextPrimitives> | undefined,
): ContextModeRegistry {
  if (!projectModes) return BUILTIN_CONTEXT_MODES;
  const merged: Record<string, ContextPrimitives> = { ...BUILTIN_CONTEXT_MODES };
  for (const [name, set] of Object.entries(projectModes)) {
    if (RESERVED_MODE_NAMES.has(name)) continue;
    merged[name] = Object.freeze({ ...set });
  }
  return Object.freeze(merged);
}
