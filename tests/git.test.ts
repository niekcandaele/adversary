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
