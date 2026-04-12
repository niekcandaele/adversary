import { isGitRepo, isCleanWorkingTree, getRemoteUrl } from "../git/index.js";
import { fileExists } from "../utils/fs.js";

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

async function checkVerifyContract(
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<{ ok: boolean; reason?: string }> {
  // Run `pi --help` to confirm pi is functional. This is a smoke-test only;
  // the structured output contract (--format=json / --output=) is validated at
  // runtime by parsing the verify.json artifact produced by the verify step.
  const proc = Bun.spawn(["pi", "--help"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? process.env,
  });
  const code = await proc.exited;
  if (code !== 0) {
    return { ok: false, reason: "pi --help returned non-zero exit code" };
  }
  return { ok: true };
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
  env?: NodeJS.ProcessEnv
): Promise<PreflightResult> {
  // 1. Must be inside a git repo
  if (!(await isGitRepo(cwd))) {
    throw new PreflightError(`Not inside a git repository: ${cwd}`);
  }

  // 2. Clean working tree
  const cleanResult = await isCleanWorkingTree(cwd);
  if (!cleanResult.clean) {
    throw new PreflightError(cleanResult.reason!);
  }

  // 3. Plan file readable and non-empty
  if (!fileExists(planFile)) {
    throw new PreflightError(`Plan file not found: ${planFile}`);
  }
  const planContent = await Bun.file(planFile).text();
  if (planContent.trim().length === 0) {
    throw new PreflightError(`Plan file is empty: ${planFile}`);
  }

  // 4. Required commands
  if (!(await commandExists("git", env))) {
    throw new PreflightError("git is not available in PATH.");
  }
  if (!(await commandExists("pi", env))) {
    throw new PreflightError("pi is not available in PATH. Install it before running adversary.");
  }

  // 5. Remote detection
  const remoteUrl = await getRemoteUrl(cwd);

  // 6. Platform detection
  const platform = detectPlatform(remoteUrl);

  // 7. PR CLI check
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

  // 8. Verify contract preflight
  const verifyCheck = await checkVerifyContract(cwd, env);
  if (!verifyCheck.ok) {
    throw new PreflightError(`Verify command preflight failed: ${verifyCheck.reason}`);
  }

  return {
    cwd,
    platform,
    remoteUrl,
    prCli,
  };
}
