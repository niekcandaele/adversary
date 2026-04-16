import type { RunState } from "../types/index.js";
import type { Platform } from "../preflight/index.js";
import { formatDuration } from "../utils/slugify.js";

export class PrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrError";
  }
}

export async function createPr(options: {
  state: RunState;
  platform: Platform;
  /** The CLI command to use for PR creation. Accepts "gh", "glab", or a full path to a script. */
  prCli: "gh" | "glab" | (string & {});
  prBody: string;
  /** PR/MR title — provided by LLM summarizer */
  prTitle: string;
  cwd: string;
  timeoutMs: number;
  /** Optional env override for the spawned PR CLI subprocess. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const { state, platform, prCli, prBody, prTitle, cwd, timeoutMs } = options;

  process.stdout.write(`\nCreating draft PR/MR: "${prTitle}"\n`);

  let argv: string[];
  if (platform === "gitlab") {
    argv = [
      prCli, "mr", "create",
      "--draft",
      "--title", prTitle,
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
      "--title", prTitle,
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

/**
 * Find an existing open PR/MR for the given branch.
 * Returns the PR URL if found, or null if none exists.
 */
export async function findExistingPr(
  platform: Platform,
  prCli: "gh" | "glab" | (string & {}),
  branch: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number
): Promise<string | null> {
  let argv: string[];
  if (platform === "gitlab") {
    argv = [prCli, "mr", "list", "--source-branch", branch, "--state", "opened", "--output", "json"];
  } else {
    if (platform === "unknown") {
      process.stderr.write(`  [PR] Platform unknown — falling back to gh for PR lookup\n`);
    }
    argv = [prCli, "pr", "list", "--head", branch, "--state", "open", "--json", "url"];
  }

  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...(env ?? process.env) },
  });

  let stdout = "";
  let timedOut = false;

  const effectiveTimeout = timeoutMs ?? 30000;
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
  }, effectiveTimeout);

  try {
    [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (timedOut || proc.exitCode !== 0) return null;

  try {
    const parsed = JSON.parse(stdout.trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
      // gh returns array of {url: "..."}; glab returns array of {web_url: "..."}
      const first = parsed[0] as Record<string, unknown>;
      const url = (first.url ?? first.web_url ?? null) as string | null;
      return url;
    }
  } catch {
    // If not JSON, try extracting URL from text
    return extractUrl(stdout.trim());
  }

  return null;
}
