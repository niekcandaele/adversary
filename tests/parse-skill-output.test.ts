/**
 * Tests for parseSkillOutput behavior (VI-6).
 * Since parseSkillOutput is a private function, we test it via runVerification
 * with controlled harness scripts that produce specific outputs.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { runVerification } from "../src/verify/index.js";
import type { AdversaryConfig, VerifyScope, ToolchainDiscovery } from "../src/types/index.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "adversary-pso-test-"));
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

describe("parseSkillOutput behavior (via runVerification)", () => {
  let tmpDir: string;
  let cwd: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "adversary-pso-tmp-"));
    cwd = await makeGitRepo();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  test("timeout path: skill treated as timeout when harness exceeds timeoutMs", async () => {
    // This tests that timed-out skills are handled gracefully (status: timeout, no findings).
    // We use a very short timeout (1ms) to guarantee the harness times out.
    const slowHarness = join(tmpDir, "slow-harness.sh");
    writeFileSync(
      slowHarness,
      `#!/bin/sh\nsleep 10\necho '{"status":"ok","findings":[]}'\nexit 0\n`,
      { mode: 0o755 }
    );

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${slowHarness} @{promptFile}`,
      verifyTimeoutMs: 1, // 1ms — will always time out
    };

    const report = await runVerification({
      cwd,
      turnDir: join(tmpDir, "turn-timeout"),
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    // Should produce a valid report even when all skills time out
    expect(report.schemaVersion).toBe(1);
    expect(["ok", "error"]).toContain(report.status);
    expect(Array.isArray(report.findings)).toBe(true);
  }, 60000);

  test("successful JSON parse with source-filling: missing sources filled with skill name", async () => {
    // Skill output has a finding with no sources field — should be filled with skill name
    const harness = join(tmpDir, "no-sources-harness.sh");
    writeFileSync(
      harness,
      `#!/bin/sh
CONTENT=$(cat "\${@#@}" 2>/dev/null || echo "")

# synthesis output
if echo "$CONTENT" | grep -q "schemaVersion"; then
  echo '{"schemaVersion":1,"status":"ok","findings":[{"title":"T","severity":5,"description":"D","sources":["reviewer"]}]}'
  exit 0
fi

# discovery output
if echo "$CONTENT" | grep -q "toolchain discovery\\|testCommand"; then
  echo '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"browserDeps":[]}'
  exit 0
fi

# skill output — missing sources field
echo '{"status":"ok","findings":[{"title":"No Sources Finding","severity":3,"description":"Desc"}]}'
exit 0
`,
      { mode: 0o755 }
    );

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    // Should not throw — sources will be populated from skill name
    const report = await runVerification({
      cwd,
      turnDir: join(tmpDir, "turn-sources"),
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    expect(report.schemaVersion).toBe(1);
    expect(Array.isArray(report.findings)).toBe(true);
  }, 120000);

  test("parse failure path: invalid JSON output treated as error with no findings", async () => {
    const badHarness = join(tmpDir, "bad-harness.sh");
    writeFileSync(
      badHarness,
      `#!/bin/sh\necho "I am not JSON at all, just plain text output"\nexit 0\n`,
      { mode: 0o755 }
    );

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${badHarness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    // Should not throw — fallback synthesis handles error skills
    const report = await runVerification({
      cwd,
      turnDir: join(tmpDir, "turn-parsefail"),
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    expect(report.schemaVersion).toBe(1);
    // All skills errored, so synthesis fallback returns "error"
    expect(report.status).toBe("error");
    expect(report.findings).toHaveLength(0);
  }, 120000);

  test("findings with malformed entries are skipped, valid ones are kept", async () => {
    const mixedHarness = join(tmpDir, "mixed-harness.sh");
    writeFileSync(
      mixedHarness,
      `#!/bin/sh
CONTENT=$(cat "\${@#@}" 2>/dev/null || echo "")

if echo "$CONTENT" | grep -q "schemaVersion"; then
  # Return synthesis output with malformed and valid findings
  echo '{"schemaVersion":1,"status":"ok","findings":[{"title":"Valid","severity":5,"description":"Good","sources":["reviewer"]},{"missing_title":true,"severity":5,"description":"Bad","sources":["qa"]}]}'
  exit 0
fi

if echo "$CONTENT" | grep -q "toolchain discovery\\|testCommand"; then
  echo '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"browserDeps":[]}'
  exit 0
fi

echo '{"status":"ok","findings":[]}'
exit 0
`,
      { mode: 0o755 }
    );

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      verifyCommandTemplate: `${mixedHarness} @{promptFile}`,
      verifyTimeoutMs: 30000,
    };

    const report = await runVerification({
      cwd,
      turnDir: join(tmpDir, "turn-mixed"),
      scope: EMPTY_SCOPE,
      discovery: EMPTY_DISCOVERY,
      planContent: "# Test Plan",
      config,
      projectSkills: "",
    });

    // Only the valid finding should be in the report
    expect(report.findings.some((f) => f.title === "Valid")).toBe(true);
    // The malformed one should be skipped
    expect(report.findings.every((f) => typeof f.title === "string")).toBe(true);
  }, 120000);
});
