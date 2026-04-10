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
    expect(config.implementTimeoutMs).toBe(DEFAULT_CONFIG.implementTimeoutMs);
    expect(config.verifyTimeoutMs).toBe(DEFAULT_CONFIG.verifyTimeoutMs);
    expect(config.prTimeoutMs).toBe(DEFAULT_CONFIG.prTimeoutMs);
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
});
