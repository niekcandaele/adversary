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

/**
 * Returns true when there is at least one commit on HEAD that is not yet
 * in baseBranch (i.e. the branch has something worth pushing/PR-ing).
 */
export async function hasCommitsAheadOfBase(cwd: string, branch: string, baseBranch: string): Promise<boolean> {
  // git rev-list --count baseBranch..HEAD counts commits reachable from HEAD but not baseBranch.
  // We pass the actual branch name for clarity, but HEAD also works since we are on that branch.
  const result = await git(["rev-list", "--count", `${baseBranch}..${branch}`], cwd);
  if (result.exitCode !== 0) {
    // Fallback: if the command fails (e.g. baseBranch doesn't exist locally), assume there are
    // commits so we don't suppress PR creation. Log a warning so the condition is observable.
    process.stderr.write(
      `Warning: could not verify commits ahead of base branch "${baseBranch}" ` +
      `(git rev-list exit ${result.exitCode}). Proceeding with PR creation. ` +
      `Check that "${baseBranch}" exists locally if this is unexpected.\n`
    );
    return true;
  }
  const count = parseInt(result.stdout.trim(), 10);
  return !isNaN(count) && count > 0;
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

/**
 * Returns the list of file paths changed by a single commit (using --name-only).
 * Returns an empty array if the commit SHA is invalid or the command fails.
 * Handles root (initial) commits that have no parent by using --root flag on diff-tree.
 * On non-zero exit, writes a diagnostic to stderr so resume scenarios with rebased-away
 * SHAs are observable rather than silently returning an empty list.
 */
export async function getFilesChangedByCommit(sha: string, cwd: string): Promise<string[]> {
  // Use diff-tree with --root to handle both root commits and normal commits.
  // --root: treat the commit as a diff against an empty tree (works for root commits).
  // Without --root, root commits produce empty output since they have no parent.
  const result = await git(["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", sha], cwd);
  if (result.exitCode === 0) {
    return result.stdout.split("\n").filter(Boolean);
  }
  process.stderr.write(`[adversary] getFilesChangedByCommit: git diff-tree failed for SHA ${sha} (exit ${result.exitCode}): ${result.stderr}\n`);
  return [];
}

/** Represents a single turn's touch of a file, including the short SHA for git inspection. */
export interface TurnTouchEntry {
  turn: number;
  sha: string;
}

/**
 * Given a list of TurnResult-like objects, computes a deduped map of file path →
 * sorted list of TurnTouchEntry objects.
 *
 * When a turn has no commitSha, it is classified as follows:
 * - `outcome === "commit-failure"` or `outcome === "summarizer-failure"`, or any turn
 *   where `repoChanged === true` without a commitSha: recorded in `commitFailureTurns`
 *   because uncommitted edits may remain in the working tree.
 * - All other no-commitSha turns (e.g. outcome "continue", repoChanged false): silently
 *   skipped — they are no-op turns with a clean working tree.
 *
 * When the same turn number appears with two different SHAs (resume scenario), the first
 * SHA wins and is used consistently for all files touched by that turn.
 *
 * Git calls are run in parallel for efficiency.
 */
export async function computeTouchedFilesByTurn(
  turns: Array<{ turn: number; commitSha?: string; outcome?: string; repoChanged?: boolean }>,
  cwd: string
): Promise<{ fileToTurns: Map<string, TurnTouchEntry[]>; commitFailureTurns: number[] }> {
  const fileToTurns = new Map<string, TurnTouchEntry[]>();
  const commitFailureTurns: number[] = [];

  // Canonicalize one SHA per turn number (first SHA wins) before expanding to files.
  // This prevents the same turn from displaying different SHAs across different files
  // in the resume scenario where a turn is re-run with a new SHA.
  const canonicalTurnMap = new Map<number, string>();
  for (const t of turns) {
    if (!t.commitSha) {
      // Surface any turn that left uncommitted edits in the working tree.
      // This includes explicit commit-failure and summarizer-failure outcomes,
      // as well as any other terminal outcome where repoChanged is true but no
      // commit was produced (general guard: !commitSha && repoChanged === true).
      if (t.outcome === "commit-failure" || t.outcome === "summarizer-failure" || (!t.commitSha && t.repoChanged === true)) {
        commitFailureTurns.push(t.turn);
      }
      continue;
    }
    // First SHA wins for duplicate turn numbers.
    if (!canonicalTurnMap.has(t.turn)) {
      canonicalTurnMap.set(t.turn, t.commitSha);
    }
  }

  // Drop commit-failure turns that were subsequently recovered: if any later turn
  // successfully committed (has an entry in canonicalTurnMap with a higher turn number),
  // the earlier failure's uncommitted edits are no longer in the working tree.
  const maxCommittedTurn = canonicalTurnMap.size > 0 ? Math.max(...canonicalTurnMap.keys()) : -1;
  commitFailureTurns.splice(
    0,
    commitFailureTurns.length,
    ...commitFailureTurns.filter((failTurn) => failTurn > maxCommittedTurn)
  );

  // Also handle the "resume-and-discard" path: if the user manually discarded uncommitted
  // edits (e.g. `git checkout .`) between turns without a subsequent commit, the working
  // tree will be clean but commitFailureTurns may still contain stale entries. Detect this
  // by checking the current working tree state — if clean, all commit-failure entries are
  // resolved regardless of commit history. (This check is fast: a single `git status` call.)
  // Note: this does NOT handle recovery-via-commit (handled above by maxCommittedTurn).
  if (commitFailureTurns.length > 0) {
    const currentlyClean = !(await hasChanges(cwd));
    // Known limitations: this check is based on `git status --porcelain` being empty.
    // It will ALSO treat the following scenarios as 'clean' even though the underlying
    // state differs:
    //   - `git stash` — stashed changes are hidden but recoverable. The working tree
    //     looks clean even though edits exist in the stash.
    //   - External edits committed in a side-branch outside the run's tracked SHAs.
    //     Those commits won't appear in canonicalTurnMap, so the files won't be surfaced.
    //   - Partial manual commits where some edits remain in another branch.
    //     Same issue: those SHAs are unknown to this run.
    // These are rare edge cases and cause only prompt-quality noise (warning about
    // commit-failure turns that seem resolved), not correctness issues. If users hit
    // this in practice, we can refine by inspecting `git stash list` and
    // cross-referencing turn-originated files.
    if (currentlyClean) {
      commitFailureTurns.length = 0;
    }
  }

  // Fetch files for all canonical turns in parallel — calls are independent.
  const canonicalTurns = Array.from(canonicalTurnMap.entries()).map(([turn, sha]) => ({ turn, sha }));
  const results = await Promise.all(
    canonicalTurns.map(async (t) => ({
      turn: t.turn,
      sha: t.sha.slice(0, 7),
      files: await getFilesChangedByCommit(t.sha, cwd),
    }))
  );

  for (const { turn, sha, files } of results) {
    for (const file of files) {
      const existing = fileToTurns.get(file);
      if (existing) {
        existing.push({ turn, sha });
      } else {
        fileToTurns.set(file, [{ turn, sha }]);
      }
    }
  }

  // Sort each file's entries by turn number for deterministic output.
  for (const entries of fileToTurns.values()) {
    entries.sort((a, b) => a.turn - b.turn);
  }

  return { fileToTurns, commitFailureTurns };
}
