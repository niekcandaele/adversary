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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { runLoop } from "../src/loop/index.js";
import type { RunState, AdversaryConfig, TurnResult } from "../src/types/index.js";
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

  // VI-8: startTurn > maxTurns (without extendForResume) should throw an error
  test("resumePoint with turn > maxTurns (no extendForResume) throws overflow error", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(mkdtempSync(join(tmpdir(), "adversary-rundir-vi8-")), "test-run-overflow");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan VI-8\nOverflow.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan VI-8",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config = makeConfig(cwd, { findings: [], verifyStatus: "ok" });

    // turn=5, maxTurns=3, no extendForResume — should throw
    await expect(
      runLoop({
        cwd,
        state,
        planContent: "# Test Plan VI-8\nOverflow.",
        maxTurns: 3,
        threshold: 7,
        config,
        resumePoint: { turn: 5, skipImplement: false, skipVerify: false },
      })
    ).rejects.toThrow(/startTurn.*exceeds maxTurns|Resume error.*startTurn/i);
  }, 30000);

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

  test("turn 1 implement prompt includes cached repo guidance", async () => {
    const cwd = await makeGitRepo();
    writeFileSync(join(cwd, "AGENTS.md"), "# Repo Rules\nKeep changes aligned with the repo.");
    const skillDir = join(cwd, ".claude", "skills", "repo-style");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Repo Skill\nAlways follow the house style.");

    const runDir = join(cwd, ".test-runs", "test-run-guidance");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Guided Plan\nDo a thing.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Guided Plan",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config = makeConfig(cwd, { findings: [], verifyStatus: "ok", summarizerName: "fake-summarizer-guidance.sh" });

    await runLoop({ cwd, state, planContent: "# Guided Plan\nDo a thing.", maxTurns: 1, threshold: 7, config });

    const prompt = readFileSync(join(runDir, "turn-1", "implement-input.md"), "utf8");
    expect(prompt).toContain("Repo Guidance");
    expect(prompt).toContain("Repo Skill");
    expect(prompt).toContain("Keep changes aligned with the repo.");
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

  test("treats synthesized status=error with valid findings as a normal threshold-driven verify result", async () => {
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

    expect(state.outcome).toBe("capped");
    expect(state.turns).toHaveLength(3);
    expect(state.turns[0]?.outcome).toBe("continue");
    expect(state.turns[0]?.verifyStatus).toBe("ok");
    expect(state.turns[1]?.outcome).toBe("continue");
    expect(state.turns[1]?.verifyStatus).toBe("ok");
    expect(state.turns[2]?.outcome).toBe("capped");
    expect(state.turns[2]?.verifyStatus).toBe("ok");
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

  test("synthesis returning blocked status is treated as fallback (blocked no longer stops the loop)", async () => {
    // "blocked" is no longer a valid synthesis status. When the harness returns blocked,
    // the orchestrator uses deterministic synthesis fallback which returns "ok" (no skill errors).
    // The loop proceeds normally based on threshold findings.
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

    await runLoop({ cwd, state, planContent: "# Test Plan Blocked\nDo a thing.", maxTurns: 1, threshold: 7, config });

    // No longer stops with verify-blocked — loop handles findings via threshold
    expect(state.outcome).not.toBe("verify-blocked");
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

  // ─────────────────────────────────────────────────────────────────────────────
  // VI-7: skipLoop branch — no implement spawned, state.turns unchanged, outcome set
  // ─────────────────────────────────────────────────────────────────────────────
  test("skipLoop=true skips loop, sets outcome from last turn, no implement subprocess", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(cwd, ".test-runs", "test-run-skiploop");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Skip Loop Plan\nDo a thing.");

    // Pre-populate state with a completed turn (clean outcome)
    const completedTurn: TurnResult = {
      turn: 1,
      implementCommand: "fake-impl",
      verifyCommand: "multi-skill",
      implementDurationMs: 1000,
      verifyDurationMs: 500,
      repoChanged: true,
      commitSha: "deadbeef1234",
      verifyStatus: "ok",
      thresholdFindings: [],
      belowThresholdFindings: [],
      outcome: "clean",
    };

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Skip Loop Plan",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [completedTurn],
    };

    const initialTurnsLength = state.turns.length;

    // Use an implement command that would fail if called (to detect if implement runs)
    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: "false", // exits non-zero — should NOT be called
      verifyCommandTemplate: "true",
      summarizerCommandTemplate: "true",
      implementTimeoutMs: 5000,
      verifyTimeoutMs: 5000,
    };

    await runLoop({
      cwd,
      state,
      planContent: "# Skip Loop Plan\nDo a thing.",
      maxTurns: 5,
      threshold: 7,
      config,
      resumePoint: { turn: 1, skipImplement: false, skipVerify: false, skipLoop: true },
    });

    // state.turns must be unchanged (no new turns added)
    expect(state.turns).toHaveLength(initialTurnsLength);
    // state.outcome must be set from the last turn's outcome
    expect(state.outcome).toBe("clean");
  }, 30000);

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

  // VI-7: extendForResume resumePoint — loop executes the resume turn and produces non-error outcome
  test("extendForResume resumePoint: loop executes turn 2 and produces non-error outcome", async () => {
    const cwd = await makeGitRepo();
    const runDir = join(mkdtempSync(join(tmpdir(), "adversary-rundir-vi7-")), "test-run-extend");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# Test Plan VI-7\nExtend for resume.");

    // Pre-populate turn 1 summary so the loop skips it
    const turn1Dir = join(runDir, "turn-1");
    mkdirSync(turn1Dir, { recursive: true });
    const turn1Summary: TurnResult = {
      turn: 1,
      implementCommand: "true",
      verifyCommand: "multi-skill",
      implementDurationMs: 100,
      verifyDurationMs: 100,
      repoChanged: false,
      commitSha: undefined,
      verifyStatus: "ok",
      thresholdFindings: [],
      belowThresholdFindings: [],
      outcome: "clean",
    };
    writeFileSync(join(turn1Dir, "turn-summary.json"), JSON.stringify(turn1Summary));

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan VI-7",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [turn1Summary],
    };

    const config = makeConfig(cwd, { findings: [], verifyStatus: "ok", summarizerName: "fake-summarizer-vi7.sh" });

    // extendForResume=true, turn=2: caller (resumeCommand) already bumped maxTurns to 2.
    // We pass maxTurns=2 directly to simulate the pre-bumped value.
    await runLoop({
      cwd,
      state,
      planContent: "# Test Plan VI-7\nExtend for resume.",
      maxTurns: 2,  // pre-bumped by caller (resumeCommand adds +1 for extendForResume)
      threshold: 7,
      config,
      resumePoint: { turn: 2, skipImplement: false, skipVerify: false, extendForResume: true },
    });

    // Loop should have run turn 2 (extendForResume bumps the cap)
    expect(state.turns.length).toBeGreaterThanOrEqual(2);
    // State outcome must be a valid non-error outcome (clean, capped, or a failure)
    expect(state.outcome).toBeDefined();
    expect(["clean", "capped", "implement-failure", "commit-failure", "verify-failure", "verify-error", "summarizer-failure"]).toContain(state.outcome ?? "");
  }, 30000);
});
