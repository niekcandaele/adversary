import type { RunState } from "../types/index.js";
import type { Platform } from "../preflight/index.js";
import { formatDuration } from "../utils/slugify.js";

export class PrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrError";
  }
}

export function buildPrTitle(planTitle: string): string {
  return `adversary: ${planTitle}`;
}

export async function createPr(options: {
  state: RunState;
  platform: Platform;
  /** The CLI command to use for PR creation. Accepts "gh", "glab", or a full path to a script. */
  prCli: "gh" | "glab" | (string & {});
  prBody: string;
  cwd: string;
  timeoutMs: number;
  /** Optional env override for the spawned PR CLI subprocess. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const { state, platform, prCli, prBody, cwd, timeoutMs } = options;
  const title = buildPrTitle(state.planTitle);

  process.stdout.write(`\nCreating draft PR/MR: "${title}"\n`);

  let argv: string[];
  if (platform === "gitlab") {
    argv = [
      prCli, "mr", "create",
      "--draft",
      "--title", title,
      "--description", prBody,
      "--source-branch", state.branch,
      "--target-branch", state.baseBranch,
      "--yes", // don't prompt for confirmation
    ];
  } else {
    // github (or unknown — default to gh interface)
    argv = [
      prCli, "pr", "create",
      "--draft",
      "--title", title,
      "--body", prBody,
      "--head", state.branch,
      "--base", state.baseBranch,
    ];
  }

  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...(options.env ?? process.env) },
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    // Schedule a hard-kill after 2s grace period in case SIGTERM is ignored.
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have already exited — ignore.
      }
    }, 2000);
  }, timeoutMs);

  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (timedOut) {
    throw new PrError(`PR/MR creation timed out after ${formatDuration(timeoutMs)}`);
  }

  const exitCode = proc.exitCode ?? 1;
  if (exitCode !== 0) {
    throw new PrError(`PR/MR creation failed (exit ${exitCode}): ${stderr || stdout}`);
  }

  // Extract PR URL from stdout
  const url = extractUrl(stdout.trim()) || stdout.trim();
  process.stdout.write(`  PR/MR created: ${url}\n`);
  return url;
}

export function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}
