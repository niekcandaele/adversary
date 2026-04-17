import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isGitRepo,
  isCleanWorkingTree,
  getCurrentBranch,
  branchExists,
  createAndCheckoutBranch,
  checkoutBranch,
  autoSuffixBranchName,
  hasChanges,
  commitAll,
  isAncestor,
  commitsBetween,
  lsRemoteHasBranch,
  getRemoteBranchSha,
  getStatusShort,
} from "../src/git/index.js";

async function gitInit(dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "init", "-b", "main"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  // Configure user for commits
  const cfg1 = Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await cfg1.exited;
  const cfg2 = Bun.spawn(["git", "config", "user.name", "Test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await cfg2.exited;
}

async function gitCommit(dir: string, message: string): Promise<void> {
  await writeFile(join(dir, ".gitkeep"), "");
  const add = Bun.spawn(["git", "add", "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await add.exited;
  const commit = Bun.spawn(["git", "commit", "-m", message], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await commit.exited;
}

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "adversary-git-test-"));
  await gitInit(testDir);
  await gitCommit(testDir, "initial commit");
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("isGitRepo", () => {
  test("returns true inside a git repo", async () => {
    expect(await isGitRepo(testDir)).toBe(true);
  });

  test("returns false outside a git repo", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "non-repo-"));
    try {
      expect(await isGitRepo(nonRepo)).toBe(false);
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("isCleanWorkingTree", () => {
  test("clean after initial commit", async () => {
    const result = await isCleanWorkingTree(testDir);
    expect(result.clean).toBe(true);
  });

  test("dirty with untracked file", async () => {
    const untrackedPath = join(testDir, "untracked.txt");
    await writeFile(untrackedPath, "hello");
    try {
      const result = await isCleanWorkingTree(testDir);
      expect(result.clean).toBe(false);
      expect(result.reason).toContain("untracked");
    } finally {
      await rm(untrackedPath);
    }
  });
});

describe("getCurrentBranch", () => {
  test("returns current branch name", async () => {
    const branch = await getCurrentBranch(testDir);
    expect(branch).toBe("main");
  });
});

describe("branchExists", () => {
  test("returns true for existing branch", async () => {
    expect(await branchExists("main", testDir)).toBe(true);
  });

  test("returns false for non-existing branch", async () => {
    expect(await branchExists("non-existent-branch-xyz", testDir)).toBe(false);
  });
});

describe("createAndCheckoutBranch / checkoutBranch", () => {
  test("creates new branch and switches to it", async () => {
    await createAndCheckoutBranch("test-feature-branch", testDir);
    const branch = await getCurrentBranch(testDir);
    expect(branch).toBe("test-feature-branch");
    // Switch back
    await checkoutBranch("main", testDir);
    expect(await getCurrentBranch(testDir)).toBe("main");
  });
});

describe("autoSuffixBranchName", () => {
  test("returns base name if no collision", async () => {
    const name = await autoSuffixBranchName("unique-branch-xyz", testDir);
    expect(name).toBe("unique-branch-xyz");
  });

  test("suffixes if branch exists", async () => {
    // test-feature-branch was created above
    const name = await autoSuffixBranchName("test-feature-branch", testDir);
    expect(name).toBe("test-feature-branch-2");
  });
});

describe("hasChanges and commitAll", () => {
  test("no changes after clean commit", async () => {
    expect(await hasChanges(testDir)).toBe(false);
  });

  test("detects new file", async () => {
    const newFile = join(testDir, "newfile.txt");
    await writeFile(newFile, "content");
    expect(await hasChanges(testDir)).toBe(true);
    // Commit it
    const sha = await commitAll("test: add newfile", testDir);
    expect(sha).toHaveLength(40);
    expect(await hasChanges(testDir)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VI-12: isAncestor, commitsBetween, lsRemoteHasBranch
// ─────────────────────────────────────────────────────────────────────────────

describe("isAncestor", () => {
  test("parent commit is ancestor of child", async () => {
    // testDir has at least the initial commit and newfile commit — get two consecutive SHAs
    const logProc = Bun.spawn(["git", "log", "--format=%H", "--max-count=2"], { cwd: testDir, stdout: "pipe", stderr: "pipe" });
    await logProc.exited;
    const log = (await new Response(logProc.stdout).text()).trim().split("\n");
    const child = log[0]!;
    const parent = log[1]!;
    // parent should be ancestor of child
    expect(await isAncestor(parent, child, testDir)).toBe(true);
    // child should NOT be ancestor of parent
    expect(await isAncestor(child, parent, testDir)).toBe(false);
  });

  test("commit is its own ancestor (same SHA)", async () => {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: testDir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const sha = (await new Response(proc.stdout).text()).trim();
    expect(await isAncestor(sha, sha, testDir)).toBe(true);
  });
});

describe("commitsBetween", () => {
  let rangeDir: string;

  beforeAll(async () => {
    rangeDir = await mkdtemp(join(tmpdir(), "adversary-commits-between-"));
    const run = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: rangeDir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run(["init", "-b", "main"]);
    await run(["config", "user.email", "t@t.com"]);
    await run(["config", "user.name", "T"]);
  });

  afterAll(async () => {
    await rm(rangeDir, { recursive: true, force: true });
  });

  async function commitFile(dir: string, name: string, msg: string): Promise<string> {
    await writeFile(join(dir, name), Date.now().toString());
    const add = Bun.spawn(["git", "add", "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await add.exited;
    const commit = Bun.spawn(["git", "commit", "-m", msg], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await commit.exited;
    const rev = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await rev.exited;
    return (await new Response(rev.stdout).text()).trim();
  }

  test("0 commits between identical SHAs", async () => {
    const sha = await commitFile(rangeDir, "f1.txt", "first");
    const result = await commitsBetween(sha, sha, rangeDir);
    expect(result).toHaveLength(0);
  });

  test("1 commit between two consecutive commits", async () => {
    const sha1 = await commitFile(rangeDir, "f2.txt", "second");
    const sha2 = await commitFile(rangeDir, "f3.txt", "third");
    const result = await commitsBetween(sha1, sha2, rangeDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sha2);
  });

  test("N commits between N-apart commits", async () => {
    const base = await commitFile(rangeDir, "fb.txt", "base");
    await commitFile(rangeDir, "fc.txt", "c1");
    await commitFile(rangeDir, "fd.txt", "c2");
    const tip = await commitFile(rangeDir, "fe.txt", "c3");
    const result = await commitsBetween(base, tip, rangeDir);
    expect(result).toHaveLength(3);
  });
});

describe("lsRemoteHasBranch — file:// local remote", () => {
  let originDir: string;
  let cloneDir: string;

  beforeAll(async () => {
    originDir = await mkdtemp(join(tmpdir(), "adversary-origin-"));
    cloneDir = await mkdtemp(join(tmpdir(), "adversary-clone-"));

    const run = async (args: string[], cwd: string) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };

    // Create origin repo
    await run(["init", "-b", "main"], originDir);
    await run(["config", "user.email", "t@t.com"], originDir);
    await run(["config", "user.name", "T"], originDir);
    await writeFile(join(originDir, "init.txt"), "init");
    await run(["add", "."], originDir);
    await run(["commit", "-m", "init"], originDir);

    // Clone it
    const clone = Bun.spawn(["git", "clone", `file://${originDir}`, cloneDir], { stdout: "pipe", stderr: "pipe" });
    await clone.exited;
    await run(["config", "user.email", "t@t.com"], cloneDir);
    await run(["config", "user.name", "T"], cloneDir);
  });

  afterAll(async () => {
    await rm(originDir, { recursive: true, force: true });
    await rm(cloneDir, { recursive: true, force: true });
  });

  test("returns false for non-existent remote branch", async () => {
    const result = await lsRemoteHasBranch("nonexistent-branch-xyz", "origin", cloneDir);
    expect(result).toBe(false);
  });

  test("returns true for main branch that exists on remote", async () => {
    const result = await lsRemoteHasBranch("main", "origin", cloneDir);
    expect(result).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VI-4: getRemoteBranchSha — file:// local remote
// ─────────────────────────────────────────────────────────────────────────────

describe("getRemoteBranchSha — file:// local remote", () => {
  let originDir: string;
  let cloneDir: string;
  let expectedMainSha: string;

  beforeAll(async () => {
    originDir = await mkdtemp(join(tmpdir(), "adversary-sha-origin-"));
    cloneDir = await mkdtemp(join(tmpdir(), "adversary-sha-clone-"));

    const run = async (args: string[], cwd: string): Promise<string> => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return (await new Response(proc.stdout).text()).trim();
    };

    // Create origin repo with initial commit
    await run(["init", "-b", "main"], originDir);
    await run(["config", "user.email", "t@t.com"], originDir);
    await run(["config", "user.name", "T"], originDir);
    await writeFile(join(originDir, "init.txt"), "init");
    await run(["add", "."], originDir);
    await run(["commit", "-m", "init"], originDir);
    expectedMainSha = await run(["rev-parse", "HEAD"], originDir);

    // Clone it
    const clone = Bun.spawn(["git", "clone", `file://${originDir}`, cloneDir], { stdout: "pipe", stderr: "pipe" });
    await clone.exited;
    await run(["config", "user.email", "t@t.com"], cloneDir);
    await run(["config", "user.name", "T"], cloneDir);
  });

  afterAll(async () => {
    await rm(originDir, { recursive: true, force: true });
    await rm(cloneDir, { recursive: true, force: true });
  });

  test("returns exact SHA for existing remote branch", async () => {
    const sha = await getRemoteBranchSha("main", "origin", cloneDir);
    expect(sha).toBe(expectedMainSha);
  });

  test("returns null for non-existent remote branch", async () => {
    const sha = await getRemoteBranchSha("nonexistent-branch-xyz", "origin", cloneDir);
    expect(sha).toBeNull();
  });

  test("returns updated SHA after pushing a new commit", async () => {
    const run = async (args: string[], cwd: string): Promise<string> => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return (await new Response(proc.stdout).text()).trim();
    };

    // Create a feature branch and push it
    await run(["checkout", "-b", "feature-sha-test"], cloneDir);
    await writeFile(join(cloneDir, "feature.txt"), "feature");
    await run(["add", "."], cloneDir);
    await run(["commit", "-m", "feature commit"], cloneDir);
    const newSha = await run(["rev-parse", "HEAD"], cloneDir);
    await run(["push", "origin", "feature-sha-test"], cloneDir);

    const remoteSha = await getRemoteBranchSha("feature-sha-test", "origin", cloneDir);
    expect(remoteSha).toBe(newSha);

    // Cleanup: go back to main
    await run(["checkout", "main"], cloneDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VI-7: getStatusShort({ignoreUntracked}) unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("getStatusShort — ignoreUntracked option (VI-7)", () => {
  let statusDir: string;

  beforeAll(async () => {
    statusDir = await mkdtemp(join(tmpdir(), "adversary-status-short-"));
    const run = async (args: string[], cwd: string) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run(["init", "-b", "main"], statusDir);
    await run(["config", "user.email", "t@t.com"], statusDir);
    await run(["config", "user.name", "T"], statusDir);

    // Initial commit
    await writeFile(join(statusDir, "tracked.txt"), "initial content");
    await run(["add", "."], statusDir);
    await run(["commit", "-m", "initial"], statusDir);

    // Modify the tracked file (creates a tracked modification)
    await writeFile(join(statusDir, "tracked.txt"), "modified content");

    // Create an untracked file
    await writeFile(join(statusDir, "untracked.txt"), "untracked content");
  });

  afterAll(async () => {
    await rm(statusDir, { recursive: true, force: true });
  });

  test("without ignoreUntracked: shows both tracked mod and untracked file", async () => {
    const status = await getStatusShort(statusDir);
    // Should contain tracked modification (M) and untracked file (??)
    expect(status).toMatch(/tracked\.txt/);
    expect(status).toMatch(/untracked\.txt/);
    // Should have both types of changes
    expect(status).toMatch(/M/);
    expect(status).toMatch(/\?\?/);
  });

  test("with ignoreUntracked=true: shows tracked mod but not untracked file", async () => {
    const status = await getStatusShort(statusDir, { ignoreUntracked: true });
    // Should contain tracked modification
    expect(status).toMatch(/tracked\.txt/);
    // Should NOT contain untracked file
    expect(status).not.toMatch(/untracked\.txt/);
    // Should not have ?? markers
    expect(status).not.toMatch(/\?\?/);
  });

  test("with ignoreUntracked=true: returns empty string in clean repo (no tracked changes)", async () => {
    const cleanDir = await mkdtemp(join(tmpdir(), "adversary-status-clean-"));
    try {
      const run = async (args: string[], cwd: string) => {
        const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      };
      await run(["init", "-b", "main"], cleanDir);
      await run(["config", "user.email", "t@t.com"], cleanDir);
      await run(["config", "user.name", "T"], cleanDir);
      await writeFile(join(cleanDir, "file.txt"), "content");
      await run(["add", "."], cleanDir);
      await run(["commit", "-m", "init"], cleanDir);

      // Only add an untracked file — no tracked changes
      await writeFile(join(cleanDir, "untracked-only.txt"), "untracked");

      const status = await getStatusShort(cleanDir, { ignoreUntracked: true });
      expect(status.trim()).toBe("");
    } finally {
      await rm(cleanDir, { recursive: true, force: true });
    }
  });
});
