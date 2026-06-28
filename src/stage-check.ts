import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface StageCheckCommand {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number | null;
}

export interface StageCheckCommandResult {
  name: string;
  command: string;
  args: string[];
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  summary: string;
}

export interface StageCheckResult {
  ok: boolean;
  targetFile?: string;
  checks: StageCheckCommandResult[];
  summary: string;
}

export type StageCheckRunner = (
  command: StageCheckCommand,
  options: { cwd: string; timeoutMs: number | null; maxOutputChars: number; signal?: AbortSignal },
) => Promise<StageCheckCommandResult>;

export interface StageCheckOptions {
  cwd?: string;
  targetFile?: string;
  commands?: StageCheckCommand[];
  timeoutMs?: number | null;
  maxOutputChars?: number;
  includeDefaultChecks?: boolean;
  signal?: AbortSignal;
  runner?: StageCheckRunner;
}

const DEFAULT_STAGE_CHECK_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;

/**
 * Host-side mechanical verification. Runs native compiler/linter commands without
 * spending an LLM verifier call. By default it detects TypeScript and Biome.
 */
export async function runStageCheck(options: StageCheckOptions = {}): Promise<StageCheckResult> {
  const cwd = options.cwd ?? process.cwd();
  const maxOutputChars = Math.max(1_000, options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_STAGE_CHECK_TIMEOUT_MS : options.timeoutMs;
  const commands =
    options.commands ??
    (options.includeDefaultChecks === false ? [] : detectDefaultStageCheckCommands(cwd, options.targetFile));
  const runner = options.runner ?? runCommand;
  const checks: StageCheckCommandResult[] = [];

  for (const command of commands) {
    if (options.signal?.aborted) throw new Error("stageCheck aborted");
    checks.push(
      await runner(command, {
        cwd: command.cwd ?? cwd,
        timeoutMs: command.timeoutMs === undefined ? timeoutMs : command.timeoutMs,
        maxOutputChars,
        signal: options.signal,
      }),
    );
  }

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    targetFile: options.targetFile,
    checks,
    summary:
      checks.length === 0
        ? "No host-side stage checks detected."
        : failed.length === 0
          ? `Stage checks passed (${checks.map((check) => check.name).join(", ")}).`
          : `Stage checks failed (${failed.map((check) => check.name).join(", ")}).`,
  };
}

export function detectDefaultStageCheckCommands(cwd: string, targetFile?: string): StageCheckCommand[] {
  const commands: StageCheckCommand[] = [];
  const hasPackage = existsSync(join(cwd, "package.json"));
  if (hasPackage && existsSync(join(cwd, "tsconfig.json"))) {
    commands.push({ name: "typescript", command: "npm", args: ["exec", "--", "tsc", "--noEmit"] });
  }
  if (hasPackage && existsSync(join(cwd, "biome.json"))) {
    commands.push({ name: "biome", command: "npm", args: ["exec", "--", "biome", "check", targetFile || "."] });
  }
  return commands;
}

export function renderStageCheckFeedback(result: StageCheckResult): string {
  const payload = {
    ok: result.ok,
    targetFile: result.targetFile,
    summary: result.summary,
    failedChecks: result.checks
      .filter((check) => !check.ok)
      .map((check) => ({
        name: check.name,
        command: [check.command, ...check.args].join(" "),
        exitCode: check.exitCode,
        timedOut: check.timedOut,
        summary: check.summary,
        stderr: compactOutput(check.stderr, 2_000),
        stdout: compactOutput(check.stdout, 2_000),
      })),
  };
  return JSON.stringify(payload, null, 2);
}

async function runCommand(
  command: StageCheckCommand,
  options: { cwd: string; timeoutMs: number | null; maxOutputChars: number; signal?: AbortSignal },
): Promise<StageCheckCommandResult> {
  const args = command.args ?? [];
  const started = Date.now();
  const controller = new AbortController();
  const removeParentAbort = linkAbortSignal(options.signal, controller);
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  if (options.timeoutMs !== null) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
  }

  return await new Promise<StageCheckCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
        shell: false,
      });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = compactOutput(stdout + chunk, options.maxOutputChars);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = compactOutput(stderr + chunk, options.maxOutputChars);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (timedOut || error.name === "AbortError") return;
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      cleanup();
      const ok = exitCode === 0 && !timedOut;
      resolve({
        name: command.name,
        command: command.command,
        args,
        ok,
        exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        stdout,
        stderr,
        summary: summarizeCommand(command, ok, exitCode, signal, timedOut, stderr || stdout),
      });
    });
  });

  function cleanup() {
    if (timeout) clearTimeout(timeout);
    removeParentAbort();
  }
}

function summarizeCommand(
  command: StageCheckCommand,
  ok: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  output: string,
): string {
  const commandText = [command.command, ...(command.args ?? [])].join(" ");
  if (ok) return `${command.name} passed: ${commandText}`;
  const reason = timedOut ? "timed out" : signal ? `terminated by ${signal}` : `exit ${exitCode ?? "unknown"}`;
  const firstLine = output
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return `${command.name} failed (${reason}): ${commandText}${firstLine ? ` — ${firstLine}` : ""}`;
}

function compactOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.45);
  const tail = Math.floor(maxChars * 0.45);
  return `${value.slice(0, head)}\n… <truncated ${value.length - head - tail} chars> …\n${value.slice(value.length - tail)}`;
}

function linkAbortSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => {};
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}
