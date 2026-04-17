export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.exitCode !== 0) {
    throw new GitError(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.exitCode === 0 && result.stdout === "true";
}

export async function isCleanWorkingTree(cwd: string): Promise<{ clean: boolean; reason?: string }> {
  // Check for staged changes
  const staged = await git(["diff", "--cached", "--quiet"], cwd);
  if (staged.exitCode !== 0) {
    return { clean: false, reason: "There are staged changes. Please unstage or commit them before running adversary." };
  }

  // Check for unstaged changes
  const unstaged = await git(["diff", "--quiet"], cwd);
  if (unstaged.exitCode !== 0) {
    return { clean: false, reason: "There are unstaged changes. Please commit or stash them before running adversary." };
  }

  // Check for untracked files
  const untracked = await git(["status", "--porcelain", "--untracked-files=normal"], cwd);
  if (untracked.stdout.length > 0) {
    const lines = untracked.stdout.split("\n").filter(Boolean);
    const untrackedLines = lines.filter((l) => l.startsWith("??"));
    if (untrackedLines.length > 0) {
      return { clean: false, reason: `There are untracked files:\n${untrackedLines.map((l) => "  " + l.slice(3)).join("\n")}\nPlease add them to .gitignore or commit them.` };
    }
  }

  return { clean: true };
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return await gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export async function getRemoteUrl(cwd: string): Promise<string | null> {
  const result = await git(["remote", "get-url", "origin"], cwd);
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

export async function branchExists(name: string, cwd: string): Promise<boolean> {
  const result = await git(["branch", "--list", name], cwd);
  return result.exitCode === 0 && result.stdout.length > 0;
}

export async function checkoutBranch(name: string, cwd: string): Promise<void> {
  await gitOrThrow(["checkout", name], cwd);
}

export async function createAndCheckoutBranch(name: string, cwd: string): Promise<void> {
  await gitOrThrow(["checkout", "-b", name], cwd);
}

export async function hasChanges(cwd: string): Promise<boolean> {
  const result = await git(["status", "--porcelain"], cwd);
  return result.exitCode === 0 && result.stdout.length > 0;
}

export async function commitAll(message: string, cwd: string): Promise<string> {
  await gitOrThrow(["add", "-A"], cwd);
  await gitOrThrow(["commit", "-m", message], cwd);
  return await gitOrThrow(["rev-parse", "HEAD"], cwd);
}

export async function pushBranch(branch: string, remote: string, cwd: string): Promise<void> {
  await gitOrThrow(["push", "-u", remote, branch], cwd);
}


export async function detectBaseBranch(cwd: string): Promise<string> {
  // Try common branch names
  for (const candidate of ["main", "master", "develop", "trunk"]) {
    const result = await git(["branch", "--list", candidate], cwd);
    if (result.exitCode === 0 && result.stdout.length > 0) {
      return candidate;
    }
    // Also check remote tracking
    const remote = await git(["branch", "-r", "--list", `origin/${candidate}`], cwd);
    if (remote.exitCode === 0 && remote.stdout.length > 0) {
      return candidate;
    }
  }
  // Fall back to HEAD's symbolic ref default
  const head = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (head.exitCode === 0 && head.stdout) {
    return head.stdout.replace("refs/remotes/origin/", "");
  }
  throw new GitError("Cannot auto-detect base branch. Please set baseBranch in config or use --base-branch.");
}

export async function isAncestor(ancestorSha: string, descendantSha: string, cwd: string): Promise<boolean> {
  const result = await git(["merge-base", "--is-ancestor", ancestorSha, descendantSha], cwd);
  return result.exitCode === 0;
}

export async function commitsBetween(fromSha: string, toSha: string, cwd: string): Promise<string[]> {
  const result = await git(["log", "--format=%H", `${fromSha}..${toSha}`], cwd);
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

export async function getHeadSha(cwd: string): Promise<string> {
  return await gitOrThrow(["rev-parse", "HEAD"], cwd);
}

export async function getMergeBase(branchA: string, branchB: string, cwd: string): Promise<string> {
  return await gitOrThrow(["merge-base", branchA, branchB], cwd);
}

export async function lsRemoteHasBranch(branch: string, remote: string, cwd: string): Promise<boolean> {
  const result = await git(["ls-remote", "--heads", remote, branch], cwd);
  return result.exitCode === 0 && result.stdout.length > 0;
}

/**
 * Returns the SHA of a remote tracking branch, or null if the branch does not exist on the remote.
 * Uses `git ls-remote --heads <remote> <branch>` which parses the output `<sha>\trefs/heads/<branch>`.
 */
export async function getRemoteBranchSha(branch: string, remote: string, cwd: string): Promise<string | null> {
  const result = await git(["ls-remote", "--heads", remote, branch], cwd);
  if (result.exitCode !== 0 || !result.stdout) return null;
  // Output format: "<sha>\trefs/heads/<branch>"
  const sha = result.stdout.split("\t")[0]?.trim();
  return sha ?? null;
}

export async function resetHard(ref: string, cwd: string): Promise<void> {
  await gitOrThrow(["reset", "--hard", ref], cwd);
}

export async function cleanForce(cwd: string): Promise<void> {
  await gitOrThrow(["clean", "-fd"], cwd);
}

export async function getStatusShort(cwd: string, options?: { ignoreUntracked?: boolean }): Promise<string> {
  const args = options?.ignoreUntracked
    ? ["status", "--short", "--untracked-files=no"]
    : ["status", "--short"];
  const result = await git(args, cwd);
  return result.stdout;
}

export async function autoSuffixBranchName(baseName: string, cwd: string): Promise<string> {
  if (!(await branchExists(baseName, cwd))) return baseName;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseName}-${i}`;
    if (!(await branchExists(candidate, cwd))) return candidate;
  }
  throw new GitError(`Cannot find unique branch name for '${baseName}' (tried up to -99).`);
}
