/**
 * Context modes — named per-subagent governance presets.
 *
 * A context mode bundles three orthogonal inheritance primitives into one named
 * posture, so a workflow author (or an agentType `.md`) selects `isolated`
 * instead of hand-tuning three booleans. Modes are macros: a mode expands to a
 * primitive triple, and any explicit primitive set alongside the mode overrides
 * just that slot.
 *
 * Primitives — what the session actually enforces, via the SDK resource loader
 * (`DefaultResourceLoader`, wired in agent.ts):
 *   - inheritProjectContext  load project AGENTS.md / context files (→ noContextFiles)
 *   - systemPromptMode        "append": leave the inherited base system prompt intact
 *                             and carry the agentType role prompt as task guidance
 *                             (the current behavior); "replace": install the role
 *                             prompt AS the session system prompt (→ systemPrompt)
 *   - inheritSkills           load skills into the session (→ noSkills)
 *
 * Precedence (highest first), implemented as ordered layers in resolveContextMode:
 *   runtime explicit field > runtime contextMode
 *     > frontmatter explicit field > frontmatter contextMode
 *       > global default (`inherit`)
 *
 * The DEFAULT mode `inherit` expands to exactly today's behavior, so a config
 * that sets none of these fields produces a byte-identical session (no resource
 * loader is constructed — see needsResourceLoader).
 */

export type SystemPromptMode = "append" | "replace";

/** The resolved triple the session enforces. */
export interface ContextPrimitives {
  inheritProjectContext: boolean;
  systemPromptMode: SystemPromptMode;
  inheritSkills: boolean;
}

/** A single layer of overrides (a mode name plus any explicit per-field overrides). */
export interface ContextOverrides {
  contextMode?: string;
  inheritProjectContext?: boolean;
  systemPromptMode?: SystemPromptMode;
  inheritSkills?: boolean;
}

/** Backward-compatible default == today's behavior. `inherit` expands to this. */
export const DEFAULT_PRIMITIVES: ContextPrimitives = Object.freeze({
  inheritProjectContext: true,
  systemPromptMode: "append",
  inheritSkills: true,
});

export const DEFAULT_CONTEXT_MODE = "inherit";

export type ContextModeRegistry = Readonly<Record<string, ContextPrimitives>>;

/**
 * Built-in named modes. Project-defined modes merge OVER these, except `inherit`,
 * which is reserved as the backward-compatible default and may not be shadowed.
 *
 *   inherit   project context in · base prompt + role-as-task · skills in   (status quo)
 *   isolated  clean room: no project context · role replaces prompt · no skills
 *   scoped    project facts in · role replaces prompt · no skills           (reviewer posture)
 */
export const BUILTIN_CONTEXT_MODES: ContextModeRegistry = Object.freeze({
  inherit: Object.freeze({ inheritProjectContext: true, systemPromptMode: "append", inheritSkills: true }),
  isolated: Object.freeze({ inheritProjectContext: false, systemPromptMode: "replace", inheritSkills: false }),
  scoped: Object.freeze({ inheritProjectContext: true, systemPromptMode: "replace", inheritSkills: false }),
});

/** Type guard for a frontmatter/runtime systemPromptMode value. */
export function isSystemPromptMode(value: unknown): value is SystemPromptMode {
  return value === "append" || value === "replace";
}

export interface ResolveResult {
  primitives: ContextPrimitives;
  /** First unknown mode name encountered (ignored → falls back), surfaced for a warning. */
  unknownMode?: string;
}

/** Apply one override layer on top of a base triple. A mode name (if known) resets
 *  all three to the mode's triple; explicit fields then override individual slots. */
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
  };
  return { primitives, unknownMode };
}

/**
 * Resolve the final primitive triple from a frontmatter layer (agentType `.md`)
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
 * Whether a resolved triple requires a custom resource loader. When false (the
 * `inherit` default), agent.ts constructs NO loader and the session is identical
 * to today's — this is the backward-compatibility gate.
 */
export function needsResourceLoader(primitives: ContextPrimitives): boolean {
  return !primitives.inheritProjectContext || !primitives.inheritSkills || primitives.systemPromptMode === "replace";
}

/** Flags handed to the SDK's DefaultResourceLoader. */
export interface ResourceLoaderFlags {
  noContextFiles: boolean;
  noSkills: boolean;
  systemPrompt: string | undefined;
}

/**
 * Map a resolved triple (+ the agentType role prompt) onto the resource-loader
 * options that actually enforce it. Pure and exported so the enforcement mapping
 * is unit-tested directly rather than only through the SDK glue in agent.ts:
 *   - inheritProjectContext:false → noContextFiles (drop AGENTS.md/context files)
 *   - inheritSkills:false         → noSkills
 *   - systemPromptMode:"replace"  → install the role prompt AS the system prompt
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
  };
}

/**
 * Merge project-defined modes over the built-ins. `inherit` is reserved and
 * cannot be shadowed (a project entry named `inherit` is ignored). Returns a
 * frozen registry ready for resolveContextMode.
 */
export function buildContextModeRegistry(
  projectModes: Record<string, ContextPrimitives> | undefined,
): ContextModeRegistry {
  if (!projectModes) return BUILTIN_CONTEXT_MODES;
  const merged: Record<string, ContextPrimitives> = { ...BUILTIN_CONTEXT_MODES };
  for (const [name, triple] of Object.entries(projectModes)) {
    if (name === DEFAULT_CONTEXT_MODE) continue;
    merged[name] = Object.freeze({ ...triple });
  }
  return Object.freeze(merged);
}
