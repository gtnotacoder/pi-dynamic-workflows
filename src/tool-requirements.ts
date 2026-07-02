/**
 * Tool availability requirement checking.
 *
 * Repos declare optional tool requirements on descriptors.
 * If requiredTools are missing, we clean-skip (ok: false, degraded: false).
 * If preferredTools are missing, we degrade (ok: true, degraded: true).
 *
 * Semantics mirror engine.min floor checks (clean-skip on required, degrade on preferred).
 */

export interface ToolRequirementResult {
  ok: boolean;
  degraded: boolean;
  reason?: string;
  missingRequired?: string[];
  missingPreferred?: string[];
}

/**
 * Check required and preferred tool availability against currently available tools.
 *
 * If `availableTools` is undefined, we assume all tools are available (no restriction),
 * so absence never spuriously fails.
 */
export function checkToolRequirements(
  availableTools: readonly string[] | undefined,
  requiredTools?: readonly string[],
  preferredTools?: readonly string[],
): ToolRequirementResult {
  if (availableTools === undefined) {
    return { ok: true, degraded: false };
  }

  const availableSet = new Set(availableTools);

  const missingRequired: string[] = [];
  if (requiredTools) {
    for (const tool of requiredTools) {
      if (!availableSet.has(tool)) {
        missingRequired.push(tool);
      }
    }
  }

  if (missingRequired.length > 0) {
    return {
      ok: false,
      degraded: false,
      reason: `Missing required tool(s): ${missingRequired.join(", ")}`,
      missingRequired,
    };
  }

  const missingPreferred: string[] = [];
  if (preferredTools) {
    for (const tool of preferredTools) {
      if (!availableSet.has(tool)) {
        missingPreferred.push(tool);
      }
    }
  }

  if (missingPreferred.length > 0) {
    return {
      ok: true,
      degraded: true,
      reason: `Degraded: missing preferred tool(s): ${missingPreferred.join(", ")}`,
      missingPreferred,
    };
  }

  return { ok: true, degraded: false };
}
