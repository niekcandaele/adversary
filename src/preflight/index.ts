import { isGitRepo, isCleanWorkingTree, getRemoteUrl } from "../git/index.js";
import { fileExists } from "../utils/fs.js";
import type { BrowserAutomationMode, ToolchainDiscovery } from "../types/index.js";

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

async function commandExists(cmd: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const proc = Bun.spawn(["which", cmd], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? process.env,
  });
  const code = await proc.exited;
  return code === 0;
}

export type Platform = "github" | "gitlab" | "unknown";

export function detectPlatform(remoteUrl: string | null): Platform {
  if (!remoteUrl) return "unknown";
  if (remoteUrl.includes("github.com")) return "github";
  if (remoteUrl.includes("gitlab.com") || remoteUrl.includes("gitlab.")) return "gitlab";
  return "unknown";
}

async function checkGhAuth(env?: NodeJS.ProcessEnv): Promise<boolean> {
  const proc = Bun.spawn(["gh", "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? process.env,
  });
  const code = await proc.exited;
  return code === 0;
}

async function checkGlabAuth(env?: NodeJS.ProcessEnv): Promise<boolean> {
  const proc = Bun.spawn(["glab", "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? process.env,
  });
  const code = await proc.exited;
  return code === 0;
}

/**
 * Extract the harness binary name from a command template.
 * Takes the first word (token) from the template before any spaces or flags.
 */
export function extractHarnessBinary(commandTemplate: string): string {
  const trimmed = commandTemplate.trim();
  const firstSpace = trimmed.indexOf(" ");
  return firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
}

/**
 * Check that setsid (util-linux) is available in PATH.
 * setsid is required so the runner can spawn processes in a new session and
 * kill the entire process group on timeout via process.kill(-pgid, signal).
 *
 * Exported for unit testing.
 */
export async function checkSetsid(env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; reason?: string }> {
  if (await commandExists("setsid", env)) return { ok: true };
  return {
    ok: false,
    reason:
      "setsid (util-linux) is required but not found in PATH.\n" +
      "  - macOS:         brew install util-linux\n" +
      "  - Debian/Ubuntu: apt-get install util-linux\n" +
      "  - Alpine:        apk add util-linux\n" +
      "  - RHEL/Fedora:   dnf install util-linux",
  };
}

/**
 * Check that all harness binaries used in command templates are in PATH.
 * Exported for unit testing.
 */
export async function checkHarnessBinaries(
  templates: string[],
  env?: NodeJS.ProcessEnv
): Promise<{ ok: boolean; reason?: string }> {
  const binaries = new Set(templates.map(extractHarnessBinary).filter((b) => b.length > 0));

  for (const binary of binaries) {
    if (!(await commandExists(binary, env))) {
      return {
        ok: false,
        reason: `Harness binary "${binary}" is not available in PATH. Install it or update your command template.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Check browser automation availability based on mode and discovery.
 * Only meaningful when called after discovery — call on turn 1 only.
 */
export async function checkBrowserAutomation(
  mode: BrowserAutomationMode,
  discovery: ToolchainDiscovery
): Promise<void> {
  if (mode === "skip") return;

  const hasBrowserDeps = discovery.browserDeps.length > 0;
  if (hasBrowserDeps) return;

  const message =
    "No browser automation dependencies found (Playwright/Puppeteer/Cypress). " +
    "UX reviewer and exerciser will operate without browser automation.\n";

  if (mode === "warn") {
    process.stderr.write(`  Warning: ${message}`);
    process.stderr.write("  [preflight] Continuing without browser automation.\n");
    return;
  }

  if (mode === "require") {
    throw new PreflightError(
      `Browser automation is required (browserAutomation: "require") but no browser dependencies found. ` +
        `Install playwright, puppeteer, or cypress, or set browserAutomation to "warn" or "skip".`
    );
  }
}

export interface PreflightResult {
  cwd: string;
  platform: Platform;
  remoteUrl: string | null;
  prCli: "gh" | "glab";
}

export async function runPreflight(
  cwd: string,
  planFile: string,
  config: import("../types/index.js").AdversaryConfig,
  env?: NodeJS.ProcessEnv,
  options?: { resumeMode?: boolean }
): Promise<PreflightResult> {
  // 1. Must be inside a git repo
  if (!(await isGitRepo(cwd))) {
    throw new PreflightError(`Not inside a git repository: ${cwd}`);
  }

  // 2. Clean working tree (skipped in resume mode — resume handles dirty trees explicitly)
  if (!options?.resumeMode) {
    const cleanResult = await isCleanWorkingTree(cwd);
    if (!cleanResult.clean) {
      throw new PreflightError(cleanResult.reason!);
    }
  }

  // 3. Plan file readable and non-empty
  if (!fileExists(planFile)) {
    throw new PreflightError(`Plan file not found: ${planFile}`);
  }
  const planContent = await Bun.file(planFile).text();
  if (planContent.trim().length === 0) {
    throw new PreflightError(`Plan file is empty: ${planFile}`);
  }

  // 4. Required commands — git must always be present
  if (!(await commandExists("git", env))) {
    throw new PreflightError("git is not available in PATH.");
  }

  // 4a. setsid is required for process-group kill on timeout
  const setsidCheck = await checkSetsid(env);
  if (!setsidCheck.ok) {
    throw new PreflightError(setsidCheck.reason!);
  }

  // 5. Check harness binaries from command templates
  const harnessBinariesCheck = await checkHarnessBinaries(
    [
      config.implementCommandTemplate,
      config.verifyCommandTemplate,
      config.summarizerCommandTemplate,
    ],
    env
  );
  if (!harnessBinariesCheck.ok) {
    throw new PreflightError(harnessBinariesCheck.reason!);
  }

  // 6. Remote detection
  const remoteUrl = await getRemoteUrl(cwd);

  // 7. Platform detection
  const platform = detectPlatform(remoteUrl);

  // 8. PR CLI check
  let prCli: "gh" | "glab" = "gh";
  if (platform === "gitlab") {
    if (!(await commandExists("glab", env))) {
      throw new PreflightError("glab is required for GitLab repositories but is not in PATH.");
    }
    if (!(await checkGlabAuth(env))) {
      throw new PreflightError("glab auth check failed. Run 'glab auth login' to authenticate.");
    }
    prCli = "glab";
  } else if (platform === "github") {
    if (!(await commandExists("gh", env))) {
      throw new PreflightError("gh (GitHub CLI) is required but is not in PATH.");
    }
    if (!(await checkGhAuth(env))) {
      throw new PreflightError("gh auth check failed. Run 'gh auth login' to authenticate.");
    }
    prCli = "gh";
  } else {
    // platform === "unknown" — remote URL doesn't match github.com or gitlab.
    // Default to gh with a clear message if it's missing or not authenticated.
    if (!(await commandExists("gh", env))) {
      throw new PreflightError(
        "Platform could not be detected from remote URL (not github.com or gitlab.*).\n" +
          "Falling back to gh (GitHub CLI), but it is not in PATH.\n" +
          "Install gh (https://cli.github.com) or ensure your remote URL contains 'github.com' / 'gitlab.'"
      );
    }
    if (!(await checkGhAuth(env))) {
      throw new PreflightError(
        "Platform could not be detected from remote URL (not github.com or gitlab.*).\n" +
          "Tried gh auth status but it failed — run 'gh auth login' to authenticate.\n" +
          "If this is a GitLab repo, ensure the remote URL contains 'gitlab.com' or 'gitlab.'."
      );
    }
    prCli = "gh";
  }

  return {
    cwd,
    platform,
    remoteUrl,
    prCli,
  };
}
