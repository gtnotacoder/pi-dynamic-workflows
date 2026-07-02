/**
 * Per-agent git worktree isolation. When an agent requests `isolation: "worktree"`,
 * it runs in a throwaway worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged — the path is surfaced for
 * the caller to inspect. Falls back to a logged no-op when isolation isn't possible.
 */

import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Synchronous precondition probe for worktree isolation: returns true when `cwd` is
 * inside a git repository (so `createWorktree` would ATTEMPT a real worktree add and
 * return `isolated: true` on success), false when it is not a git repo (the
 * guaranteed-fallback path, `isolated: false`). Used to fold the isolation outcome's
 * precondition into the resume identity (see workflow.ts) so a cached result produced
 * under the fallback base (run-level `options.tools` retained) cannot replay after the
 * repo becomes a git repo and isolation actually drops those tools. Best-effort: any
 * git error returns false, matching createWorktree's fallback branch.
 */
export function isGitRepoForWorktree(cwd: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
    });
    return true;
  } catch {
    return false;
  }
}

export interface Worktree {
  /** True when a real worktree was created; false means "ran in the shared tree". */
  isolated: boolean;
  /** cwd the agent should run in (worktree path when isolated, else the base cwd). */
  cwd: string;
  branch?: string;
  /** Repo root the worktree was added to (for teardown). */
  repoRoot?: string;
  /** Why isolation was skipped, when isolated === false. */
  reason?: string;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

/**
 * Create an isolated worktree under `<repoRoot>/.pi/worktrees/<name>` on branch
 * `pi/wf/<name>`. The `name` must be deterministic (derived from runId + call index,
 * never wall-clock) so resume keys stay stable. Returns a no-op Worktree on any failure.
 */
export async function createWorktree(baseCwd: string, name: string): Promise<Worktree> {
  const id = slug(name);
  let repoRoot: string;
  try {
    const { stdout } = await exec("git", ["-C", baseCwd, "rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    return { isolated: false, cwd: baseCwd, reason: "not a git repository" };
  }

  const path = join(repoRoot, ".pi", "worktrees", id);
  const branch = `pi/wf/${id}`;
  try {
    await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"]);
    return { isolated: true, cwd: path, branch, repoRoot };
  } catch (error) {
    return { isolated: false, cwd: baseCwd, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Remove a worktree and its branch. Best-effort; safe to call on a no-op Worktree. */
export async function removeWorktree(wt: Worktree): Promise<void> {
  if (!wt.isolated || !wt.repoRoot) return;
  try {
    await exec("git", ["-C", wt.repoRoot, "worktree", "remove", "--force", wt.cwd]);
  } catch {
    // already gone / locked — fall through
  }
  if (wt.branch) {
    try {
      await exec("git", ["-C", wt.repoRoot, "branch", "-D", wt.branch]);
    } catch {
      // branch already deleted
    }
  }
}
