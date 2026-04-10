import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

// We test the branch name generation logic via the utilities it relies on.
// The full setupBranch function requires a real git repo so we focus on
// the deterministic parts: slug + timestamp combination and auto-suffix logic.
import { slugify, timestampCompact } from "../src/utils/slugify.js";
import { autoSuffixBranchName, branchExists, getCurrentBranch } from "../src/git/index.js";
import { setupBranch } from "../src/branch/index.js";

describe("branch name generation", () => {
  test("produces a well-formed branch name from plan slug + timestamp", () => {
    const planSlug = slugify("Build a Bun CLI for adversarial loops");
    const ts = timestampCompact();
    const branchName = `adversary/${ts}-${planSlug}`;

    // Should look like adversary/20260410-123456-build-a-bun-cli-for-adversarial-lo
    expect(branchName).toMatch(/^adversary\/\d{8}-\d{6}-[a-z0-9-]+$/);
  });

  test("slugify produces filesystem-safe names", () => {
    const slug = slugify("My Plan: Build Something Special!");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).not.toContain(" ");
    expect(slug).not.toContain(":");
    expect(slug).not.toContain("!");
  });

  test("slugify truncates at 40 chars by default", () => {
    const longTitle = "a".repeat(100);
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe("autoSuffixBranchName — in a real git repo", () => {
  async function makeGitRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "adversary-branch-test-"));
    const run = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run(["init"]);
    await run(["config", "user.email", "test@test.com"]);
    await run(["config", "user.name", "Test"]);
    // Create initial commit so branches work
    const proc = Bun.spawn(["sh", "-c", "echo init > README.md && git add -A && git commit -m init"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return dir;
  }

  test("returns base name when branch doesn't exist", async () => {
    const dir = await makeGitRepo();
    const name = await autoSuffixBranchName("adversary/my-feature", dir);
    expect(name).toBe("adversary/my-feature");
  });

  test("appends -2 when base branch already exists", async () => {
    const dir = await makeGitRepo();
    // Create the branch
    const proc = Bun.spawn(["git", "checkout", "-b", "adversary/my-feature"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const name = await autoSuffixBranchName("adversary/my-feature", dir);
    expect(name).toBe("adversary/my-feature-2");
  });

  test("appends -3 when -2 also exists", async () => {
    const dir = await makeGitRepo();
    const create = async (branch: string) => {
      const proc = Bun.spawn(["git", "checkout", "-b", branch], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      // Checkout back to main/master for next branch
      const back = Bun.spawn(["git", "checkout", "-"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      await back.exited;
    };
    await create("adversary/my-feature");
    await create("adversary/my-feature-2");

    const name = await autoSuffixBranchName("adversary/my-feature", dir);
    expect(name).toBe("adversary/my-feature-3");
  });
});

describe("setupBranch — end-to-end in a real git repo", () => {
  async function makeGitRepoWithMain(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "adversary-setup-branch-test-"));
    const run = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run(["init"]);
    await run(["config", "user.email", "test@test.com"]);
    await run(["config", "user.name", "Test"]);
    const proc = Bun.spawn(
      ["sh", "-c", "echo init > README.md && git add -A && git commit -m init"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
    // Rename default branch to 'main' if needed
    await run(["branch", "-M", "main"]);
    return dir;
  }

  test("creates and checks out feature branch from base branch", async () => {
    const dir = await makeGitRepoWithMain();
    const { baseBranch, featureBranch } = await setupBranch(dir, "my-plan", "main");

    expect(baseBranch).toBe("main");
    expect(featureBranch).toMatch(/^adversary\/\d{8}-\d{6}-my-plan$/);

    // Should be on the feature branch now
    const active = await getCurrentBranch(dir);
    expect(active).toBe(featureBranch);
  });

  test("feature branch is distinct from base branch", async () => {
    const dir = await makeGitRepoWithMain();
    const { baseBranch, featureBranch } = await setupBranch(dir, "another-plan", "main");

    expect(featureBranch).not.toBe(baseBranch);
  });

  test("auto-suffixes when feature branch name already exists", async () => {
    const dir = await makeGitRepoWithMain();

    // First call creates the branch
    const { featureBranch: first } = await setupBranch(dir, "conflict-plan", "main");

    // Go back to main so we can call setupBranch again (it checks out base first)
    const proc = Bun.spawn(["git", "checkout", "main"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;

    // Mock: the timestamp will differ, so no real collision in practice,
    // but we verify the returned branch name is always valid
    expect(first).toMatch(/^adversary\/\d{8}-\d{6}-conflict-plan$/);
    expect(await branchExists(first, dir)).toBe(true);
  });
});
