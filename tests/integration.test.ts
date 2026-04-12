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
    ["sh", "-c", "echo '.pi-adversary/' > .gitignore && echo 'init' > README.md && git add -A && git commit -m init"],
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

/**
 * Write a fake summarizer script that outputs a valid commit message JSON.
 */
function writeFakeSummarizer(dir: string, name = "fake-summarizer.sh"): string {
  const script = join(dir, name);
  writeFileSync(
    script,
    `#!/bin/sh\necho '{ "commitMessage": "feat: implement plan changes" }'\nexit 0\n`,
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

    const summarizerScript = writeFakeSummarizer(cwd);
    const config: AdversaryConfig = {
      implementCommandTemplate: "true", // no-op implement
      verifyCommandTemplate: `${verifyScript} --output={verifyOutputFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
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

    const summarizerScript2 = writeFakeSummarizer(cwd, "fake-summarizer-2.sh");
    const config: AdversaryConfig = {
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${verifyScript} --output={verifyOutputFile}`,
      summarizerCommandTemplate: summarizerScript2,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
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
      summarizerCommandTemplate: "true",
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
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

    const summarizerScriptVF = writeFakeSummarizer(cwd, "fake-summarizer-vf.sh");
    const config: AdversaryConfig = {
      implementCommandTemplate: "true",
      verifyCommandTemplate: "false", // exits non-zero, writes no JSON
      summarizerCommandTemplate: summarizerScriptVF,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
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

    const summarizerScriptVE = writeFakeSummarizer(cwd, "fake-summarizer-ve.sh");
    const config: AdversaryConfig = {
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${verifyScript} --output={verifyOutputFile}`,
      summarizerCommandTemplate: summarizerScriptVE,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
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

  test("sets summarizer-failure outcome when summarizer exits non-zero", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run-summarizer-fail");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Summarizer Fail\nDo a thing.");

    // Implement script that creates a file (so hasChanges returns true)
    const implScript = join(cwd, "fake-impl-creates-file.sh");
    writeFileSync(
      implScript,
      `#!/bin/sh\necho "change" >> ${join(cwd, "change.txt")}\ngit add -A\nexit 0\n`,
      { mode: 0o755 }
    );

    // Summarizer that exits non-zero
    const failSummarizerScript = join(cwd, "fail-summarizer.sh");
    writeFileSync(
      failSummarizerScript,
      `#!/bin/sh\nexit 1\n`,
      { mode: 0o755 }
    );

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Summarizer Fail",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: implScript,
      verifyCommandTemplate: "true",
      summarizerCommandTemplate: failSummarizerScript,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Summarizer Fail\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("summarizer-failure");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("summarizer-failure");
  });

  test("sets summarizer-failure outcome when summarizer produces invalid JSON", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run-summarizer-invalid");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Summarizer Invalid\nDo a thing.");

    // Implement script that creates a file (so hasChanges returns true)
    const implScript2 = join(cwd, "fake-impl-creates-file-2.sh");
    writeFileSync(
      implScript2,
      `#!/bin/sh\necho "change2" >> ${join(cwd, "change2.txt")}\ngit add -A\nexit 0\n`,
      { mode: 0o755 }
    );

    // Summarizer that outputs non-JSON
    const invalidSummarizerScript = join(cwd, "invalid-summarizer.sh");
    writeFileSync(
      invalidSummarizerScript,
      `#!/bin/sh\necho "not valid json"\nexit 0\n`,
      { mode: 0o755 }
    );

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Summarizer Invalid",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: implScript2,
      verifyCommandTemplate: "true",
      summarizerCommandTemplate: invalidSummarizerScript,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Summarizer Invalid\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("summarizer-failure");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("summarizer-failure");
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

    const summarizerScriptVB = writeFakeSummarizer(cwd, "fake-summarizer-vb.sh");
    const config: AdversaryConfig = {
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${verifyScript} --output={verifyOutputFile}`,
      summarizerCommandTemplate: summarizerScriptVB,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
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

  test("recovers from commit failure caused by pre-commit hook", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run-commit-fail");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Commit Fail\nDo a thing.");

    // Install a pre-commit hook that rejects commits if any file contains HOOK_FAIL_MARKER
    const hookDir = join(cwd, ".git", "hooks");
    writeFileSync(
      join(hookDir, "pre-commit"),
      `#!/bin/sh\nif git diff --cached --name-only | xargs grep -l HOOK_FAIL_MARKER 2>/dev/null; then\n  echo "pre-commit hook: found HOOK_FAIL_MARKER, rejecting commit"\n  exit 1\nfi\nexit 0\n`,
      { mode: 0o755 }
    );

    // Turn 1: implement creates a file with the marker (commit will fail)
    // Turn 2: implement overwrites the file without the marker (commit will succeed)
    // Note: the script must be in .gitignore or outside the repo so the hook doesn't
    // match the marker string inside the script itself.
    const markerFile = join(cwd, "marker.txt");
    const implScript = join(cwd, "fake-impl-commit-fail.sh");
    // Add the script to .gitignore so git add -A won't stage it
    writeFileSync(join(cwd, ".gitignore"), ".pi-adversary/\nfake-*.sh\n");
    writeFileSync(
      implScript,
      `#!/bin/sh\nMARKER="HOOK_FAIL""_MARKER"\nif grep -q "$MARKER" "${markerFile}" 2>/dev/null; then\n  echo "FIXED" > "${markerFile}"\nelse\n  echo "$MARKER" > "${markerFile}"\nfi\nexit 0\n`,
      { mode: 0o755 }
    );

    const verifyScript = writeVerifyJson(cwd, []);
    const summarizerScript = writeFakeSummarizer(cwd, "fake-summarizer-cf.sh");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Commit Fail",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: implScript,
      verifyCommandTemplate: `${verifyScript} --output={verifyOutputFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Commit Fail\nDo a thing.", maxTurns: 3, threshold: 7, config });

    // Turn 1 should be a commit-failure
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]?.outcome).toBe("commit-failure");
    expect(state.turns[0]?.commitError).toBeDefined();
    expect(state.turns[0]?.repoChanged).toBe(true);

    // Turn 2 should recover and succeed
    expect(state.turns[1]?.outcome).toBe("clean");
    expect(state.outcome).toBe("clean");
  });

  test("sets commit-failure outcome when all turns exhausted on hook failure", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".pi-adversary", "runs", "test-run-commit-fail-capped");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Commit Capped\nDo a thing.");

    // Pre-commit hook that always fails
    const hookDir = join(cwd, ".git", "hooks");
    writeFileSync(
      join(hookDir, "pre-commit"),
      `#!/bin/sh\necho "hook always fails"\nexit 1\n`,
      { mode: 0o755 }
    );

    // Implement always creates a file
    const implScript = join(cwd, "fake-impl-always-change.sh");
    writeFileSync(
      implScript,
      `#!/bin/sh\necho "change-$(date +%s%N)" >> ${join(cwd, "changes.txt")}\nexit 0\n`,
      { mode: 0o755 }
    );

    const summarizerScript = writeFakeSummarizer(cwd, "fake-summarizer-cc.sh");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Commit Capped",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      implementCommandTemplate: implScript,
      verifyCommandTemplate: "true",
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 10000,
      verifyTimeoutMs: 10000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Commit Capped\nDo a thing.", maxTurns: 2, threshold: 7, config });

    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]?.outcome).toBe("commit-failure");
    expect(state.turns[1]?.outcome).toBe("commit-failure");
    expect(state.outcome).toBe("commit-failure");
  });
});
