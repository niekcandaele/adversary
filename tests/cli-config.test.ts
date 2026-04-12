import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configCommand } from "../src/cli/config.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";
import { clearGitRootCache } from "../src/config/paths.js";

describe("configCommand", () => {
  let isolatedXdgDir: string;
  let savedXdgConfigHome: string | undefined;

  beforeEach(async () => {
    isolatedXdgDir = await mkdtemp(join(tmpdir(), "adversary-xdg-isolated-"));
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = isolatedXdgDir;
  });

  afterEach(async () => {
    clearGitRootCache();
    if (savedXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    }
    await rm(isolatedXdgDir, { recursive: true, force: true });
  });

  test("prints default config as JSON when no config files exist", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "adversary-cfg-cmd-"));
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
      writes.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      return true;
    });

    try {
      await configCommand({ cwd: projectDir });
      const output = writes.join("");
      const parsed = JSON.parse(output);
      expect(parsed).toEqual(DEFAULT_CONFIG);
    } finally {
      spy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("merges global and project config", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "adversary-cfg-cmd-"));
    // Write global config
    await mkdir(join(isolatedXdgDir, "adversary"), { recursive: true });
    await writeFile(
      join(isolatedXdgDir, "adversary", "config.json"),
      JSON.stringify({ implementTimeoutMs: 11111, prTimeoutMs: 22222 })
    );
    // Write project config that overrides one value
    await writeFile(
      join(projectDir, ".adversary.json"),
      JSON.stringify({ implementTimeoutMs: 99999 })
    );

    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
      writes.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      return true;
    });

    try {
      await configCommand({ cwd: projectDir });
      const parsed = JSON.parse(writes.join(""));
      expect(parsed.implementTimeoutMs).toBe(99999);
      expect(parsed.prTimeoutMs).toBe(22222);
      expect(parsed.verifyTimeoutMs).toBe(DEFAULT_CONFIG.verifyTimeoutMs);
    } finally {
      spy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("respects --config override path", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "adversary-cfg-cmd-"));
    const customPath = join(projectDir, "custom.json");
    await writeFile(customPath, JSON.stringify({ baseBranch: "custom-branch" }));

    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
      writes.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      return true;
    });

    try {
      await configCommand({ cwd: projectDir, configFile: customPath });
      const parsed = JSON.parse(writes.join(""));
      expect(parsed.baseBranch).toBe("custom-branch");
    } finally {
      spy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("output is valid JSON matching AdversaryConfig shape", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "adversary-cfg-cmd-"));
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
      writes.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      return true;
    });

    try {
      await configCommand({ cwd: projectDir });
      const parsed = JSON.parse(writes.join(""));
      // Check all expected keys exist with correct types
      expect(typeof parsed.implementCommandTemplate).toBe("string");
      expect(typeof parsed.verifyCommandTemplate).toBe("string");
      expect(typeof parsed.summarizerCommandTemplate).toBe("string");
      expect(typeof parsed.implementTimeoutMs).toBe("number");
      expect(typeof parsed.verifyTimeoutMs).toBe("number");
      expect(typeof parsed.prTimeoutMs).toBe("number");
      expect(typeof parsed.summarizerTimeoutMs).toBe("number");
    } finally {
      spy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
