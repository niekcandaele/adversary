/**
 * Tests for the verification orchestrator (src/verify/index.ts)
 * Uses mock harness scripts to verify parallel execution and output collection.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { runVerification } from "../src/verify/index.js";
import type { AdversaryConfig, VerifyScope, ToolchainDiscovery } from "../src/types/index.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "adversary-orch-test-"));
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };
  await run("git", "init", "-b", "main");
  await run("git", "config", "user.email", "test@test.com");
  await run("git", "config", "user.name", "Test");
  await writeFile(join(dir, "README.md"), "# Test");
  const proc = Bun.spawn(["sh", "-c", "git add -A && git commit -m init"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return dir;
}

function writeFakeHarness(
  dir: string,
  name: string,
  opts: { findings?: unknown[]; status?: string } = {}
): string {
  const { findings = [], status = "ok" } = opts;
  const findingsJson = JSON.stringify(findings);
  const verifyStatus = status;
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done

if [ -z "$PROMPT_FILE" ]; then
  echo '{"status":"ok","findings":[]}'
  exit 0
fi

CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")

if echo "$CONTENT" | grep -q "schemaVersion"; then
  echo '{"schemaVersion":1,"status":"${verifyStatus}","findings":${findingsJson}}'
  exit 0
fi

if echo "$CONTENT" | grep -q 'testCommand\\|toolchain discovery'; then
  echo '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"browserDeps":[]}'
  exit 0
fi

echo '{"status":"ok","findings":[]}'
exit 0
`,
    { mode: 0o755 }
  );
  return path;
}

const EMPTY_SCOPE: VerifyScope = {
  baseBranch: "main",
  mergeBase: "deadbeef",
  files: [{ path: "src/test.ts", status: "added" }],
  diffCommand: "git diff --name-status deadbeef...HEAD",
  diffStat: "1 file changed",
};

const EMPTY_DISCOVERY: ToolchainDiscovery = {
  testCommand: null,
  buildCommand: null,
  lintCommands: [],
  typeCheckCommands: [],
  startCommand: null,
  browserDeps: [],
};

describe("runVerification orchestrator", () => {
  let tmpDir: string;
  let cwd: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "adversary-orch-tmp-"));
    cwd = await makeGitRepo();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  test("returns ok report when all skills pass with no findings", async () => {
    const turnDir = join(tmpDir, "turn-1");
    const harness = writeFakeHarness(tmpDir, "fake-harness.sh", { findings: [], status: "ok" });

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("ok");
    expect(Array.isArray(report.findings)).toBe(true);
  }, 120000);

  test("returns findings from synthesis output", async () => {
    const findings = [
      { title: "Critical Bug", severity: 9, description: "Big problem", sources: ["reviewer"] },
    ];
    const turnDir = join(tmpDir, "turn-2");
    const harness = writeFakeHarness(tmpDir, "fake-harness-findings.sh", {
      findings,
      status: "ok",
    });

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.title).toBe("Critical Bug");
    expect(report.findings[0]?.severity).toBe(9);
  }, 120000);

  test("creates verify directory structure", async () => {
    const turnDir = join(tmpDir, "turn-3");
    const harness = writeFakeHarness(tmpDir, "fake-harness-dirs.sh");

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    // Verify directory structure was created
    const verifyDir = join(turnDir, "verify");
    expect(existsSync(verifyDir)).toBe(true);
    expect(existsSync(join(verifyDir, "skills"))).toBe(true);

    // Each skill should have a prompt file
    expect(existsSync(join(verifyDir, "skills", "reviewer.prompt.md"))).toBe(true);
    expect(existsSync(join(verifyDir, "skills", "qa.prompt.md"))).toBe(true);
    expect(existsSync(join(verifyDir, "skills", "tester.prompt.md"))).toBe(true);

    // Synthesis prompt should exist
    expect(existsSync(join(verifyDir, "synthesis.prompt.md"))).toBe(true);

    // Final verify.json should exist
    expect(existsSync(join(turnDir, "verify.json"))).toBe(true);
  }, 120000);

  test("handles blocked synthesis status", async () => {
    const turnDir = join(tmpDir, "turn-blocked");
    const harness = writeFakeHarness(tmpDir, "fake-harness-blocked.sh", {
      findings: [{ title: "Blocked Issue", severity: 9, description: "Cannot proceed", sources: ["qa"] }],
      status: "blocked",
    });

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    expect(report.status).toBe("blocked");
  }, 120000);

  test("uses fallback synthesis when harness outputs invalid JSON", async () => {
    const turnDir = join(tmpDir, "turn-invalid");
    const invalidHarness = join(tmpDir, "invalid-harness.sh");
    writeFileSync(
      invalidHarness,
      `#!/bin/sh\necho "not valid json at all"\nexit 0\n`,
      { mode: 0o755 }
    );

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${invalidHarness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    // Should not throw — falls back to deterministic synthesis
    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    expect(report.schemaVersion).toBe(1);
    expect(["ok", "blocked", "error"]).toContain(report.status);
    expect(Array.isArray(report.findings)).toBe(true);
  }, 120000);

  test("prompt files contain interpolated variables (scopeContext, planContent)", async () => {
    const turnDir = join(tmpDir, "turn-interp");
    const harness = writeFakeHarness(tmpDir, "fake-harness-interp.sh");

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# My Special Test Plan Content",
      config,
      projectSkills: "## Project Skills\n\nSome skill info",
    });

    // Check that the reviewer prompt has interpolated scope context
    const reviewerPromptPath = join(turnDir, "verify", "skills", "reviewer.prompt.md");
    expect(existsSync(reviewerPromptPath)).toBe(true);

    const reviewerContent = await Bun.file(reviewerPromptPath).text();

    // scopeContext should be interpolated — contains the changed file
    expect(reviewerContent).toContain("src/test.ts");

    // projectSkills should be interpolated in reviewer prompt
    expect(reviewerContent).toContain("Some skill info");

    // No un-interpolated {scopeContext} or {projectSkills} placeholders remain
    expect(reviewerContent).not.toContain("{scopeContext}");
    expect(reviewerContent).not.toContain("{projectSkills}");

    // Check plan-completeness prompt for planContent interpolation
    const planPromptPath = join(turnDir, "verify", "skills", "plan-completeness.prompt.md");
    expect(existsSync(planPromptPath)).toBe(true);

    const planContent = await Bun.file(planPromptPath).text();
    // planContent should be interpolated in plan-completeness prompt
    expect(planContent).toContain("My Special Test Plan Content");
    expect(planContent).not.toContain("{planContent}");
  }, 120000);

  test("custom sequential steps run after phase 1 skills", async () => {
    const turnDir = join(tmpDir, "turn-custom-seq");
    const mainHarness = writeFakeHarness(tmpDir, "fake-harness-seq-main.sh");

    // Custom sequential step that outputs a specific finding
    const seqHarness = join(tmpDir, "custom-seq-step.sh");
    writeFileSync(
      seqHarness,
      `#!/bin/sh\necho '{"status":"ok","findings":[{"title":"Sequential Finding","severity":6,"description":"From sequential step","sources":["my-seq-check"]}]}'\nexit 0\n`,
      { mode: 0o755 }
    );

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${mainHarness} @{promptFile}`,
      verifyTimeoutMs: 30000,
      customVerificationSteps: [
        {
          name: "my-seq-check",
          commandTemplate: `${seqHarness}`,
          phase: "sequential",
          timeoutMs: 10000,
        },
      ],
    };

    await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    // Custom sequential step output file should exist
    const seqOutputPath = join(turnDir, "verify", "skills", "my-seq-check.stdout.log");
    expect(existsSync(seqOutputPath)).toBe(true);

    // The output.json should also exist
    const seqOutputJsonPath = join(turnDir, "verify", "skills", "my-seq-check.output.json");
    expect(existsSync(seqOutputJsonPath)).toBe(true);
  }, 120000);

  test("skill template load failure produces error SkillResult (VI-20)", async () => {
    // Use a skillOverride pointing to a non-existent promptFile for the reviewer skill.
    // runSkill should catch the load error and return status="error" rather than throwing.
    const turnDir = join(tmpDir, "turn-skill-load-fail");
    const harness = writeFakeHarness(tmpDir, "fake-harness-skill-fail.sh");

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
      skillOverrides: {
        reviewer: {
          promptFile: "/nonexistent/path/that/does/not/exist.md",
        },
      },
    };

    // runVerification should not throw — skill failure is gracefully handled
    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    // Should still complete; reviewer's error SkillResult contributes 0 findings via synthesis
    expect(report.schemaVersion).toBe(1);
    expect(["ok", "blocked", "error"]).toContain(report.status);
    expect(Array.isArray(report.findings)).toBe(true);
  }, 120000);

  test("synthesis template load failure falls back to deterministic synthesis (VI-21)", async () => {
    // Use a skillOverride for "synthesis" pointing to a non-existent file.
    // runSynthesis should catch the load error and fall back to synthesizeFallback().
    const turnDir = join(tmpDir, "turn-synthesis-fail");
    const harness = writeFakeHarness(tmpDir, "fake-harness-syn-fail.sh", {
      findings: [{ title: "Test Finding", severity: 5, description: "A finding for fallback", sources: ["reviewer"] }],
      status: "ok",
    });

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
      skillOverrides: {
        synthesis: {
          promptFile: "/nonexistent/synthesis-template-does-not-exist.md",
        },
      },
    };

    // Should not throw — synthesis fallback is used when template load fails
    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    // Fallback should produce a valid report
    expect(report.schemaVersion).toBe(1);
    expect(["ok", "blocked", "error"]).toContain(report.status);
    expect(Array.isArray(report.findings)).toBe(true);
  }, 120000);

  test("runVerification throws when turnDir cannot be created (e.g. path is an existing file)", async () => {
    // Write a file at the turnDir path so mkdir fails with ENOTDIR
    const conflictPath = join(tmpDir, "turn-conflict");
    writeFileSync(conflictPath, "I am a file, not a directory");

    const harness = writeFakeHarness(tmpDir, "fake-harness-throw.sh");
    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    // runVerification should throw because it can't create subdirs under a file path
    await expect(
      runVerification({
        cwd,
        turnDir: conflictPath, // this is a file, not a directory
        scope: EMPTY_SCOPE,
        discovery: EMPTY_DISCOVERY,
        planContent: "# Test Plan",
        config,
        projectSkills: "",
      })
    ).rejects.toThrow();
  }, 30000);

  // VI-5: synthesis returns valid JSON but with wrong schema — fallback must be used
  test("synthesis valid JSON with wrong schemaVersion falls back to deterministic synthesis", async () => {
    const turnDir = join(tmpDir, "turn-wrong-schema");
    // Harness always returns valid JSON but with wrong schemaVersion for synthesis
    const wrongSchemaHarness = join(tmpDir, "wrong-schema-harness.sh");
    writeFileSync(
      wrongSchemaHarness,
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done

if [ -z "$PROMPT_FILE" ]; then
  echo '{"status":"ok","findings":[]}'
  exit 0
fi

CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")

if echo "$CONTENT" | grep -q "schemaVersion"; then
  # Return valid JSON but with wrong schemaVersion — should trigger fallback
  echo '{"schemaVersion":99,"status":"ok","findings":[]}'
  exit 0
fi

if echo "$CONTENT" | grep -q 'testCommand\\|toolchain discovery'; then
  echo '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"browserDeps":[]}'
  exit 0
fi

echo '{"status":"completed","findings":[]}'
exit 0
`,
      { mode: 0o755 }
    );

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${wrongSchemaHarness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    // Should not throw — deterministic fallback is used when synthesis schema is wrong
    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    // Fallback produces a valid report
    expect(report.schemaVersion).toBe(1);
    expect(["ok", "blocked", "error"]).toContain(report.status);
    expect(Array.isArray(report.findings)).toBe(true);
  }, 120000);

  // VI-5: synthesis returns valid JSON with invalid status — fallback must be used
  test("synthesis valid JSON with invalid status falls back to deterministic synthesis", async () => {
    const turnDir = join(tmpDir, "turn-invalid-status");
    const invalidStatusHarness = join(tmpDir, "invalid-status-harness.sh");
    writeFileSync(
      invalidStatusHarness,
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done

if [ -z "$PROMPT_FILE" ]; then
  echo '{"status":"ok","findings":[]}'
  exit 0
fi

CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")

if echo "$CONTENT" | grep -q "schemaVersion"; then
  # Return valid JSON with correct schemaVersion but invalid status — should trigger fallback
  echo '{"schemaVersion":1,"status":"unknown-invalid-status","findings":[]}'
  exit 0
fi

if echo "$CONTENT" | grep -q 'testCommand\\|toolchain discovery'; then
  echo '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"browserDeps":[]}'
  exit 0
fi

echo '{"status":"completed","findings":[]}'
exit 0
`,
      { mode: 0o755 }
    );

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${invalidStatusHarness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    const report = await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    // Fallback produces a valid report with schemaVersion 1
    expect(report.schemaVersion).toBe(1);
    expect(["ok", "blocked", "error"]).toContain(report.status);
  }, 120000);

  test("custom parallel steps are run alongside builtin skills", async () => {
    const turnDir = join(tmpDir, "turn-custom");
    const harness = writeFakeHarness(tmpDir, "fake-harness-custom.sh");

    // Custom step that outputs a finding
    const customHarness = join(tmpDir, "custom-step.sh");
    writeFileSync(
      customHarness,
      `#!/bin/sh\necho '{"status":"ok","findings":[{"title":"Custom Finding","severity":3,"description":"Custom check","sources":["my-custom-check"]}]}'\nexit 0\n`,
      { mode: 0o755 }
    );

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
      customVerificationSteps: [
        {
          name: "my-custom-check",
          commandTemplate: `${customHarness}`,
          phase: "parallel",
          timeoutMs: 10000,
        },
      ],
    };

    await runVerification({
      cwd,
      turnDir,
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    // Custom step prompt file should be created in skills dir
    expect(existsSync(join(turnDir, "verify", "skills", "my-custom-check.stdout.log"))).toBe(true);
  }, 120000);
});
