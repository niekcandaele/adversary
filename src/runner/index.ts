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

/**
 * Drain a ReadableStream<Uint8Array> into a UTF-8 string.
 * Registers reader.cancel() on the AbortSignal so in-flight reader.read() calls
 * actually reject/return when abort fires — not just between reads.
 * Returns whatever partial text was collected before the abort.
 */
async function drainStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  // Register abort handler BEFORE the first read so there is no race window.
  const onAbort = () => {
    // reader.cancel() returns a Promise — use .catch to handle both synchronous
    // throws (shouldn't happen per spec, but guard anyway) and async rejections.
    Promise.resolve(reader.cancel()).catch(() => { /* reader may already be closed — ignore */ });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch {
    // reader.cancel() caused the pending read to reject — this is expected when
    // the abort fires mid-read. Swallow the error and return partial content.
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* already released by cancel — ignore */ }
  }
  // Decode all chunks together for correct multi-byte character handling
  const combined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(combined);
}

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

  // Prepend setsid to isolate the child in a new session/process-group.
  // This lets us kill the entire process tree (including grandchildren) via
  // process.kill(-pgid, signal) rather than only the direct child.
  // setsid is available on any Linux host (util-linux).
  const spawnArgv = ["setsid", "--", ...argv];

  const proc = Bun.spawn(spawnArgv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: options.env ? { ...options.env } : { ...process.env },
  });

  let timedOut = false;
  let stdoutText = "";
  let stderrText = "";

  // AbortController to cancel the stream-drain loop when the process is killed.
  const drainAbort = new AbortController();

  // In-place spinner: update the same line with elapsed time.
  // Non-TTY: no spinner, just the start/done lines.
  const spinnerHandle = isTTY
    ? setInterval(() => {
        const elapsed = formatDuration(Date.now() - start);
        process.stdout.write(`\x1b[2K\r  [${label}] running... ${elapsed}`);
      }, SPINNER_INTERVAL_MS)
    : null;

  // Nested handles for the SIGKILL escalation and drainAbort that fire inside the
  // outer timeout callback. We capture them so the finally block can clear them if
  // the outer timeout fires but the process exits quickly (before the 2s SIGKILL
  // grace period). Without this, the SIGKILL fires on a potentially-recycled PGID.
  let sigkillHandle: ReturnType<typeof setTimeout> | undefined;
  let drainAbortHandle: ReturnType<typeof setTimeout> | undefined;

  // Timeout: plain (non-async) callback avoids the race condition where an
  // async setTimeout callback would schedule work after the outer try/finally
  // had already cleared the handle and the process had exited.
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    // Capture pgid once — proc.pid is the session leader created by setsid,
    // so pgid === proc.pid. Guard against 0/undefined to avoid kill(-0, ...).
    const pgid = proc.pid;
    // SIGTERM → SIGKILL timing: 2 s grace period before escalating to hard kill.
    if (pgid && pgid > 0) {
      try {
        process.kill(-pgid, "SIGTERM");
      } catch {
        // Process group may have already exited — ignore.
      }
    }
    // Schedule a hard-kill after 2 s, then abort drain so the await unblocks.
    // The 50ms delay between SIGKILL and drainAbort.abort() gives the kernel
    // time to flush pipe buffers, improving partial output capture quality.
    // Post-kill drain race: 5 s to collect remaining output before giving up.
    sigkillHandle = setTimeout(() => {
      if (pgid && pgid > 0) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Process group may have already exited — ignore.
        }
      }
      drainAbortHandle = setTimeout(() => drainAbort.abort(), 50);
    }, 2000);
  }, timeoutMs);

  try {
    [stdoutText, stderrText] = await Promise.all([
      drainStream(proc.stdout, drainAbort.signal),
      drainStream(proc.stderr, drainAbort.signal),
    ]);
    if (timedOut) {
      // Race proc.exited against a 5 s post-kill timer so we cannot re-hang here.
      // If the timer wins it means the process did not exit after SIGKILL — likely leaked.
      let exitedCleanly = false;
      await Promise.race([
        proc.exited.then(() => { exitedCleanly = true; }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (!exitedCleanly && proc.exitCode === null) {
        process.stderr.write(`  [${label}] WARNING: process did not exit within 5s after SIGKILL — may be leaked\n`);
      }
    } else {
      await proc.exited;
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (sigkillHandle) clearTimeout(sigkillHandle);
    if (drainAbortHandle) clearTimeout(drainAbortHandle);
    if (spinnerHandle) clearInterval(spinnerHandle);
    // Ensure the abort fires even on normal exit paths (no-op if already aborted).
    drainAbort.abort();
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
