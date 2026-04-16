import { test, expect, describe } from "bun:test";
import { detectPlatform, extractHarnessBinary, checkBrowserAutomation, checkHarnessBinaries, PreflightError } from "../src/preflight/index.js";
import type { ToolchainDiscovery } from "../src/types/index.js";

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
