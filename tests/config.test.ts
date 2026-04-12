import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config/index.js";
import { getGlobalConfigPath, getStateDir, clearGitRootCache } from "../src/config/paths.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "adversary-config-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  let savedXdgConfigHomeForDefaults: string | undefined;
  let isolatedXdgDir: string;

  beforeEach(async () => {
    // Isolate from any real global config by pointing XDG_CONFIG_HOME to an empty temp dir
    isolatedXdgDir = await mkdtemp(join(tmpdir(), "adversary-xdg-isolated-"));
    savedXdgConfigHomeForDefaults = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = isolatedXdgDir;
  });

  afterEach(async () => {
    clearGitRootCache();
    if (savedXdgConfigHomeForDefaults === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHomeForDefaults;
    }
    await rm(isolatedXdgDir, { recursive: true, force: true });
  });

  test("returns defaults when no config file", async () => {
    const config = await loadConfig(tmpDir);
    expect(config.implementCommandTemplate).toBe(DEFAULT_CONFIG.implementCommandTemplate);
    expect(config.verifyCommandTemplate).toBe(DEFAULT_CONFIG.verifyCommandTemplate);
    expect(config.summarizerCommandTemplate).toBe(DEFAULT_CONFIG.summarizerCommandTemplate);
    expect(config.implementTimeoutMs).toBe(DEFAULT_CONFIG.implementTimeoutMs);
    expect(config.verifyTimeoutMs).toBe(DEFAULT_CONFIG.verifyTimeoutMs);
    expect(config.prTimeoutMs).toBe(DEFAULT_CONFIG.prTimeoutMs);
    expect(config.summarizerTimeoutMs).toBe(DEFAULT_CONFIG.summarizerTimeoutMs);
  });

  test("loads config from .adversary.json", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "adversary-config-proj-"));
    try {
      const configPath = join(testDir, ".adversary.json");
      await writeFile(
        configPath,
        JSON.stringify({
          baseBranch: "develop",
          implementCommandTemplate: "my-impl {promptFile}",
          implementTimeoutMs: 999,
        })
      );

      const config = await loadConfig(testDir);
      expect(config.baseBranch).toBe("develop");
      expect(config.implementCommandTemplate).toBe("my-impl {promptFile}");
      expect(config.implementTimeoutMs).toBe(999);
      // Unset values should use defaults
      expect(config.verifyCommandTemplate).toBe(DEFAULT_CONFIG.verifyCommandTemplate);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("loads from explicit path", async () => {
    const configPath = join(tmpDir, "custom-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseBranch: "custom",
      })
    );

    const config = await loadConfig(tmpDir, configPath);
    expect(config.baseBranch).toBe("custom");
  });

  test("throws on malformed JSON", async () => {
    const badConfigPath = join(tmpDir, "bad-config.json");
    await writeFile(badConfigPath, "{ not valid json }");

    expect(loadConfig(tmpDir, badConfigPath)).rejects.toThrow();
  });

  test("loads summarizerCommandTemplate from file", async () => {
    const configPath = join(tmpDir, "adversary-summarizer.json");
    await writeFile(
      configPath,
      JSON.stringify({
        summarizerCommandTemplate: "my-summarizer -p @{promptFile}",
        summarizerTimeoutMs: 60000,
      })
    );

    const config = await loadConfig(tmpDir, configPath);
    expect(config.summarizerCommandTemplate).toBe("my-summarizer -p @{promptFile}");
    expect(config.summarizerTimeoutMs).toBe(60000);
  });

  test("summarizerCommandTemplate defaults when not in file", async () => {
    const configPath = join(tmpDir, "adversary-no-summarizer.json");
    await writeFile(
      configPath,
      JSON.stringify({
        implementCommandTemplate: "custom-impl",
      })
    );

    const config = await loadConfig(tmpDir, configPath);
    expect(config.summarizerCommandTemplate).toBe(DEFAULT_CONFIG.summarizerCommandTemplate);
    expect(config.summarizerTimeoutMs).toBe(DEFAULT_CONFIG.summarizerTimeoutMs);
  });

  test("loadConfig reads .adversary.json from git root when called from subdirectory", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "adversary-gitroot-loadconfig-"));
    try {
      // Initialize a real git repo
      spawnSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });

      // Write .adversary.json at the repo root with a distinct baseBranch
      const distinctBranch = "feature/from-git-root";
      await writeFile(join(repoDir, ".adversary.json"), JSON.stringify({ baseBranch: distinctBranch }));

      // Create a subdirectory inside the repo
      const subDir = join(repoDir, "src", "nested");
      await mkdir(subDir, { recursive: true });

      // loadConfig from the subdirectory should pick up the config at repo root
      const config = await loadConfig(subDir);
      expect(config.baseBranch).toBe(distinctBranch);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("emits warning and returns defaults when only .pi-adversary.json exists", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "adversary-legacy-test-"));
    const stderrWrites: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((msg: string | Uint8Array) => {
      stderrWrites.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      return true;
    });
    try {
      await writeFile(join(testDir, ".pi-adversary.json"), JSON.stringify({ baseBranch: "legacy" }));
      const config = await loadConfig(testDir);
      // Returns DEFAULT_CONFIG (global merged, no per-project .adversary.json)
      expect(config).toEqual({ ...DEFAULT_CONFIG });
      // Warning was written to stderr
      const warningOutput = stderrWrites.join("");
      expect(warningOutput).toContain(".pi-adversary.json");
      expect(warningOutput).toContain("your settings will be ignored");
      expect(warningOutput).toContain(".adversary.json");
    } finally {
      spy.mockRestore();
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe("global config merge", () => {
  let xdgConfigDir: string;
  let savedXdgConfigHome: string | undefined;

  beforeEach(async () => {
    // Point XDG_CONFIG_HOME to a temp dir so global config is isolated
    xdgConfigDir = await mkdtemp(join(tmpdir(), "adversary-xdg-config-"));
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgConfigDir;
  });

  afterEach(async () => {
    clearGitRootCache();
    if (savedXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    }
    await rm(xdgConfigDir, { recursive: true, force: true });
  });

  test("global config values are picked up when no per-project config", async () => {
    // Write global config
    const globalConfigPath = join(xdgConfigDir, "adversary", "config.json");
    await mkdir(join(xdgConfigDir, "adversary"), { recursive: true });
    await writeFile(globalConfigPath, JSON.stringify({ implementTimeoutMs: 12345 }));

    // Use a tmpDir with no .adversary.json
    const projectDir = await mkdtemp(join(tmpdir(), "adversary-proj-"));
    try {
      const config = await loadConfig(projectDir);
      expect(config.implementTimeoutMs).toBe(12345);
      // Other fields stay at default
      expect(config.verifyTimeoutMs).toBe(DEFAULT_CONFIG.verifyTimeoutMs);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("per-project config overrides global config", async () => {
    // Write global config
    const globalConfigPath = join(xdgConfigDir, "adversary", "config.json");
    await mkdir(join(xdgConfigDir, "adversary"), { recursive: true });
    await writeFile(globalConfigPath, JSON.stringify({ implementTimeoutMs: 11111, prTimeoutMs: 22222 }));

    // Write per-project config that overrides implementTimeoutMs only
    const projectDir = await mkdtemp(join(tmpdir(), "adversary-proj-"));
    try {
      await writeFile(join(projectDir, ".adversary.json"), JSON.stringify({ implementTimeoutMs: 99999 }));
      const config = await loadConfig(projectDir);
      // Per-project wins
      expect(config.implementTimeoutMs).toBe(99999);
      // Global value for field not in per-project
      expect(config.prTimeoutMs).toBe(22222);
      // Default for field not in either
      expect(config.verifyTimeoutMs).toBe(DEFAULT_CONFIG.verifyTimeoutMs);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("--config (overridePath) overrides global config", async () => {
    const globalConfigPath = join(xdgConfigDir, "adversary", "config.json");
    await mkdir(join(xdgConfigDir, "adversary"), { recursive: true });
    await writeFile(globalConfigPath, JSON.stringify({ prTimeoutMs: 55555 }));

    const projectDir = await mkdtemp(join(tmpdir(), "adversary-proj-"));
    const customConfigPath = join(projectDir, "my-custom.json");
    try {
      await writeFile(customConfigPath, JSON.stringify({ summarizerTimeoutMs: 77777 }));
      const config = await loadConfig(projectDir, customConfigPath);
      // Global value applied
      expect(config.prTimeoutMs).toBe(55555);
      // Override path value applied
      expect(config.summarizerTimeoutMs).toBe(77777);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("XDG path resolution", () => {
  test("getGlobalConfigPath uses XDG_CONFIG_HOME when set", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/custom/xdg/config";
    try {
      const path = getGlobalConfigPath();
      expect(path).toBe("/custom/xdg/config/adversary/config.json");
    } finally {
      if (saved === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = saved;
      }
    }
  });

  test("getGlobalConfigPath falls back to ~/.config when XDG_CONFIG_HOME unset", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const path = getGlobalConfigPath();
      expect(path).toContain(".config/adversary/config.json");
      expect(path).toMatch(/^\/.*\.config\/adversary\/config\.json$/);
      expect(path.startsWith(homedir())).toBe(true);
    } finally {
      if (saved !== undefined) {
        process.env.XDG_CONFIG_HOME = saved;
      }
    }
  });

  test("getStateDir uses XDG_STATE_HOME when set", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/custom/xdg/state";
    try {
      const stateDir = getStateDir("/projects/myrepo");
      expect(stateDir).toContain("/custom/xdg/state/adversary/");
      expect(stateDir).toContain("myrepo-");
    } finally {
      if (saved === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = saved;
      }
    }
  });

  test("getStateDir falls back to ~/.local/state when XDG_STATE_HOME unset", () => {
    const saved = process.env.XDG_STATE_HOME;
    delete process.env.XDG_STATE_HOME;
    try {
      const stateDir = getStateDir("/projects/myrepo");
      expect(stateDir).toContain(".local/state/adversary/");
      expect(stateDir).toContain("myrepo-");
    } finally {
      if (saved !== undefined) {
        process.env.XDG_STATE_HOME = saved;
      }
    }
  });

  test("getStateDir includes basename and 8-char hash", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/state";
    try {
      const stateDir = getStateDir("/projects/my-awesome-repo");
      const dirName = stateDir.split("/").pop()!;
      // Should be "my-awesome-repo-<8hexchars>"
      expect(dirName).toMatch(/^my-awesome-repo-[0-9a-f]{8}$/);
    } finally {
      if (saved === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = saved;
      }
    }
  });

  test("getStateDir produces same hash for same cwd", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/state";
    try {
      const dir1 = getStateDir("/projects/myrepo");
      const dir2 = getStateDir("/projects/myrepo");
      expect(dir1).toBe(dir2);
    } finally {
      if (saved === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = saved;
      }
    }
  });

  test("getStateDir produces different hash for different cwd", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/state";
    try {
      const dir1 = getStateDir("/projects/repo-a");
      const dir2 = getStateDir("/projects/repo-b");
      expect(dir1).not.toBe(dir2);
    } finally {
      if (saved === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = saved;
      }
    }
  });
});

describe("resolveGitRoot via getStateDir", () => {
  let repoDir: string;
  let savedXdgStateHome: string | undefined;

  beforeEach(async () => {
    // Create a real git repo in a temp directory
    repoDir = await mkdtemp(join(tmpdir(), "adversary-gitroot-test-"));
    spawnSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    // Isolate XDG_STATE_HOME so results are predictable
    savedXdgStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(repoDir, ".state");
  });

  afterEach(async () => {
    clearGitRootCache();
    if (savedXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = savedXdgStateHome;
    }
    await rm(repoDir, { recursive: true, force: true });
  });

  test("getStateDir resolves to repo root basename when called from a subdirectory", async () => {
    // Create a subdirectory inside the repo
    const subDir = join(repoDir, "src", "nested");
    await mkdir(subDir, { recursive: true });

    const stateDirFromSub = getStateDir(subDir);
    const stateDirFromRoot = getStateDir(repoDir);

    // Both should use the repo root basename (not the subdirectory name)
    const repoBasename = basename(repoDir);
    expect(stateDirFromSub).toContain(repoBasename);
    expect(stateDirFromRoot).toContain(repoBasename);

    // Both should produce the same result — subdirectory resolves to repo root
    expect(stateDirFromSub).toBe(stateDirFromRoot);
  });

  test("getStateDir from deeply nested subdir also resolves to repo root", async () => {
    const deepDir = join(repoDir, "packages", "core", "src", "utils");
    await mkdir(deepDir, { recursive: true });

    const fromRoot = getStateDir(repoDir);
    const fromDeep = getStateDir(deepDir);

    expect(fromRoot).toBe(fromDeep);
  });
});
