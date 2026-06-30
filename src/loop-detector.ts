/**
 * @fileoverview Workflow-level loop / no-progress detector.
 *
 * Adapted from open-multi-agent's `agent/loop-detector.ts` (per-agent repeated
 * tool-call detection), generalized to plain string signatures and wired to the
 * workflow engine's per-call identity. Detects when a script issues the *same*
 * `agent()` call over and over — a runaway `while` / `loopUntilDry` that silently
 * burns the token budget and the agent counter without making progress.
 *
 * Dependency-free and deterministic: `record()` spends no tokens and mutates no
 * resume state, so it is safe to call on every `agent()` turn (including cached
 * resume replays). The default action is WARN-only, so legitimate
 * identical-prompt fan-out (e.g. `verify`/`judgePanel` reviewers) is never killed.
 */

export type LoopGuardAction = "warn" | "abort";

export interface LoopGuardOptions {
  /** Sliding window of most-recent signatures inspected. Default 12. */
  readonly window?: number;
  /** Times one signature may appear within the window before it counts as a loop. Default 5. */
  readonly maxRepeats?: number;
  /** Identical signatures in a row that count as a loop (tighter trigger). Default 4. */
  readonly maxConsecutive?: number;
  /** What to do on detection. "warn" logs only; "abort" throws. Default "warn". */
  readonly action?: LoopGuardAction;
}

export interface LoopVerdict {
  readonly looping: boolean;
  readonly signature?: string;
  /** Occurrences of `signature` within the current window (when looping). */
  readonly count?: number;
  /** Trailing consecutive run length of `signature` (when looping). */
  readonly consecutive?: number;
  readonly reason?: string;
}

const NOT_LOOPING: LoopVerdict = { looping: false };

export const DEFAULT_LOOP_GUARD = {
  window: 12,
  maxRepeats: 5,
  maxConsecutive: 4,
  action: "warn" as LoopGuardAction,
} as const;

/**
 * Sliding-window detector for repeated signatures. One instance per workflow run
 * (a nested `workflow()` gets its own). Not concurrency-sensitive: Node is
 * single-threaded and `record()` runs synchronously at the top of `agent()`.
 */
export class LoopDetector {
  private readonly window: number;
  private readonly maxRepeats: number;
  private readonly maxConsecutive: number;
  /** Configured action on detection; the caller decides whether to warn or throw. */
  readonly action: LoopGuardAction;
  private readonly recent: string[] = [];

  constructor(options: LoopGuardOptions = {}) {
    this.window = Math.max(2, Math.floor(options.window ?? DEFAULT_LOOP_GUARD.window));
    this.maxRepeats = Math.max(2, Math.floor(options.maxRepeats ?? DEFAULT_LOOP_GUARD.maxRepeats));
    this.maxConsecutive = Math.max(2, Math.floor(options.maxConsecutive ?? DEFAULT_LOOP_GUARD.maxConsecutive));
    this.action = options.action ?? DEFAULT_LOOP_GUARD.action;
  }

  /** Record one signature and report whether the recent window looks like a loop. */
  record(signature: string): LoopVerdict {
    this.recent.push(signature);
    if (this.recent.length > this.window) this.recent.shift();

    // Trailing consecutive run of the just-recorded signature.
    let consecutive = 0;
    for (let i = this.recent.length - 1; i >= 0 && this.recent[i] === signature; i--) consecutive++;

    // Total occurrences within the current window.
    let count = 0;
    for (const s of this.recent) if (s === signature) count++;

    if (consecutive >= this.maxConsecutive) {
      return {
        looping: true,
        signature,
        count,
        consecutive,
        reason: `${consecutive} identical calls in a row`,
      };
    }
    if (count >= this.maxRepeats) {
      return {
        looping: true,
        signature,
        count,
        consecutive,
        reason: `${count} identical calls within the last ${this.recent.length}`,
      };
    }
    return NOT_LOOPING;
  }

  /** Forget all recorded signatures (e.g. when entering a deliberately repetitive phase). */
  reset(): void {
    this.recent.length = 0;
  }

  /** Number of signatures currently retained in the window. */
  get size(): number {
    return this.recent.length;
  }
}
