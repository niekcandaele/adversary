import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/index.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "adversary-config-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
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

  test("loads config from file", async () => {
    const configPath = join(tmpDir, ".pi-adversary.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseBranch: "develop",
        implementCommandTemplate: "my-impl {promptFile}",
        implementTimeoutMs: 999,
      })
    );

    const config = await loadConfig(tmpDir);
    expect(config.baseBranch).toBe("develop");
    expect(config.implementCommandTemplate).toBe("my-impl {promptFile}");
    expect(config.implementTimeoutMs).toBe(999);
    // Unset values should use defaults
    expect(config.verifyCommandTemplate).toBe(DEFAULT_CONFIG.verifyCommandTemplate);
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
    const configPath = join(tmpDir, ".pi-adversary-summarizer.json");
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
    const configPath = join(tmpDir, ".pi-adversary-no-summarizer.json");
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
});
