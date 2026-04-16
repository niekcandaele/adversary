import { join } from "node:path";
import { writeText, ensureDir } from "../utils/fs.js";
import { formatDuration } from "../utils/slugify.js";
import type { StepResult } from "../types/index.js";

export class StepTimeoutError extends Error {
  constructor(command: string, ms: number) {
    super(`Command timed out after ${formatDuration(ms)}: ${command}`);
    this.name = "StepTimeoutError";
  }
}

/**
 * Parse a shell command string into argv array.
 * Handles single-quoted, double-quoted and unquoted tokens.
 */
export function parseCommand(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
    i++;
  }
  if (current.length > 0) args.push(current);
  return args;
}

const SPINNER_INTERVAL_MS = 500;

export async function runStep(options: {
  command: string;
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  label: string;
  /** Optional env override for the spawned process. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * If provided, used directly as the argv array instead of parsing `command`.
   * Use this when the command contains shell metacharacters (&&, |, ;, etc.)
   * and you want to spawn via ["sh", "-c", cmd] without going through parseCommand.
   */
  rawArgv?: string[];
}): Promise<StepResult> {
  const { command, cwd, stdoutPath, stderrPath, timeoutMs, label } = options;

  await ensureDir(join(stdoutPath, ".."));

  const argv = options.rawArgv ?? parseCommand(command);
  const start = Date.now();

  const isTTY = process.stdout.isTTY ?? false;

  if (!isTTY) {
    process.stdout.write(`  [${label}] started\n`);
  }

  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: options.env ? { ...options.env } : { ...process.env },
  });

  let timedOut = false;
  let stdoutText = "";
  let stderrText = "";

  // In-place spinner: update the same line with elapsed time.
  // Non-TTY: no spinner, just the start/done lines.
  const spinnerHandle = isTTY
    ? setInterval(() => {
        const elapsed = formatDuration(Date.now() - start);
        process.stdout.write(`\x1b[2K\r  [${label}] running... ${elapsed}`);
      }, SPINNER_INTERVAL_MS)
    : null;

  // Timeout: plain (non-async) callback avoids the race condition where an
  // async setTimeout callback would schedule work after the outer try/finally
  // had already cleared the handle and the process had exited.
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    // Schedule a hard-kill after 2 s. No async/await inside setTimeout.
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have already exited — ignore.
      }
    }, 2000);
  }, timeoutMs);

  try {
    [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
    if (spinnerHandle) clearInterval(spinnerHandle);
  }

  const durationMs = Date.now() - start;
  const exitCode = timedOut ? 124 : (proc.exitCode ?? 1);

  // Write logs
  await writeText(stdoutPath, stdoutText);
  await writeText(stderrPath, stderrText);

  // Clear spinner line and print final status
  if (isTTY) {
    process.stdout.write(`\x1b[2K\r`);
  }

  if (timedOut) {
    process.stdout.write(
      `  [${label}] TIMED OUT after ${formatDuration(durationMs)} (limit: ${formatDuration(timeoutMs)})\n`
    );
  } else {
    process.stdout.write(
      `  [${label}] done in ${formatDuration(durationMs)}\n`
    );
  }

  return {
    exitCode,
    durationMs,
    stdoutPath,
    stderrPath,
    success: !timedOut && exitCode === 0,
    timedOut,
  };
}
