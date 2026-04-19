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
  getFilesChangedByCommit,
  computeTouchedFilesByTurn,
  hasCommitsAheadOfBase,
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

// ─────────────────────────────────────────────────────────────────────────────
// getFilesChangedByCommit and computeTouchedFilesByTurn
// ─────────────────────────────────────────────────────────────────────────────

describe("getFilesChangedByCommit", () => {
  let touchedDir: string;
  let sha1: string;
  let sha2: string;

  beforeAll(async () => {
    touchedDir = await mkdtemp(join(tmpdir(), "adversary-touched-"));
    const run = async (args: string[], cwd: string): Promise<string> => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return (await new Response(proc.stdout).text()).trim();
    };

    await run(["init", "-b", "main"], touchedDir);
    await run(["config", "user.email", "t@t.com"], touchedDir);
    await run(["config", "user.name", "T"], touchedDir);

    // Commit 1: add two files
    await writeFile(join(touchedDir, "alpha.ts"), "export const a = 1;");
    await writeFile(join(touchedDir, "beta.ts"), "export const b = 2;");
    await run(["add", "."], touchedDir);
    await run(["commit", "-m", "first commit"], touchedDir);
    sha1 = await run(["rev-parse", "HEAD"], touchedDir);

    // Commit 2: add a different file
    await writeFile(join(touchedDir, "gamma.ts"), "export const c = 3;");
    await run(["add", "."], touchedDir);
    await run(["commit", "-m", "second commit"], touchedDir);
    sha2 = await run(["rev-parse", "HEAD"], touchedDir);
  });

  afterAll(async () => {
    await rm(touchedDir, { recursive: true, force: true });
  });

  test("returns files changed by a commit", async () => {
    const files = await getFilesChangedByCommit(sha1, touchedDir);
    expect(files).toContain("alpha.ts");
    expect(files).toContain("beta.ts");
    expect(files).not.toContain("gamma.ts");
  });

  test("returns only the file added in second commit", async () => {
    const files = await getFilesChangedByCommit(sha2, touchedDir);
    expect(files).toContain("gamma.ts");
    expect(files).not.toContain("alpha.ts");
  });

  test("returns empty array for invalid SHA", async () => {
    const files = await getFilesChangedByCommit("0000000000000000000000000000000000000000", touchedDir);
    expect(files).toEqual([]);
  });
});

describe("computeTouchedFilesByTurn", () => {
  let touchedDir2: string;
  let sha1: string;
  let sha2: string;

  beforeAll(async () => {
    touchedDir2 = await mkdtemp(join(tmpdir(), "adversary-touched2-"));
    const run = async (args: string[], cwd: string): Promise<string> => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return (await new Response(proc.stdout).text()).trim();
    };

    await run(["init", "-b", "main"], touchedDir2);
    await run(["config", "user.email", "t@t.com"], touchedDir2);
    await run(["config", "user.name", "T"], touchedDir2);

    // Commit 1: add file-a.ts
    await writeFile(join(touchedDir2, "file-a.ts"), "a");
    await run(["add", "."], touchedDir2);
    await run(["commit", "-m", "turn 1"], touchedDir2);
    sha1 = await run(["rev-parse", "HEAD"], touchedDir2);

    // Commit 2: add file-b.ts (also touches file-a.ts)
    await writeFile(join(touchedDir2, "file-a.ts"), "a-modified");
    await writeFile(join(touchedDir2, "file-b.ts"), "b");
    await run(["add", "."], touchedDir2);
    await run(["commit", "-m", "turn 2"], touchedDir2);
    sha2 = await run(["rev-parse", "HEAD"], touchedDir2);
  });

  afterAll(async () => {
    await rm(touchedDir2, { recursive: true, force: true });
  });

  // NOTE: Tests in this section dirty the shared `touchedDir2` fixture. `finally` blocks
  // (in afterAll) clean up. If future parallelization is introduced, migrate to per-test
  // fixtures (see the VI-77b test which uses a dedicated `cleanRepo`).
  test("maps files to turn numbers for multiple turns with commitSha", async () => {
    const { fileToTurns } = await computeTouchedFilesByTurn([
      { turn: 1, commitSha: sha1 },
      { turn: 2, commitSha: sha2 },
    ], touchedDir2);

    // file-a.ts touched in turn 1 (added) and turn 2 (modified)
    const aTurns = fileToTurns.get("file-a.ts");
    expect(aTurns).toBeDefined();
    expect(aTurns!.map((e) => e.turn)).toContain(1);
    expect(aTurns!.map((e) => e.turn)).toContain(2);

    // file-b.ts touched only in turn 2
    const bTurns = fileToTurns.get("file-b.ts");
    expect(bTurns).toBeDefined();
    expect(bTurns!.map((e) => e.turn)).toEqual([2]);
  });

  test("turn entries include short SHA", async () => {
    const { fileToTurns } = await computeTouchedFilesByTurn([
      { turn: 1, commitSha: sha1 },
    ], touchedDir2);

    const aTurns = fileToTurns.get("file-a.ts");
    expect(aTurns).toBeDefined();
    expect(aTurns![0]!.sha).toBe(sha1.slice(0, 7));
  });

  test("turn numbers are sorted ascending even when input is reverse-ordered", async () => {
    // Input is intentionally in descending order — sort must produce ascending output.
    const { fileToTurns } = await computeTouchedFilesByTurn([
      { turn: 2, commitSha: sha2 },
      { turn: 1, commitSha: sha1 },
    ], touchedDir2);

    const aTurns = fileToTurns.get("file-a.ts")!;
    const turnNums = aTurns.map((e) => e.turn);
    // Explicit expected order — not a self-sort.
    expect(turnNums).toEqual([1, 2]);
  });

  test("deduplicates turn when same (turn, sha) is passed twice", async () => {
    // Simulate passing turn 1 twice with the exact same SHA — dedup must fire.
    const { fileToTurns } = await computeTouchedFilesByTurn([
      { turn: 1, commitSha: sha1 },
      { turn: 1, commitSha: sha1 }, // exact duplicate
    ], touchedDir2);

    const aTurns = fileToTurns.get("file-a.ts");
    expect(aTurns).toBeDefined();
    // Turn 1 must appear exactly once, not twice.
    const count = aTurns!.filter((e) => e.turn === 1).length;
    expect(count).toBe(1);
  });

  test("deduplicates turn when same turn number appears with two different SHAs (first SHA wins)", async () => {
    // Resume scenario: same turn number re-run with a new SHA.
    // sha1 touches file-a.ts, sha2 also touches file-a.ts.
    // When both have turn=1, the first SHA encountered should win (dedup on turn number).
    const { fileToTurns } = await computeTouchedFilesByTurn([
      { turn: 1, commitSha: sha1 },
      { turn: 1, commitSha: sha2 }, // same turn, different SHA
    ], touchedDir2);

    const aTurns = fileToTurns.get("file-a.ts");
    expect(aTurns).toBeDefined();
    // Turn 1 must appear exactly once.
    const count = aTurns!.filter((e) => e.turn === 1).length;
    expect(count).toBe(1);
    // The first SHA wins.
    expect(aTurns!.find((e) => e.turn === 1)!.sha).toBe(sha1.slice(0, 7));
  });

  test("same-turn-different-SHA: all files for that turn show the same (first) SHA", async () => {
    // sha1 touches file-a.ts only; sha2 touches both file-a.ts and file-b.ts.
    // When both are labeled turn 1, canonicalization must pick sha1 for the whole turn.
    // Result: file-a.ts shows sha1, file-b.ts shows sha1 (NOT sha2).
    // This validates that the per-turn SHA is resolved BEFORE expanding to files.
    const { fileToTurns } = await computeTouchedFilesByTurn([
      { turn: 1, commitSha: sha1 },
      { turn: 1, commitSha: sha2 }, // same turn, different SHA — sha1 wins
    ], touchedDir2);

    const aTurns = fileToTurns.get("file-a.ts");
    expect(aTurns).toBeDefined();
    expect(aTurns!.find((e) => e.turn === 1)!.sha).toBe(sha1.slice(0, 7));

    // file-b.ts was only touched by sha2 (the discarded SHA), so it should NOT appear.
    // The canonical SHA for turn 1 is sha1, which does not touch file-b.ts.
    expect(fileToTurns.has("file-b.ts")).toBe(false);
  });

  test("records summarizer-failure turns in commitFailureTurns when it is the last turn (uncommitted edits)", async () => {
    // summarizer-failure: repoChanged=true but no commitSha (commit-message generator failed
    // before commit). The working tree still carries those edits, so the turn must surface
    // — but only if no later turn committed successfully (which would have cleaned it up).
    // Dirty the working tree to simulate that uncommitted edits remain (the VI-77b clean-tree
    // check must NOT suppress the entry when the tree is actually dirty).
    const dirtyFile = join(touchedDir2, "uncommitted-summarizer-failure.ts");
    await writeFile(dirtyFile, "dirty");
    try {
      const { fileToTurns, commitFailureTurns } = await computeTouchedFilesByTurn([
        { turn: 1, commitSha: sha2 },
        { turn: 2, commitSha: undefined, outcome: "summarizer-failure", repoChanged: true },
      ], touchedDir2);

      // Turn 1 has a commit; turn 2 has no commit.
      const allTurns = new Set(Array.from(fileToTurns.values()).flat().map((e) => e.turn));
      expect(allTurns.has(1)).toBe(true);

      // Turn 2 must appear in commitFailureTurns: it is the last turn and left dirty state.
      expect(commitFailureTurns).toContain(2);
      expect(commitFailureTurns).not.toContain(1);
    } finally {
      await rm(dirtyFile, { force: true });
    }
  });

  test("skips commit-failure turns (outcome:commit-failure) and records them in commitFailureTurns when last", async () => {
    // commit-failure on the last turn: no later commit resolves it, so it stays dirty.
    // Dirty the working tree to simulate that uncommitted edits remain.
    const dirtyFile = join(touchedDir2, "uncommitted-commit-failure.ts");
    await writeFile(dirtyFile, "dirty");
    try {
      const { fileToTurns, commitFailureTurns } = await computeTouchedFilesByTurn([
        { turn: 1, commitSha: sha2 },
        { turn: 2, commitSha: undefined, outcome: "commit-failure" },
      ], touchedDir2);

      // Only turn 1's files should appear in fileToTurns
      const allTurns = new Set(Array.from(fileToTurns.values()).flat().map((e) => e.turn));
      expect(allTurns.has(1)).toBe(true);

      // Turn 2 is the last and has no commit, so it should be recorded as a commit-failure turn
      expect(commitFailureTurns).toContain(2);
      expect(commitFailureTurns).not.toContain(1);
    } finally {
      await rm(dirtyFile, { force: true });
    }
  });

  // VI-77: commit-failure turn followed by a successful commit must not appear in commitFailureTurns
  test("(VI-77) commit-failure in turn 1 followed by successful commit in turn 2 is dropped from commitFailureTurns", async () => {
    // Turn 1: commit-failure — edits left in working tree.
    // Turn 2: successful commit — those edits (and possibly more) are now committed.
    // Result: turn 1 must NOT appear in commitFailureTurns because the dirty state is gone.
    const { commitFailureTurns } = await computeTouchedFilesByTurn([
      { turn: 1, commitSha: undefined, outcome: "commit-failure" },
      { turn: 2, commitSha: sha2 },
    ], touchedDir2);

    expect(commitFailureTurns).not.toContain(1);
    expect(commitFailureTurns).not.toContain(2);
  });

  // VI-77: summarizer-failure turn followed by a successful commit must also be dropped
  test("(VI-77) summarizer-failure in turn 1 followed by successful commit in turn 3 is dropped from commitFailureTurns", async () => {
    // Turn 1: summarizer-failure — no commit, edits in working tree.
    // Turn 2: another commit-failure — edits still not committed.
    // Turn 3: successful commit — both earlier dirty turns are now resolved.
    const { commitFailureTurns } = await computeTouchedFilesByTurn([
      { turn: 1, commitSha: undefined, outcome: "summarizer-failure", repoChanged: true },
      { turn: 2, commitSha: undefined, outcome: "commit-failure" },
      { turn: 3, commitSha: sha2 },
    ], touchedDir2);

    expect(commitFailureTurns).not.toContain(1);
    expect(commitFailureTurns).not.toContain(2);
    expect(commitFailureTurns).not.toContain(3);
  });

  // VI-77: commit-failure on the final turn (no recovery) must still be reported
  test("(VI-77) commit-failure on last turn with no later commit stays in commitFailureTurns", async () => {
    // Dirty the working tree to simulate that the commit-failure left uncommitted edits behind.
    const dirtyFile = join(touchedDir2, "uncommitted-vi77-last.ts");
    await writeFile(dirtyFile, "dirty");
    try {
      const { commitFailureTurns } = await computeTouchedFilesByTurn([
        { turn: 1, commitSha: sha1 },
        { turn: 2, commitSha: undefined, outcome: "commit-failure" },
      ], touchedDir2);

      // Turn 2 is the last — nothing committed after it, and working tree is dirty.
      expect(commitFailureTurns).toContain(2);
      expect(commitFailureTurns).not.toContain(1);
    } finally {
      await rm(dirtyFile, { force: true });
    }
  });

  test("no-op turns (outcome:continue, repoChanged:false) are silently skipped and NOT recorded in commitFailureTurns", async () => {
    // A no-op turn has no commitSha but outcome is "continue" (no changes were made).
    // It must NOT appear in commitFailureTurns — the working tree is clean, so the
    // "edits may be in the working tree" note would be incorrect.
    // Dirty the working tree so the commit-failure turn is not suppressed by the VI-77b check.
    const dirtyFile = join(touchedDir2, "uncommitted-noop.ts");
    await writeFile(dirtyFile, "dirty");
    try {
      const { fileToTurns, commitFailureTurns } = await computeTouchedFilesByTurn([
        { turn: 1, commitSha: undefined, outcome: "continue", repoChanged: false },
        { turn: 2, commitSha: undefined, outcome: "commit-failure" },
      ], touchedDir2);

      expect(fileToTurns.size).toBe(0);
      // Only the commit-failure turn appears in commitFailureTurns.
      expect(commitFailureTurns).not.toContain(1);
      expect(commitFailureTurns).toContain(2);
    } finally {
      await rm(dirtyFile, { force: true });
    }
  });

  test("returns empty map when all turns have no commitSha", async () => {
    // Dirty the working tree so the commit-failure entries are not suppressed by the VI-77b check.
    const dirtyFile = join(touchedDir2, "uncommitted-all-fail.ts");
    await writeFile(dirtyFile, "dirty");
    try {
      const { fileToTurns, commitFailureTurns } = await computeTouchedFilesByTurn([
        { turn: 1, commitSha: undefined, outcome: "commit-failure" },
        { turn: 2, commitSha: undefined, outcome: "commit-failure" },
      ], touchedDir2);

      expect(fileToTurns.size).toBe(0);
      expect(commitFailureTurns).toEqual([1, 2]);
    } finally {
      await rm(dirtyFile, { force: true });
    }
  });

  test("returns empty map for empty turns array", async () => {
    const { fileToTurns, commitFailureTurns } = await computeTouchedFilesByTurn([], touchedDir2);
    expect(fileToTurns.size).toBe(0);
    expect(commitFailureTurns).toEqual([]);
  });

  // VI-77b: resume-and-discard path — user manually ran `git checkout .` (or similar)
  // to discard uncommitted edits without a subsequent commit. Working tree is clean but
  // commitFailureTurns would otherwise still contain stale entries. The clean-tree check
  // must drop all entries when the working tree has no changes.
  test("(VI-77b) commit-failure in turn 1 with no later commit BUT clean working tree drops commitFailureTurns", async () => {
    // Use a dedicated clean repo so we control working-tree state precisely.
    const cleanRepo = await mkdtemp(join(tmpdir(), "adversary-vi77b-"));
    try {
      const run = async (args: string[], cwd: string): Promise<string> => {
        const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        return (await new Response(proc.stdout).text()).trim();
      };
      await run(["init", "-b", "main"], cleanRepo);
      await run(["config", "user.email", "test@test.com"], cleanRepo);
      await run(["config", "user.name", "Test"], cleanRepo);
      // Create an initial commit so the repo is valid.
      await writeFile(join(cleanRepo, "initial.ts"), "export const x = 1;");
      await run(["add", "."], cleanRepo);
      await run(["commit", "-m", "initial"], cleanRepo);

      // Verify the working tree is clean (no uncommitted edits).
      const isClean = !(await hasChanges(cleanRepo));
      expect(isClean).toBe(true);

      // Simulate: turn 1 = commit-failure, turn 2 = no commit (verify skipped, etc.).
      // No later turn committed, so maxCommittedTurn check would NOT drop turn 1.
      // But because the working tree is clean (user ran `git checkout .`), drop it.
      const { commitFailureTurns } = await computeTouchedFilesByTurn([
        { turn: 1, commitSha: undefined, outcome: "commit-failure" },
      ], cleanRepo);

      expect(commitFailureTurns).toEqual([]);
    } finally {
      await rm(cleanRepo, { recursive: true, force: true });
    }
  });
});

describe("hasCommitsAheadOfBase", () => {
  let aheadDir: string;

  beforeAll(async () => {
    aheadDir = await mkdtemp(join(tmpdir(), "adversary-git-ahead-"));
    await gitInit(aheadDir);
    await gitCommit(aheadDir, "initial commit on main");
  });

  afterAll(async () => {
    await rm(aheadDir, { recursive: true, force: true });
  });

  test("returns false when feature branch is same as base", async () => {
    // No commits ahead of main yet — feature branch IS main
    const result = await hasCommitsAheadOfBase(aheadDir, "main", "main");
    expect(result).toBe(false);
  });

  test("returns true when feature branch has commits ahead of base", async () => {
    await createAndCheckoutBranch("feature-test-ahead", aheadDir);
    // Write a unique file so git commit has something to commit
    await writeFile(join(aheadDir, "feature-file.txt"), "feature content");
    const add = Bun.spawn(["git", "add", "."], { cwd: aheadDir, stdout: "pipe", stderr: "pipe" });
    await add.exited;
    const commit = Bun.spawn(["git", "commit", "-m", "feature commit"], { cwd: aheadDir, stdout: "pipe", stderr: "pipe" });
    await commit.exited;
    const result = await hasCommitsAheadOfBase(aheadDir, "feature-test-ahead", "main");
    expect(result).toBe(true);
    // Clean up: go back to main
    await checkoutBranch("main", aheadDir);
  });

  // VI-9: fallback returns true when baseBranch doesn't exist
  test("(VI-9) returns true (fallback) when baseBranch does not exist locally", async () => {
    // Use a nonexistent base branch — git rev-list will fail, triggering the fallback
    // The fallback must return true so we don't suppress PR creation.
    const result = await hasCommitsAheadOfBase(aheadDir, "main", "nonexistent-base-branch-xyz");
    expect(result).toBe(true);
  });
});
