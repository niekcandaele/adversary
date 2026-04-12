/**
 * Integration test: orchestration flow end-to-end stub
 *
 * Tests the core orchestration pipeline using a fake implement and verify
 * harness that completes in one turn. The new orchestrator calls the
 * verifyCommandTemplate multiple times (once per skill, once for synthesis).
 *
 * This exercises:
 * - artifact directory creation
 * - prompt generation
 * - loop termination on clean verify
 * - turn summary writing
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { runLoop } from "../src/loop/index.js";
import type { RunState, AdversaryConfig } from "../src/types/index.js";
import { buildRunDir, initRunDir, snapshotPlan } from "../src/artifacts/index.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";

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
    ["sh", "-c", "echo 'fake-*.sh' > .gitignore && echo 'init' > README.md && git add -A && git commit -m init"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;
  await run("git", "checkout", "-b", "adversary/test-branch");
  return dir;
}

/**
 * Write a fake harness script for the new multi-skill orchestrator.
 *
 * The harness is called with @{promptFile} where the prompt file contains
 * the skill prompt. The harness detects what kind of output to produce by
 * looking at keywords in the prompt file.
 *
 * - discovery prompt → outputs ToolchainDiscovery JSON
 * - synthesis prompt → outputs full VerifyReport JSON (with schemaVersion)
 * - skill prompts → outputs {"status": "ok", "findings": [...]}
 *
 * If findings are provided, they appear in the synthesis output only.
 */
function writeFakeHarness(
  dir: string,
  name: string,
  findings: unknown[] = [],
  status: string = "ok"
): string {
  const script = join(dir, name);
  const findingsJson = JSON.stringify(findings);
  const verifyStatus = status;

  // The synthesis prompt contains "schemaVersion" — we use that as the signal
  // The discovery prompt contains "testCommand" — we use that as the signal
  writeFileSync(
    script,
    `#!/bin/sh
# Read the prompt file from @... argument
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done

if [ -z "$PROMPT_FILE" ]; then
  # No prompt file - just output skill JSON
  echo '{"status":"completed","findings":[]}'
  exit 0
fi

CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")

# Check if this is the synthesis prompt (contains "schemaVersion")
if echo "$CONTENT" | grep -q "schemaVersion"; then
  echo '{"schemaVersion":1,"status":"${verifyStatus}","findings":${findingsJson}}'
  exit 0
fi

# Check if this is the discovery prompt (contains "testCommand")
if echo "$CONTENT" | grep -q '"testCommand"\\|toolchain discovery'; then
  echo '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"browserDeps":[]}'
  exit 0
fi

# Default: skill prompt - output skill JSON (no findings; synthesis will include them)
echo '{"status":"completed","findings":[]}'
exit 0
`,
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

/**
 * Build a minimal AdversaryConfig for integration tests.
 */
function makeConfig(
  cwd: string,
  opts: {
    implementCommand?: string;
    harness?: string;
    findings?: unknown[];
    verifyStatus?: string;
    summarizerName?: string;
  } = {}
): AdversaryConfig {
  const {
    implementCommand = "true",
    findings = [],
    verifyStatus = "ok",
    summarizerName = "fake-summarizer.sh",
  } = opts;

  let harness = opts.harness;
  if (!harness) {
    harness = writeFakeHarness(cwd, `fake-harness-${summarizerName}.sh`, findings, verifyStatus);
  }
  const summarizerScript = writeFakeSummarizer(cwd, summarizerName);

  return {
    ...DEFAULT_CONFIG,
    implementCommandTemplate: implementCommand,
    verifyCommandTemplate: `${harness} @{promptFile}`,
    summarizerCommandTemplate: summarizerScript,
    implementTimeoutMs: 30000,
    verifyTimeoutMs: 30000,
    prTimeoutMs: 10000,
    summarizerTimeoutMs: 10000,
  };
}

describe("runLoop integration", () => {
  let xdgStateDir: string;
  let savedXdgStateHome: string | undefined;

  beforeEach(async () => {
    xdgStateDir = await mkdtemp(join(tmpdir(), "adversary-xdg-state-"));
    savedXdgStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = xdgStateDir;
  });

  afterEach(async () => {
    if (savedXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = savedXdgStateHome;
    }
    await rm(xdgStateDir, { recursive: true, force: true });
  });

  test("terminates clean when verify reports zero findings", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".test-runs", "test-run");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan\nDo a thing.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config = makeConfig(cwd, { findings: [], verifyStatus: "ok", summarizerName: "fake-summarizer-clean.sh" });

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
  }, 60000);

  test("terminates capped when max turns reached with findings remaining", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".test-runs", "test-run-2");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan 2\nDo another thing.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan 2",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config = makeConfig(cwd, {
      findings: [{ title: "Bug", severity: 8, description: "Bad", sources: ["reviewer"] }],
      verifyStatus: "ok",
      summarizerName: "fake-summarizer-capped.sh",
    });

    await runLoop({ cwd, state, planContent: "# Test Plan 2\nDo another thing.", maxTurns: 2, threshold: 7, config });

    expect(state.outcome).toBe("capped");
    expect(state.turns).toHaveLength(2);
    expect(state.turns[state.turns.length - 1]?.thresholdFindings).toHaveLength(1);
  }, 120000);

  test("sets implement-failure outcome when implement command exits non-zero", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".test-runs", "test-run-impl-fail");
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

    const config = makeConfig(cwd, {
      implementCommand: "false", // exits non-zero
      summarizerName: "fake-summarizer-impl-fail.sh",
    });

    await runLoop({ cwd, state, planContent: "# Test Plan Impl Fail\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("implement-failure");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("implement-failure");
  }, 30000);

  test("sets verify-error outcome when verify reports status=error", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".test-runs", "test-run-error");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Error\nDo a thing.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Error",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config = makeConfig(cwd, {
      findings: [{ title: "Error Issue", severity: 8, description: "Something went wrong", sources: ["reviewer"] }],
      verifyStatus: "error",
      summarizerName: "fake-summarizer-error.sh",
    });

    await runLoop({ cwd, state, planContent: "# Test Plan Error\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("verify-error");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("verify-error");
    expect(state.turns[0]?.verifyStatus).toBe("error");
    // findings from error verify should still be recorded
    expect(state.turns[0]?.thresholdFindings).toHaveLength(1);
    expect(state.turns[0]?.thresholdFindings[0]?.title).toBe("Error Issue");
  }, 60000);

  test("sets summarizer-failure outcome when summarizer exits non-zero", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".test-runs", "test-run-summarizer-fail");
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
    writeFileSync(failSummarizerScript, `#!/bin/sh\nexit 1\n`, { mode: 0o755 });

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Summarizer Fail",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const fakeHarness = writeFakeHarness(cwd, "fake-harness-sumfail.sh");
    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: implScript,
      verifyCommandTemplate: `${fakeHarness} @{promptFile}`,
      summarizerCommandTemplate: failSummarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Summarizer Fail\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("summarizer-failure");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("summarizer-failure");
  }, 30000);

  test("sets summarizer-failure outcome when summarizer produces invalid JSON", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".test-runs", "test-run-summarizer-invalid");
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
    writeFileSync(invalidSummarizerScript, `#!/bin/sh\necho "not valid json"\nexit 0\n`, { mode: 0o755 });

    const fakeHarness2 = writeFakeHarness(cwd, "fake-harness-suminvalid.sh");
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
      ...DEFAULT_CONFIG,
      implementCommandTemplate: implScript2,
      verifyCommandTemplate: `${fakeHarness2} @{promptFile}`,
      summarizerCommandTemplate: invalidSummarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Summarizer Invalid\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("summarizer-failure");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("summarizer-failure");
  }, 30000);

  test("sets verify-blocked outcome when verify reports status=blocked", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".test-runs", "test-run-blocked");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan Blocked\nDo a thing.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan Blocked",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config = makeConfig(cwd, {
      findings: [{ title: "Blocking Issue", severity: 9, description: "Cannot proceed", sources: ["qa"] }],
      verifyStatus: "blocked",
      summarizerName: "fake-summarizer-blocked.sh",
    });

    await runLoop({ cwd, state, planContent: "# Test Plan Blocked\nDo a thing.", maxTurns: 3, threshold: 7, config });

    expect(state.outcome).toBe("verify-blocked");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.outcome).toBe("verify-blocked");
    expect(state.turns[0]?.verifyStatus).toBe("blocked");
    // findings from blocked verify should still be recorded
    expect(state.turns[0]?.thresholdFindings).toHaveLength(1);
    expect(state.turns[0]?.thresholdFindings[0]?.title).toBe("Blocking Issue");
  }, 60000);

  test("recovers from commit failure caused by pre-commit hook", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(mkdtempSync(join(tmpdir(), "adversary-rundir-cf-")), "test-run-commit-fail");
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
    const markerFile = join(cwd, "marker.txt");
    const implScript = join(cwd, "fake-impl-commit-fail.sh");
    writeFileSync(join(cwd, ".gitignore"), "fake-*.sh\n");
    writeFileSync(
      implScript,
      `#!/bin/sh\nMARKER="HOOK_FAIL""_MARKER"\nif grep -q "$MARKER" "${markerFile}" 2>/dev/null; then\n  echo "FIXED" > "${markerFile}"\nelse\n  echo "$MARKER" > "${markerFile}"\nfi\nexit 0\n`,
      { mode: 0o755 }
    );

    const fakeHarness = writeFakeHarness(cwd, "fake-harness-cf.sh", []);
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
      ...DEFAULT_CONFIG,
      implementCommandTemplate: implScript,
      verifyCommandTemplate: `${fakeHarness} @{promptFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
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
  }, 120000);

  test("sets commit-failure outcome when all turns exhausted on hook failure", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(mkdtempSync(join(tmpdir(), "adversary-rundir-cfc-")), "test-run-commit-fail-capped");
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

    // This test doesn't need verify to work (commit always fails before verify)
    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: implScript,
      verifyCommandTemplate: "true",
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# Test Plan Commit Capped\nDo a thing.", maxTurns: 2, threshold: 7, config });

    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]?.outcome).toBe("commit-failure");
    expect(state.turns[1]?.outcome).toBe("commit-failure");
    expect(state.outcome).toBe("commit-failure");
  }, 30000);
});
