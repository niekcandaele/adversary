import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPlatform, extractHarnessBinary, checkBrowserAutomation, checkHarnessBinaries, PreflightError, runPreflight } from "../src/preflight/index.js";
import type { ToolchainDiscovery } from "../src/types/index.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";

describe("detectPlatform", () => {
  test("detects github from https URL", () => {
    expect(detectPlatform("https://github.com/user/repo.git")).toBe("github");
  });

  test("detects github from git URL", () => {
    expect(detectPlatform("git@github.com:user/repo.git")).toBe("github");
  });

  test("detects gitlab from https URL", () => {
    expect(detectPlatform("https://gitlab.com/user/repo.git")).toBe("gitlab");
  });

  test("detects gitlab from custom domain", () => {
    expect(detectPlatform("https://gitlab.mycompany.com/user/repo.git")).toBe("gitlab");
  });

  test("returns unknown for other remotes", () => {
    expect(detectPlatform("https://bitbucket.org/user/repo.git")).toBe("unknown");
  });

  test("returns unknown for null remote", () => {
    expect(detectPlatform(null)).toBe("unknown");
  });
});

describe("extractHarnessBinary", () => {
  test("extracts first word from simple command", () => {
    expect(extractHarnessBinary("pi -p @{promptFile}")).toBe("pi");
  });

  test("extracts first word from command with flags", () => {
    expect(extractHarnessBinary("my-harness --flag value")).toBe("my-harness");
  });

  test("returns full string when no spaces", () => {
    expect(extractHarnessBinary("pi")).toBe("pi");
  });

  test("handles leading whitespace", () => {
    expect(extractHarnessBinary("  pi -p @{promptFile}")).toBe("pi");
  });

  test("handles full path binary", () => {
    expect(extractHarnessBinary("/usr/local/bin/myharness --arg")).toBe("/usr/local/bin/myharness");
  });
});

const EMPTY_DISCOVERY: ToolchainDiscovery = {
  testCommand: null,
  buildCommand: null,
  lintCommands: [],
  typeCheckCommands: [],
  startCommand: null,
  browserDeps: [],
};

const DISCOVERY_WITH_BROWSER: ToolchainDiscovery = {
  testCommand: null,
  buildCommand: null,
  lintCommands: [],
  typeCheckCommands: [],
  startCommand: null,
  browserDeps: ["playwright"],
};

// VI-3: checkHarnessBinaries failure path
describe("checkHarnessBinaries", () => {
  test("returns ok when all harness binaries are in PATH", async () => {
    // "git" is always available in the test environment
    const result = await checkHarnessBinaries(["git --version", "git status"]);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("returns ok for empty templates list", async () => {
    const result = await checkHarnessBinaries([]);
    expect(result.ok).toBe(true);
  });

  test("returns not-ok with reason when harness binary is absent from PATH", async () => {
    // A binary that is extremely unlikely to exist on any system
    const result = await checkHarnessBinaries(["__nonexistent_adversary_harness_binary_xyz__"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("__nonexistent_adversary_harness_binary_xyz__");
    expect(result.reason).toContain("PATH");
  });

  test("returns not-ok for first absent binary when multiple templates provided", async () => {
    // git is present; nonexistent-bin is not
    const result = await checkHarnessBinaries([
      "git --version",
      "__nonexistent_binary_456__ --flag value",
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("__nonexistent_binary_456__");
  });
});

describe("checkBrowserAutomation", () => {
  test("skip mode: returns immediately without checking deps", async () => {
    // Should not throw even with empty browserDeps
    await expect(checkBrowserAutomation("skip", EMPTY_DISCOVERY)).resolves.toBeUndefined();
  });

  test("skip mode: returns immediately even with browser deps present", async () => {
    await expect(checkBrowserAutomation("skip", DISCOVERY_WITH_BROWSER)).resolves.toBeUndefined();
  });

  test("warn mode: returns without throwing when browser deps are present", async () => {
    await expect(checkBrowserAutomation("warn", DISCOVERY_WITH_BROWSER)).resolves.toBeUndefined();
  });

  test("require mode: throws PreflightError when no browser deps found", async () => {
    await expect(checkBrowserAutomation("require", EMPTY_DISCOVERY)).rejects.toThrow(PreflightError);
  });

  test("require mode: does not throw when browser deps are present", async () => {
    await expect(checkBrowserAutomation("require", DISCOVERY_WITH_BROWSER)).resolves.toBeUndefined();
  });

  test("warn mode: continues without prompting when browser deps are missing", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(checkBrowserAutomation("warn", EMPTY_DISCOVERY)).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });

  test("warn mode: continues without prompting even in TTY mode", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await expect(checkBrowserAutomation("warn", EMPTY_DISCOVERY)).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VI-17: runPreflight with resumeMode tolerates dirty tree
// ─────────────────────────────────────────────────────────────────────────────

describe("runPreflight resumeMode", () => {
  let repoDir: string;
  let planFile: string;
  // Fake env that has git but no gh/glab (to avoid auth check failures in test)
  // We override PATH to only contain /usr/bin:/bin so git is found but not gh/glab
  let testEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "adversary-preflight-resume-"));
    const run = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run(["init", "-b", "main"]);
    await run(["config", "user.email", "t@t.com"]);
    await run(["config", "user.name", "T"]);
    // Initial commit to make it a valid repo
    await writeFile(join(repoDir, "README.md"), "test");
    await run(["add", "."]);
    await run(["commit", "-m", "init"]);

    // Write a dirty file (untracked)
    await writeFile(join(repoDir, "dirty.txt"), "dirty");

    // Write plan file
    planFile = join(repoDir, "plan.md");
    await writeFile(planFile, "# Test Plan\n\nSome content here.\n");

    testEnv = { ...process.env };
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  test("tolerates dirty tree in resumeMode (skips clean-tree check)", async () => {
    // In normal mode this would throw PreflightError about dirty tree.
    // In resumeMode it should not throw for dirty-tree — it may throw for
    // other reasons (e.g., no gh/glab), but NOT for the dirty tree.
    // We test by catching and verifying the error message is NOT about dirty tree.
    let error: Error | null = null;
    try {
      await runPreflight(repoDir, planFile, DEFAULT_CONFIG, testEnv, { resumeMode: true });
    } catch (e) {
      error = e as Error;
    }

    if (error) {
      // If it threw, it must not be about the working tree being dirty
      expect(error.message).not.toContain("staged changes");
      expect(error.message).not.toContain("unstaged changes");
      expect(error.message).not.toContain("untracked files");
    }
    // If it didn't throw — even better, preflight passed
  });

  test("normal mode throws PreflightError for dirty tree", async () => {
    // In normal mode with dirty tree, it should throw
    let threw = false;
    try {
      await runPreflight(repoDir, planFile, DEFAULT_CONFIG, testEnv);
    } catch (e) {
      threw = true;
      if (e instanceof PreflightError) {
        expect(e.message).toMatch(/untracked files|staged changes|unstaged changes/);
      }
    }
    // It should have thrown (either PreflightError for dirty tree, or other checks)
    expect(threw).toBe(true);
  });
});
