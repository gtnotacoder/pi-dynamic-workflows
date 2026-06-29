import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

export type WorkflowCompactionPolicyName = "auto" | "default" | "aggressive-local" | "cache-preserving" | "off";
export type WorkflowCompactionCacheValue = "none" | "low" | "normal" | "high";

export interface WorkflowCompactionSettingsOverride {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface WorkflowCompactionPolicyDecision {
  policy: Exclude<WorkflowCompactionPolicyName, "auto">;
  cacheValue: WorkflowCompactionCacheValue;
  reason: string;
  settings?: WorkflowCompactionSettingsOverride;
}

export interface WorkflowCompactionPolicyInput {
  requested?: WorkflowCompactionPolicyName | null;
  modelSpec?: string;
  model?: Partial<Pick<Model<any>, "provider" | "id" | "contextWindow">>;
  contextWindow?: number;
}

const AGGRESSIVE_LOCAL_RESERVE_FRACTION = 0.35;
const AGGRESSIVE_LOCAL_KEEP_RECENT_FRACTION = 0.12;
const AGGRESSIVE_LOCAL_FALLBACK_RESERVE = 4_000;
const AGGRESSIVE_LOCAL_FALLBACK_KEEP_RECENT = 4_000;
const MIN_AGGRESSIVE_KEEP_RECENT = 4_000;
const MAX_AGGRESSIVE_KEEP_RECENT = 12_000;

/**
 * Resolve the workflow subagent compaction posture.
 *
 * The Pi SDK compacts when `contextTokens > contextWindow - reserveTokens`.
 * For local/no-cache workers, raising the reserve to ~35% makes compaction
 * proactive around 60-70% occupancy instead of near the end of the window.
 */
export function resolveWorkflowCompactionPolicy(
  input: WorkflowCompactionPolicyInput,
): WorkflowCompactionPolicyDecision {
  const requested = input.requested ?? "auto";
  if (requested === "off") {
    return {
      policy: "off",
      cacheValue: "none",
      reason: "explicit off",
      settings: { ...DEFAULT_COMPACTION_SETTINGS, enabled: false },
    };
  }
  if (requested === "default") {
    return { policy: "default", cacheValue: "normal", reason: "explicit default" };
  }
  if (requested === "cache-preserving") {
    return {
      policy: "cache-preserving",
      cacheValue: "high",
      reason: "explicit cache-preserving",
      settings: { ...DEFAULT_COMPACTION_SETTINGS },
    };
  }
  if (requested === "aggressive-local" || isLocalNoCacheModel(input)) {
    const contextWindow = positiveInteger(input.contextWindow ?? input.model?.contextWindow);
    return {
      policy: "aggressive-local",
      cacheValue: "none",
      reason: requested === "aggressive-local" ? "explicit aggressive-local" : "local/no-cache model",
      settings: aggressiveLocalSettings(contextWindow),
    };
  }

  return { policy: "default", cacheValue: "normal", reason: "auto default" };
}

function aggressiveLocalSettings(contextWindow: number | undefined): WorkflowCompactionSettingsOverride {
  if (!contextWindow) {
    return {
      enabled: true,
      reserveTokens: AGGRESSIVE_LOCAL_FALLBACK_RESERVE,
      keepRecentTokens: AGGRESSIVE_LOCAL_FALLBACK_KEEP_RECENT,
    };
  }

  const reserveTokens = clamp(
    Math.floor(contextWindow * AGGRESSIVE_LOCAL_RESERVE_FRACTION),
    1,
    Math.max(1, contextWindow - 1),
  );
  const keepRecentMax = Math.min(MAX_AGGRESSIVE_KEEP_RECENT, Math.max(1, contextWindow - reserveTokens - 1));
  const keepRecentTokens = clamp(
    Math.floor(contextWindow * AGGRESSIVE_LOCAL_KEEP_RECENT_FRACTION),
    Math.min(MIN_AGGRESSIVE_KEEP_RECENT, keepRecentMax),
    keepRecentMax,
  );

  return { enabled: true, reserveTokens, keepRecentTokens };
}

function isLocalNoCacheModel(input: WorkflowCompactionPolicyInput): boolean {
  const resolvedId = [input.model?.provider, input.model?.id].filter(Boolean).join("/");
  const id = (resolvedId || input.modelSpec || "").toLowerCase();
  return /(^|\/)local[-_/]/.test(id) || /(^|\/)(ollama|lmstudio|llama\.cpp|vllm|kobold)(\/|$)/.test(id);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
