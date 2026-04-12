/**
 * Tests for scope detection (src/scope/index.ts)
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { detectScope, buildScopeContext, buildScopeMetadata } from "../src/scope/index.js";

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "adversary-scope-test-"));
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };
  await run("git", "init", "-b", "main");
  await run("git", "config", "user.email", "test@test.com");
  await run("git", "config", "user.name", "Test");
  // Initial commit
  await writeFile(join(dir, "README.md"), "# Test Repo");
  const proc = Bun.spawn(
    ["sh", "-c", "git add -A && git commit -m 'init'"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;
  return dir;
}

describe("detectScope", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeGitRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  test("returns empty files when no changes from base", async () => {
    const scope = await detectScope(repoDir, "main");
    expect(scope.baseBranch).toBe("main");
    expect(scope.mergeBase).toBeTruthy();
    expect(scope.files).toHaveLength(0);
    expect(scope.diffCommand).toContain("git diff --name-status");
  });

  test("detects added files", async () => {
    // Create a branch and add a file
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(args, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run("git", "checkout", "-b", "feature/test");
    await writeFile(join(repoDir, "new-file.ts"), "export const x = 1;");
    const proc = Bun.spawn(
      ["sh", "-c", "git add -A && git commit -m 'add file'"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;

    const scope = await detectScope(repoDir, "main");
    expect(scope.files).toHaveLength(1);
    expect(scope.files[0]?.path).toBe("new-file.ts");
    expect(scope.files[0]?.status).toBe("added");
  });

  test("detects modified files", async () => {
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(args, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run("git", "checkout", "-b", "feature/modify");
    await writeFile(join(repoDir, "README.md"), "# Modified");
    const proc = Bun.spawn(
      ["sh", "-c", "git add -A && git commit -m 'modify'"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;

    const scope = await detectScope(repoDir, "main");
    expect(scope.files).toHaveLength(1);
    expect(scope.files[0]?.path).toBe("README.md");
    expect(scope.files[0]?.status).toBe("modified");
  });

  test("detects deleted files", async () => {
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(args, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run("git", "checkout", "-b", "feature/delete");
    const proc = Bun.spawn(
      ["sh", "-c", "git rm README.md && git commit -m 'delete'"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;

    const scope = await detectScope(repoDir, "main");
    expect(scope.files).toHaveLength(1);
    expect(scope.files[0]?.path).toBe("README.md");
    expect(scope.files[0]?.status).toBe("deleted");
  });

  test("detects multiple changed files", async () => {
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(args, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run("git", "checkout", "-b", "feature/multi");
    await writeFile(join(repoDir, "file1.ts"), "const a = 1;");
    await writeFile(join(repoDir, "file2.ts"), "const b = 2;");
    await writeFile(join(repoDir, "README.md"), "# Updated");
    const proc = Bun.spawn(
      ["sh", "-c", "git add -A && git commit -m 'multi-change'"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;

    const scope = await detectScope(repoDir, "main");
    expect(scope.files).toHaveLength(3);
    const paths = scope.files.map((f) => f.path);
    expect(paths).toContain("file1.ts");
    expect(paths).toContain("file2.ts");
    expect(paths).toContain("README.md");
  });

  test("includes diffStat string", async () => {
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(args, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run("git", "checkout", "-b", "feature/stat");
    await writeFile(join(repoDir, "stat-file.ts"), "export const x = 1;");
    const proc = Bun.spawn(
      ["sh", "-c", "git add -A && git commit -m 'stat'"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;

    const scope = await detectScope(repoDir, "main");
    expect(scope.diffStat).toContain("stat-file.ts");
  });

  // VI-12: invalid git merge base should throw
  test("throws when merge base cannot be determined (nonexistent branch)", async () => {
    await expect(detectScope(repoDir, "nonexistent-branch-xyz")).rejects.toThrow();
  });

  // VI-21: rename status code maps to "renamed"
  test("detects renamed files", async () => {
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(args, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run("git", "checkout", "-b", "feature/rename");
    const proc = Bun.spawn(
      ["sh", "-c", "git mv README.md README-renamed.md && git commit -m 'rename'"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;

    const scope = await detectScope(repoDir, "main");
    // Rename shows up as the destination file with "renamed" status
    const renamedFile = scope.files.find((f) => f.path === "README-renamed.md");
    expect(renamedFile).toBeTruthy();
    expect(renamedFile?.status).toBe("renamed");
  });
});

describe("buildScopeContext", () => {
  test("returns empty message when no files", () => {
    const scope = {
      baseBranch: "main",
      mergeBase: "abc123",
      files: [],
      diffCommand: "git diff",
      diffStat: "",
    };
    expect(buildScopeContext(scope)).toBe("No files changed in scope.");
  });

  test("lists files with statuses", () => {
    const scope = {
      baseBranch: "main",
      mergeBase: "abc123",
      files: [
        { path: "src/foo.ts", status: "added" as const },
        { path: "src/bar.ts", status: "modified" as const },
        { path: "src/baz.ts", status: "deleted" as const },
      ],
      diffCommand: "git diff",
      diffStat: "3 files changed",
    };
    const context = buildScopeContext(scope);
    expect(context).toContain("3 total");
    expect(context).toContain("[ADDED] src/foo.ts");
    expect(context).toContain("[MODIFIED] src/bar.ts");
    expect(context).toContain("[DELETED] src/baz.ts");
  });
});

describe("buildScopeMetadata", () => {
  test("includes base branch, merge base, and diff command", () => {
    const scope = {
      baseBranch: "main",
      mergeBase: "deadbeef",
      files: [],
      diffCommand: "git diff --name-status deadbeef...HEAD",
      diffStat: "",
    };
    const meta = buildScopeMetadata(scope);
    expect(meta).toContain("main");
    expect(meta).toContain("deadbeef");
    expect(meta).toContain("git diff --name-status");
  });
});
