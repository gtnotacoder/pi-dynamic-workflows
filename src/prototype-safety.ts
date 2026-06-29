import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PrototypeSafetyOptions {
  /** Require the run to happen from a linked git worktree instead of the primary checkout. Default true. */
  worktreeRequired?: boolean;
  /** Permit the primary/shared checkout even when worktreeRequired is true. Default false. */
  allowSharedCheckout?: boolean;
  /** Require a clean worktree before prototype execution. Default true. */
  requireClean?: boolean;
  /** Permit existing dirty files even when requireClean is true. Default false. */
  allowDirty?: boolean;
}

export interface PrototypeSafetyResult {
  ok: boolean;
  cwd: string;
  gitRoot?: string;
  primaryWorktree?: string;
  isLinkedWorktree?: boolean;
  dirtyPaths: string[];
  reason: string;
  nextAction: string;
}

const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER, shell: false });
  return stdout.replace(/\r?\n+$/, "");
}

function parsePrimaryWorktree(output: string): string | undefined {
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) return line.slice("worktree ".length).trim() || undefined;
  }
  return undefined;
}

function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line || line.length < 4) continue;
    const rawPath = line.slice(3);
    const arrow = rawPath.indexOf(" -> ");
    if (arrow >= 0) {
      paths.push(rawPath.slice(0, arrow), rawPath.slice(arrow + 4));
    } else {
      paths.push(rawPath);
    }
  }
  return paths.map((path) => (path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path));
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && resolve(a) === resolve(b);
}

export async function checkPrototypeWorktreeSafety(
  cwd: string,
  options: PrototypeSafetyOptions = {},
): Promise<PrototypeSafetyResult> {
  const worktreeRequired = options.worktreeRequired ?? true;
  const allowSharedCheckout = options.allowSharedCheckout ?? false;
  const requireClean = options.requireClean ?? true;
  const allowDirty = options.allowDirty ?? false;

  let gitRoot: string;
  try {
    gitRoot = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    return {
      ok: false,
      cwd,
      dirtyPaths: [],
      reason: `Not a git worktree: ${error instanceof Error ? error.message : String(error)}`,
      nextAction:
        "Run prototype mode from a git worktree, or disable worktreeRequired only for a deliberate read-only dry run.",
    };
  }

  let primaryWorktree: string | undefined;
  try {
    primaryWorktree = parsePrimaryWorktree(await git(cwd, ["worktree", "list", "--porcelain"]));
  } catch {
    primaryWorktree = gitRoot;
  }
  const isLinkedWorktree = primaryWorktree === undefined ? undefined : !samePath(gitRoot, primaryWorktree);

  let dirtyPaths: string[] = [];
  try {
    dirtyPaths = parsePorcelainPaths(await git(cwd, ["status", "--porcelain"]));
  } catch {
    dirtyPaths = [];
  }

  if (worktreeRequired && !allowSharedCheckout && isLinkedWorktree !== true) {
    return {
      ok: false,
      cwd,
      gitRoot,
      primaryWorktree,
      isLinkedWorktree,
      dirtyPaths,
      reason:
        "Prototype mode requires an isolated linked git worktree; this appears to be the primary/shared checkout.",
      nextAction:
        "Create a linked worktree (git worktree add ...) and rerun, or pass worktreeRequired=false/allowSharedCheckout=true deliberately.",
    };
  }

  if (requireClean && !allowDirty && dirtyPaths.length > 0) {
    return {
      ok: false,
      cwd,
      gitRoot,
      primaryWorktree,
      isLinkedWorktree,
      dirtyPaths,
      reason: `Prototype mode requires a clean starting worktree; found ${dirtyPaths.length} dirty path(s).`,
      nextAction: "Commit, stash, or discard existing changes before rerunning, or pass allowDirty=true deliberately.",
    };
  }

  return {
    ok: true,
    cwd,
    gitRoot,
    primaryWorktree,
    isLinkedWorktree,
    dirtyPaths,
    reason: isLinkedWorktree
      ? "Running in an isolated linked worktree."
      : "Shared checkout allowed by explicit override.",
    nextAction: "Proceed with bounded prototype execution.",
  };
}
