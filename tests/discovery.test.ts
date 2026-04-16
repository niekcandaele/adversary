/**
 * Tests for src/discovery/index.ts
 * Covers VI-11 (normalizeDiscovery) and VI-18 (discoverProjectSkills).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import {
  cacheRepoGuidance,
  discoverProjectSkills,
  discoverRepoDocs,
  normalizeDiscovery,
  getCachedProjectSkills,
  getCachedRepoGuidance,
  runDiscovery,
} from "../src/discovery/index.js";
import { writeFileSync } from "node:fs";
import type { AdversaryConfig, VerifyScope } from "../src/types/index.js";

describe("discoverProjectSkills", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "adversary-disc-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty string when no skill directories exist", async () => {
    const result = await discoverProjectSkills(tmpDir);
    expect(result).toBe("");
  });

  test("discovers SKILL.md in .claude/skills/", async () => {
    const skillDir = join(tmpDir, ".claude", "skills", "my-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# My Skill\n\nThis is my skill content.");

    const result = await discoverProjectSkills(tmpDir);
    expect(result).toContain("My Skill");
    expect(result).toContain("This is my skill content.");
    expect(result).toContain("## Project Skills");
  });

  test("discovers SKILL.md in .pi/skills/", async () => {
    const skillDir = join(tmpDir, ".pi", "skills", "pi-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Pi Skill Content");

    const result = await discoverProjectSkills(tmpDir);
    expect(result).toContain("Pi Skill Content");
  });

  test("discovers skills from both .claude/skills/ and .pi/skills/", async () => {
    const claudeSkillDir = join(tmpDir, ".claude", "skills", "skill-a");
    await mkdir(claudeSkillDir, { recursive: true });
    await writeFile(join(claudeSkillDir, "SKILL.md"), "# Skill A");

    const piSkillDir = join(tmpDir, ".pi", "skills", "skill-b");
    await mkdir(piSkillDir, { recursive: true });
    await writeFile(join(piSkillDir, "SKILL.md"), "# Skill B");

    const result = await discoverProjectSkills(tmpDir);
    expect(result).toContain("Skill A");
    expect(result).toContain("Skill B");
  });

  test("returns empty string when skill dirs exist but contain no SKILL.md", async () => {
    const skillDir = join(tmpDir, ".claude", "skills", "empty-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "README.txt"), "Not a skill file");

    const result = await discoverProjectSkills(tmpDir);
    expect(result).toBe("");
  });

  test("handles multiple SKILL.md files in .claude/skills/", async () => {
    for (const name of ["skill-x", "skill-y", "skill-z"]) {
      const dir = join(tmpDir, ".claude", "skills", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `# ${name.toUpperCase()}`);
    }

    const result = await discoverProjectSkills(tmpDir);
    expect(result).toContain("SKILL-X");
    expect(result).toContain("SKILL-Y");
    expect(result).toContain("SKILL-Z");
  });
});

describe("discoverRepoDocs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "adversary-repodocs-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty string when no repo docs exist", async () => {
    const result = await discoverRepoDocs(tmpDir);
    expect(result).toBe("");
  });

  test("includes AGENTS.md and CLAUDE.md when present", async () => {
    await writeFile(join(tmpDir, "AGENTS.md"), "# Agents\nUse the house style.");
    await writeFile(join(tmpDir, "CLAUDE.md"), "# Claude\nCheck repo conventions.");

    const result = await discoverRepoDocs(tmpDir);
    expect(result).toContain("## Repo Docs");
    expect(result).toContain("AGENTS.md");
    expect(result).toContain("Use the house style.");
    expect(result).toContain("CLAUDE.md");
    expect(result).toContain("Check repo conventions.");
  });
});

describe("normalizeDiscovery", () => {
  test("non-object input returns fallback discovery", () => {
    const result = normalizeDiscovery("a string");
    expect(result.testCommand).toBeNull();
    expect(result.lintCommands).toEqual([]);
  });

  test("null input returns fallback discovery", () => {
    const result = normalizeDiscovery(null);
    expect(result.testCommand).toBeNull();
    expect(result.browserDeps).toEqual([]);
  });

  test("array input returns fallback discovery", () => {
    const result = normalizeDiscovery(["a", "b"]);
    expect(result.testCommand).toBeNull();
    expect(result.typeCheckCommands).toEqual([]);
  });

  test("mixed-type arrays are filtered to strings only", () => {
    const result = normalizeDiscovery({
      lintCommands: ["eslint .", 42, null, "tsc --noEmit", true],
      browserDeps: [123, "playwright"],
    });
    expect(result.lintCommands).toEqual(["eslint .", "tsc --noEmit"]);
    expect(result.browserDeps).toEqual(["playwright"]);
  });

  test("missing fields default to null/empty", () => {
    const result = normalizeDiscovery({});
    expect(result.testCommand).toBeNull();
    expect(result.buildCommand).toBeNull();
    expect(result.startCommand).toBeNull();
    expect(result.lintCommands).toEqual([]);
    expect(result.typeCheckCommands).toEqual([]);
    expect(result.browserDeps).toEqual([]);
  });

  test("valid complete object is extracted correctly", () => {
    const result = normalizeDiscovery({
      testCommand: "bun test",
      buildCommand: "bun build",
      lintCommands: ["eslint ."],
      typeCheckCommands: ["tsc --noEmit"],
      startCommand: "bun run dev",
      browserDeps: ["playwright"],
    });
    expect(result.testCommand).toBe("bun test");
    expect(result.buildCommand).toBe("bun build");
    expect(result.lintCommands).toEqual(["eslint ."]);
    expect(result.typeCheckCommands).toEqual(["tsc --noEmit"]);
    expect(result.startCommand).toBe("bun run dev");
    expect(result.browserDeps).toEqual(["playwright"]);
  });
});

// VI-8: cached repo guidance tests
describe("cached repo guidance", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "adversary-cache-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty string when cache file does not exist", async () => {
    expect(await getCachedProjectSkills(tmpDir)).toBe("");
    expect(await getCachedRepoGuidance(tmpDir)).toBe("");
  });

  test("returns cached content when cache files exist", async () => {
    const cacheContent = "## Project Skills\n\n### .claude/skills/my-skill/SKILL.md\n\n# My Skill\nDo things.";
    const repoGuidance = `${cacheContent}\n\n---\n\n## Repo Docs\n\n### AGENTS.md\n\nFollow the repo rules.`;
    await writeFile(join(tmpDir, "projectSkills.txt"), cacheContent);
    await writeFile(join(tmpDir, "repoGuidance.txt"), repoGuidance);
    expect(await getCachedProjectSkills(tmpDir)).toBe(cacheContent);
    expect(await getCachedRepoGuidance(tmpDir)).toBe(repoGuidance);
  });

  test("cacheRepoGuidance writes both project skills and repo guidance", async () => {
    await mkdir(join(tmpDir, ".claude", "skills", "my-skill"), { recursive: true });
    await writeFile(join(tmpDir, ".claude", "skills", "my-skill", "SKILL.md"), "# My Skill\nFollow the skill.");
    await writeFile(join(tmpDir, "AGENTS.md"), "# Agents\nFollow the docs.");

    const result = await cacheRepoGuidance(tmpDir, tmpDir);
    expect(result.projectSkills).toContain("My Skill");
    expect(result.repoGuidance).toContain("My Skill");
    expect(result.repoGuidance).toContain("Follow the docs.");
    expect(await getCachedProjectSkills(tmpDir)).toContain("My Skill");
    expect(await getCachedRepoGuidance(tmpDir)).toContain("Follow the docs.");
  });
});

// VI-9: runDiscovery unit tests
describe("runDiscovery", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "adversary-rundiscovery-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const EMPTY_SCOPE: VerifyScope = {
    baseBranch: "main",
    mergeBase: "deadbeef",
    files: [],
    diffCommand: "git diff --name-status deadbeef...HEAD",
    diffStat: "",
  };

  function makeConfig(harnessScript: string): AdversaryConfig {
    return {
      implementCommandTemplate: "true",
      verifyCommandTemplate: harnessScript,
      summarizerCommandTemplate: "true",
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      testTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
      browserAutomation: "warn",
      customVerificationSteps: [],
      skillOverrides: {},
    };
  }

  test("returns cached discovery on second call without re-running harness", async () => {
    // Pre-populate the cache
    const cachedDiscovery = {
      testCommand: "bun test",
      buildCommand: null,
      lintCommands: [],
      typeCheckCommands: [],
      startCommand: null,
      browserDeps: [],
    };
    await writeFile(join(tmpDir, "discovery.json"), JSON.stringify(cachedDiscovery));
    await writeFile(join(tmpDir, "projectSkills.txt"), "## Project Skills\n\nAlready cached.");
    await writeFile(join(tmpDir, "repoGuidance.txt"), "## Repo Docs\n\nAlready cached.");

    // Harness that would fail if actually invoked
    const config = makeConfig("false");
    const result = await runDiscovery({
      cwd: tmpDir,
      scope: EMPTY_SCOPE,
      config,
      runDir: tmpDir,
      turnDir: tmpDir,
    });

    expect(result.testCommand).toBe("bun test");
  });

  test("falls back to empty discovery when harness output is not parseable JSON", async () => {
    const turnDir = join(tmpDir, "turn-1");
    await mkdir(turnDir, { recursive: true });
    const runDir = join(tmpDir, "run");
    await mkdir(runDir, { recursive: true });

    // Harness echoes non-JSON
    const script = join(tmpDir, "bad-harness.sh");
    writeFileSync(script, "#!/bin/sh\necho 'not json'\nexit 0\n", { mode: 0o755 });

    const config = makeConfig(script);
    const result = await runDiscovery({
      cwd: tmpDir,
      scope: EMPTY_SCOPE,
      config,
      runDir,
      turnDir,
    });

    // Should return empty discovery, not throw
    expect(result.testCommand).toBeNull();
    expect(result.buildCommand).toBeNull();
    expect(result.lintCommands).toEqual([]);
    expect(result.browserDeps).toEqual([]);
  });

  test("returns and caches valid discovery from harness output", async () => {
    const turnDir = join(tmpDir, "turn-1");
    await mkdir(turnDir, { recursive: true });
    const runDir = join(tmpDir, "run");
    await mkdir(runDir, { recursive: true });

    const discoveryOutput = JSON.stringify({
      testCommand: "bun test",
      buildCommand: "bun build",
      lintCommands: ["bunx eslint ."],
      typeCheckCommands: ["bunx tsc --noEmit"],
      startCommand: null,
      browserDeps: [],
    });

    const script = join(tmpDir, "good-harness.sh");
    writeFileSync(script, `#!/bin/sh\necho '${discoveryOutput}'\nexit 0\n`, { mode: 0o755 });

    const config = makeConfig(script);
    const result = await runDiscovery({
      cwd: tmpDir,
      scope: EMPTY_SCOPE,
      config,
      runDir,
      turnDir,
    });

    expect(result.testCommand).toBe("bun test");
    expect(result.buildCommand).toBe("bun build");
    expect(result.lintCommands).toEqual(["bunx eslint ."]);

    // Cache file should now exist
    const cacheExists = (await Bun.file(join(runDir, "discovery.json")).exists());
    expect(cacheExists).toBe(true);
    expect(await Bun.file(join(runDir, "projectSkills.txt")).exists()).toBe(true);
    expect(await Bun.file(join(runDir, "repoGuidance.txt")).exists()).toBe(true);
  });

  // VI-10: gatherProjectStructure truncation path
  test("gatherProjectStructure truncates file listing at 500 entries and adds truncation message", async () => {
    const projectDir = join(tmpDir, "big-project");
    const runDir = join(tmpDir, "run-big");
    const turnDir = join(tmpDir, "turn-big");
    await mkdir(projectDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await mkdir(turnDir, { recursive: true });

    // Create 501 files (> MAX_FILE_ENTRIES = 500) so truncation triggers
    const filesDir = join(projectDir, "src");
    await mkdir(filesDir, { recursive: true });
    for (let i = 0; i < 501; i++) {
      await writeFile(join(filesDir, `file-${String(i).padStart(4, "0")}.ts`), `// file ${i}`);
    }

    // Use a harness that just outputs valid discovery JSON
    const script = join(tmpDir, "disc-harness.sh");
    writeFileSync(
      script,
      `#!/bin/sh\necho '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"browserDeps":[]}'\nexit 0\n`,
      { mode: 0o755 }
    );

    const config = makeConfig(script);
    await runDiscovery({
      cwd: projectDir,
      scope: EMPTY_SCOPE,
      config,
      runDir,
      turnDir,
    });

    // The discovery prompt should contain the truncation message
    const promptPath = join(turnDir, "verify", "discovery.prompt.md");
    const promptContent = await Bun.file(promptPath).text();
    expect(promptContent).toContain("more files truncated");
  }, 30000);
});
