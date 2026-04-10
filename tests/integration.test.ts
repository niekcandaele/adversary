/**
 * Integration test: orchestration flow end-to-end stub
 *
 * Tests the core orchestration pipeline using a fake implement and verify
 * command that completes in one turn with no findings. This exercises:
 * - artifact directory creation
 * - prompt generation
 * - loop termination on clean verify
 * - turn summary writing
 */
import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { runLoop } from "../src/loop/index.js";
import type { RunState, AdversaryConfig } from "../src/types/index.js";
import { buildRunDir, initRunDir, snapshotPlan } from "../src/artifacts/index.js";

async function makeGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "adversary-integration-test-"));
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };
  await run("git", "init", "-b", "main");
  await run("git", "config", "user.email", "test@test.com");
  await run("git", "config", "user.name", "Test");
  const proc = Bun.spawn(
    ["sh", "-c", "echo 'init' > README.md && git add -A && git commit -m init"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;
  await run("git", "checkout", "-b", "adversary/test-branch");
  return dir;
}

function writeVerifyJson(dir: string, findings: unknown[] = []): string {
  const script = join(dir, "fake-verify.sh");
  // Write the JSON to a temp file to avoid shell quoting/interpolation issues
  const jsonFile = join(dir, "fake-verify-output.json");
  writeFileSync(
    jsonFile,
    JSON.stringify({
      schemaVersion: 1,
      status: "ok",
      findings,
    })
  );
  writeFileSync(
    script,
    `#!/bin/sh\n# Extract --output= path from args\nfor arg in "$@"; do\n  case "$arg" in\n    --output=*) OUTPUT="\${arg#*=}" ;;\n  esac\ndone\nif [ -n "$OUTPUT" ]; then\n  cp "${jsonFile}" "$OUTPUT"\nfi\nexit 0\n`,
    { mode: 0o755 }
  );
  return script;
}

describe("runLoop integration", () => {
  test("terminates clean when verify reports zero findings", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan\nDo a thing.");

    // Write a fake verify script that outputs clean JSON
    const verifyScript = writeVerifyJson(cwd, []);

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: "true", // no-op implement
      verifyCommandTemplate: `${verifyScript} --output={verifyOutputFile}`,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("clean");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.thresholdFindings).toHaveLength(0);

    // Verify turn summary was written
    const summaryPath = join(runDir, "turn-1", "turn-summary.json");
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    expect(summary.outcome).toBe("clean");
    expect(summary.turn).toBe(1);
  });

  test("terminates capped when max turns reached with findings remaining", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run-2");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan 2\nDo another thing.");

    // Verify script that always returns one high-severity finding
    const verifyScript = join(cwd, "fake-verify-findings.sh");
    const jsonFile = join(cwd, "fake-verify-findings-output.json");
    writeFileSync(
      jsonFile,
      JSON.stringify({
        schemaVersion: 1,
        status: "ok",
        findings: [{ title: "Bug", severity: 8, description: "Bad", sources: ["reviewer"] }],
      })
    );
    writeFileSync(
      verifyScript,
      `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    --output=*) OUTPUT="\${arg#*=}" ;;\n  esac\ndone\nif [ -n "$OUTPUT" ]; then\n  cp "${jsonFile}" "$OUTPUT"\nfi\nexit 0\n`,
      { mode: 0o755 }
    );

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan 2",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${verifyScript} --output={verifyOutputFile}`,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan 2\nDo another thing.", maxTurns: 2, threshold: 7, config });

    expect(state.outcome).toBe("capped");
    expect(state.turns).toHaveLength(2);
    expect(state.turns[state.turns.length - 1]?.thresholdFindings).toHaveLength(1);
  }, 30000);

  test("sets implement-failure outcome when implement command exits non-zero", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run-impl-fail");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Impl Fail\nDo a thing.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Impl Fail",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: "false", // exits non-zero
      verifyCommandTemplate: "true",
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Impl Fail\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("implement-failure");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("implement-failure");
  });

  test("sets verify-failure outcome when verify JSON is missing after verify command fails", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run-verify-fail");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Verify Fail\nDo a thing.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Verify Fail",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: "true",
      verifyCommandTemplate: "false", // exits non-zero, writes no JSON
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Verify Fail\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("verify-failure");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("verify-failure");
  });

  test("sets verify-error outcome when verify reports status=error with exit code 0", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run-error");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Error\nDo a thing.");

    // Fake verify script that emits status=error with exit code 0
    const jsonFile = join(cwd, "fake-verify-error.json");
    writeFileSync(
      jsonFile,
      JSON.stringify({
        schemaVersion: 1,
        status: "error",
        findings: [
          { title: "Error Issue", severity: 8, description: "Something went wrong", sources: ["reviewer"] },
        ],
      })
    );
    const verifyScript = join(cwd, "fake-verify-error.sh");
    writeFileSync(
      verifyScript,
      `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    --output=*) OUTPUT="\${arg#*=}" ;;\n  esac\ndone\nif [ -n "$OUTPUT" ]; then\n  cp "${jsonFile}" "$OUTPUT"\nfi\nexit 0\n`,
      { mode: 0o755 }
    );

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Error",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${verifyScript} --output={verifyOutputFile}`,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Error\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("verify-error");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("verify-error");
    expect(state.turns[0]?.verifyStatus).toBe("error");
    // findings from error verify should still be recorded
    expect(state.turns[0]?.thresholdFindings).toHaveLength(1);
    expect(state.turns[0]?.thresholdFindings[0]?.title).toBe("Error Issue");
  });

  test("sets verify-blocked outcome when verify reports status=blocked", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run-blocked");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Blocked\nDo a thing.");

    // Fake verify script that emits status=blocked
    const jsonFile = join(cwd, "fake-verify-blocked.json");
    writeFileSync(
      jsonFile,
      JSON.stringify({
        schemaVersion: 1,
        status: "blocked",
        findings: [
          { title: "Blocking Issue", severity: 9, description: "Cannot proceed", sources: ["qa"] },
        ],
      })
    );
    const verifyScript = join(cwd, "fake-verify-blocked.sh");
    writeFileSync(
      verifyScript,
      `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    --output=*) OUTPUT="\${arg#*=}" ;;\n  esac\ndone\nif [ -n "$OUTPUT" ]; then\n  cp "${jsonFile}" "$OUTPUT"\nfi\nexit 0\n`,
      { mode: 0o755 }
    );

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Blocked",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${verifyScript} --output={verifyOutputFile}`,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Blocked\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("verify-blocked");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("verify-blocked");
    expect(state.turns[0]?.verifyStatus).toBe("blocked");
    // findings from blocked verify should still be recorded
    expect(state.turns[0]?.thresholdFindings).toHaveLength(1);
    expect(state.turns[0]?.thresholdFindings[0]?.title).toBe("Blocking Issue");
  });
});
