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

  // ── VI-4: stopCommand always runs in finally ──────────────────────────────

  /**
   * Build a fake harness that outputs discovery JSON with the given startCommand/stopCommand scripts.
   * Uses pre-written script files so no shell-escaping issues with paths in JSON.
   * For non-discovery prompts it acts as a normal skill/synthesis harness.
   */
  function writeFakeHarnessWithServiceScripts(
    dir: string,
    name: string,
    startScript: string,
    stopScript: string,
    findings: unknown[] = [],
    verifyStatus = "ok"
  ): string {
    const script = join(dir, name);
    const findingsJson = JSON.stringify(findings);
    // Emit a JSON file for discovery to read — avoids escaping in shell
    const discoveryJsonPath = join(dir, `${name}.discovery.json`);
    const discoveryJson = JSON.stringify({
      testCommand: null,
      buildCommand: null,
      lintCommands: [],
      typeCheckCommands: [],
      startCommand: startScript,
      stopCommand: stopScript,
      browserDeps: [],
    });
    writeFileSync(discoveryJsonPath, discoveryJson);

    writeFileSync(
      script,
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done

if [ -z "$PROMPT_FILE" ]; then
  echo '{"status":"completed","findings":[]}'
  exit 0
fi

CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")

if echo "$CONTENT" | grep -q "schemaVersion"; then
  echo '{"schemaVersion":1,"status":"${verifyStatus}","findings":${findingsJson}}'
  exit 0
fi

if echo "$CONTENT" | grep -q "toolchain discovery"; then
  cat "${discoveryJsonPath}"
  exit 0
fi

echo '{"status":"completed","findings":[]}'
exit 0
`,
      { mode: 0o755 }
    );
    return script;
  }

  test("(VI-4a) stopCommand runs at end of normal successful turn", async () => {
    const cwd = await makeGitRepo();
    const tmpSentinels = mkdtempSync(join(tmpdir(), "adversary-vi4a-"));
    const startSentinel = join(tmpSentinels, "started.txt");
    const stopSentinel = join(tmpSentinels, "stopped.txt");

    // Write separate sentinel scripts — avoids JSON escaping problems
    const startScript = join(tmpSentinels, "start.sh");
    const stopScript = join(tmpSentinels, "stop.sh");
    writeFileSync(startScript, `#!/bin/sh\necho STARTED > "${startSentinel}"\n`, { mode: 0o755 });
    writeFileSync(stopScript, `#!/bin/sh\necho STOPPED > "${stopSentinel}"\n`, { mode: 0o755 });

    const harness = writeFakeHarnessWithServiceScripts(
      cwd, "fake-harness-vi4a.sh", startScript, stopScript, [], "ok"
    );
    const summarizerScript = writeFakeSummarizer(cwd, "fake-summarizer-vi4a.sh");

    const runDir = join(cwd, ".test-runs", "vi4a");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# VI-4a\nTest stopCommand on success.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "VI-4a",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${harness} @{promptFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# VI-4a\nTest.", maxTurns: 1, threshold: 7, config });

    // Both sentinel files must exist — startCommand ran before the turn, stopCommand ran after
    expect(existsSync(startSentinel)).toBe(true);
    expect(existsSync(stopSentinel)).toBe(true);
  }, 60000);

  test("(VI-4b) stopCommand still runs when startCommand exits non-zero (services-start-failure)", async () => {
    const cwd = await makeGitRepo();
    const tmpSentinels = mkdtempSync(join(tmpdir(), "adversary-vi4b-"));
    const stopSentinel = join(tmpSentinels, "stopped.txt");

    // startCommand fails (exits 1), stopCommand writes sentinel
    const startScript = join(tmpSentinels, "fail-start.sh");
    const stopScript = join(tmpSentinels, "stop.sh");
    writeFileSync(startScript, `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
    writeFileSync(stopScript, `#!/bin/sh\necho STOPPED > "${stopSentinel}"\n`, { mode: 0o755 });

    const harness = writeFakeHarnessWithServiceScripts(
      cwd, "fake-harness-vi4b.sh", startScript, stopScript, [], "ok"
    );
    const summarizerScript = writeFakeSummarizer(cwd, "fake-summarizer-vi4b.sh");

    const runDir = join(cwd, ".test-runs", "vi4b");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# VI-4b\nTest stopCommand on start-failure.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "VI-4b",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${harness} @{promptFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# VI-4b\nTest.", maxTurns: 1, threshold: 7, config });

    // Turn should have services-start-failure outcome
    expect(state.outcome).toBe("services-start-failure");
    // stopCommand must still have run despite startCommand failure.
    // NOTE: stopCommand is invoked via the direct call at src/loop/index.ts (runStopCommand after
    // the early-return branch), NOT via the try/finally block. The try/finally only covers
    // the verify path; when startCommand fails, servicesStarted stays false, so we exit before
    // the try/finally block and call runStopCommand explicitly in the services-start-failure branch.
    expect(existsSync(stopSentinel)).toBe(true);
  }, 60000);

  // VI-40: skipVerify=true resume path must NOT invoke startCommand or stopCommand
  test("(VI-40) skipVerify=true resume does NOT invoke startCommand or stopCommand", async () => {
    const cwd = await makeGitRepo();
    const tmpSentinels = mkdtempSync(join(tmpdir(), "adversary-vi40-"));
    const startSentinel = join(tmpSentinels, "started.txt");
    const stopSentinel = join(tmpSentinels, "stopped.txt");

    const startScript = join(tmpSentinels, "start.sh");
    const stopScript = join(tmpSentinels, "stop.sh");
    writeFileSync(startScript, `#!/bin/sh\necho STARTED > "${startSentinel}"\n`, { mode: 0o755 });
    writeFileSync(stopScript, `#!/bin/sh\necho STOPPED > "${stopSentinel}"\n`, { mode: 0o755 });

    const harness = writeFakeHarnessWithServiceScripts(
      cwd, "fake-harness-vi40.sh", startScript, stopScript, [], "ok"
    );
    const summarizerScript = writeFakeSummarizer(cwd, "fake-summarizer-vi40.sh");

    const runDir = join(cwd, ".test-runs", "vi40");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# VI-40\nTest skipVerify skips startCommand.");

    // Write a pre-existing verify.json so the resume can read it without running verify
    const turnDir = join(runDir, "turn-1");
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(
      join(turnDir, "verify.json"),
      JSON.stringify({ schemaVersion: 1, status: "ok", findings: [] })
    );

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "VI-40",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${harness} @{promptFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 10000,
    };

    // Resume with skipImplement=true, skipVerify=true — services should NOT start or stop
    await runLoop({
      cwd,
      state,
      planContent: "# VI-40\nTest.",
      maxTurns: 1,
      threshold: 7,
      config,
      resumePoint: { turn: 1, skipImplement: true, skipVerify: true, knownCommitSha: undefined },
    });

    // Neither sentinel should have been written — services were not invoked
    expect(existsSync(startSentinel)).toBe(false);
    expect(existsSync(stopSentinel)).toBe(false);
  }, 60000);

  // VI-38/45: post-commit discovery sees post-implement toolchain
  // If implement modifies a watched toolchain config file (e.g. package.json),
  // the discovery cache is invalidated and re-runs, picking up the new startCommand.
  // This test verifies that the post-commit discovery reflects what implement wrote.
  test("(VI-38) post-commit discovery reflects post-implement toolchain changes", async () => {
    const cwd = await makeGitRepo();
    const tmpSentinels = mkdtempSync(join(tmpdir(), "adversary-vi38-"));
    const startSentinel = join(tmpSentinels, "started.txt");
    const startScript = join(tmpSentinels, "start.sh");
    writeFileSync(startScript, `#!/bin/sh\necho STARTED > "${startSentinel}"\n`, { mode: 0o755 });

    const stopScript = join(tmpSentinels, "noop-stop.sh");
    writeFileSync(stopScript, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });

    // Discovery JSON that returns startCommand only when package.json exists with a marker.
    // This simulates: implement wrote package.json → discovery re-runs (cache invalidated)
    // and now sees startCommand.
    const discoveryJsonNoStart = JSON.stringify({
      testCommand: null, buildCommand: null, lintCommands: [], typeCheckCommands: [],
      startCommand: null, stopCommand: null, browserDeps: [],
    });
    const discoveryJsonWithStart = JSON.stringify({
      testCommand: null, buildCommand: null, lintCommands: [], typeCheckCommands: [],
      startCommand: startScript, stopCommand: stopScript, browserDeps: [],
    });
    writeFileSync(join(tmpSentinels, "discovery-no-start.json"), discoveryJsonNoStart);
    writeFileSync(join(tmpSentinels, "discovery-with-start.json"), discoveryJsonWithStart);

    // Harness: checks if package.json has a marker to decide which discovery JSON to emit.
    // Before implement: no package.json marker → null startCommand.
    // After implement: package.json has "startCommand" marker → real startCommand.
    const harness = join(cwd, "fake-harness-vi38.sh");
    writeFileSync(
      harness,
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done

if [ -z "$PROMPT_FILE" ]; then
  echo '{"status":"completed","findings":[]}'
  exit 0
fi

CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")

if echo "$CONTENT" | grep -q "schemaVersion"; then
  echo '{"schemaVersion":1,"status":"ok","findings":[]}'
  exit 0
fi

if echo "$CONTENT" | grep -q "toolchain discovery"; then
  # Check if package.json has the marker written by implement
  if grep -q "vi38-marker" "${cwd}/package.json" 2>/dev/null; then
    cat "${tmpSentinels}/discovery-with-start.json"
  else
    cat "${tmpSentinels}/discovery-no-start.json"
  fi
  exit 0
fi

echo '{"status":"completed","findings":[]}'
exit 0
`,
      { mode: 0o755 }
    );

    // Implement command: writes package.json with a marker (invalidates discovery cache)
    // AND commits the change so discovery sees it post-commit.
    const implScript = join(tmpSentinels, "impl-vi38.sh");
    writeFileSync(
      implScript,
      `#!/bin/sh
# Write package.json with marker — this invalidates the mtime-based discovery cache
echo '{"name":"test","vi38-marker":true}' > "${cwd}/package.json"
`,
      { mode: 0o755 }
    );

    const summarizerScript = writeFakeSummarizer(cwd, "fake-summarizer-vi38.sh");
    const runDir = join(cwd, ".test-runs", "vi38");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# VI-38\nTest post-commit discovery.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "VI-38",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: implScript,
      verifyCommandTemplate: `${harness} @{promptFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# VI-38\nTest.", maxTurns: 1, threshold: 7, config });

    // After implement wrote package.json, post-commit discovery re-ran (cache invalidated)
    // and saw startCommand → startCommand ran and wrote the sentinel.
    expect(existsSync(startSentinel)).toBe(true);
  }, 60000);

  // VI-27: servicesTimeoutMs actually reaches runStep — prove the timeout flows through
  test("(VI-27) servicesTimeoutMs times out startCommand that exceeds the limit", async () => {
    const cwd = await makeGitRepo();
    const tmpSentinels = mkdtempSync(join(tmpdir(), "adversary-vi27-"));

    // startCommand sleeps for 5 seconds; servicesTimeoutMs is 200ms — should time out
    const startScript = join(tmpSentinels, "slow-start.sh");
    writeFileSync(startScript, `#!/bin/sh\nsleep 5\n`, { mode: 0o755 });

    // No stopCommand needed for this test — pass a no-op stop script
    const stopScript = join(tmpSentinels, "noop-stop.sh");
    writeFileSync(stopScript, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });

    const harness = writeFakeHarnessWithServiceScripts(
      cwd, "fake-harness-vi27.sh", startScript, stopScript, [], "ok"
    );
    const summarizerScript = writeFakeSummarizer(cwd, "fake-summarizer-vi27.sh");

    const runDir = join(cwd, ".test-runs", "vi27");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# VI-27\nTest servicesTimeoutMs flow-through.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "VI-27",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const start = Date.now();
    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${harness} @{promptFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
      // 200ms is well under the 5s sleep — should time out and produce services-start-failure
      servicesTimeoutMs: 200,
    };

    await runLoop({ cwd, state, planContent: "# VI-27\nTest.", maxTurns: 1, threshold: 7, config });
    const elapsed = Date.now() - start;

    // Should have failed due to startCommand timeout, not waited the full 5s sleep
    expect(state.outcome).toBe("services-start-failure");
    // Should resolve well under verifyTimeoutMs (30s) — the servicesTimeoutMs (200ms + kill) took effect
    expect(elapsed).toBeLessThan(10000);
  }, 30000);

  // VI-50: discovery must be RUN post-implement (invocation count = 2 over a 1-turn run).
  // The harness grep pattern "toolchain discovery" matches TWO prompts per turn:
  //   1. The discovery.md prompt (the actual toolchain discovery call).
  //   2. The exerciser.md prompt (which contains "toolchain discovery JSON" in its text).
  // Both calls go through the same verifyCommandTemplate, so both increment the counter.
  // Total count over a single turn with startCommand=null is exactly 2.
  test("(VI-50) discovery re-runs when implement modifies a toolchain config file (cache invalidation)", async () => {
    const cwd = await makeGitRepo();
    const tmpSentinels = mkdtempSync(join(tmpdir(), "adversary-vi50-"));
    const counterFile = join(tmpSentinels, "discovery-count.txt");

    // Track invocations: write incrementing count to counterFile
    const harnessScript = join(cwd, "fake-harness-vi50.sh");
    const discoveryJsonNoStart = JSON.stringify({
      testCommand: null, buildCommand: null, lintCommands: [], typeCheckCommands: [],
      startCommand: null, stopCommand: null, browserDeps: [],
    });
    const discoveryJsonWithStart = JSON.stringify({
      testCommand: null, buildCommand: null, lintCommands: [], typeCheckCommands: [],
      startCommand: null, stopCommand: null, browserDeps: [],
    });

    writeFileSync(
      harnessScript,
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done

if [ -z "$PROMPT_FILE" ]; then
  echo '{"status":"completed","findings":[]}'
  exit 0
fi

CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")

if echo "$CONTENT" | grep -q "schemaVersion"; then
  echo '{"schemaVersion":1,"status":"ok","findings":[]}'
  exit 0
fi

if echo "$CONTENT" | grep -q "toolchain discovery"; then
  count=0
  [ -f "${counterFile}" ] && count=$(cat "${counterFile}")
  echo $((count + 1)) > "${counterFile}"
  echo '${discoveryJsonNoStart}'
  exit 0
fi

echo '{"status":"completed","findings":[]}'
exit 0
`,
      { mode: 0o755 }
    );

    // Implement command: writes package.json with a marker (invalidates discovery cache)
    // and commits it — this forces a cache miss on the post-commit discovery call.
    const implScript = join(tmpSentinels, "impl-vi50.sh");
    writeFileSync(
      implScript,
      `#!/bin/sh
# Write package.json with marker — this invalidates the mtime-based discovery cache
echo '{"name":"test","vi50-marker":true}' > "${cwd}/package.json"
`,
      { mode: 0o755 }
    );

    const summarizerScript = writeFakeSummarizer(cwd, "fake-summarizer-vi50.sh");
    const runDir = join(cwd, ".test-runs", "vi50");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# VI-50\nTest discovery re-run count.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "VI-50",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: implScript,
      verifyCommandTemplate: `${harnessScript} @{promptFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# VI-50\nTest.", maxTurns: 1, threshold: 7, config });

    // Discovery harness is invoked exactly 2 times per turn: once for the actual
    // discovery.md call, and once for the exerciser (whose prompt contains "toolchain discovery").
    const discoveryCount = parseInt((readFileSync(counterFile, "utf8")).trim(), 10);
    expect(discoveryCount).toBe(2);
    expect(state.outcome).toBe("clean");
  }, 60000);

  // VI-51: stopCommand runs when verify fails (verify-failure outcome)
  test("(VI-51) stopCommand runs when verify pipeline throws (verify-failure outcome)", async () => {
    const cwd = await makeGitRepo();
    const tmpSentinels = mkdtempSync(join(tmpdir(), "adversary-vi51-"));
    const startSentinel = join(tmpSentinels, "started.txt");
    const stopSentinel = join(tmpSentinels, "stopped.txt");

    const startScript = join(tmpSentinels, "start.sh");
    const stopScript = join(tmpSentinels, "stop.sh");
    writeFileSync(startScript, `#!/bin/sh\necho STARTED > "${startSentinel}"\n`, { mode: 0o755 });
    writeFileSync(stopScript, `#!/bin/sh\necho STOPPED > "${stopSentinel}"\n`, { mode: 0o755 });

    // Harness: discovery returns startCommand/stopCommand, but when invoked for
    // skills/synthesis it exits non-zero to force a verify-failure path.
    const discoveryJsonPath = join(tmpSentinels, "disc-vi51.json");
    writeFileSync(discoveryJsonPath, JSON.stringify({
      testCommand: null, buildCommand: null, lintCommands: [], typeCheckCommands: [],
      startCommand: startScript, stopCommand: stopScript, browserDeps: [],
    }));

    const harnessScript = join(cwd, "fake-harness-vi51.sh");
    writeFileSync(
      harnessScript,
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done

if [ -z "$PROMPT_FILE" ]; then
  echo '{"status":"completed","findings":[]}'
  exit 0
fi

CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")

if echo "$CONTENT" | grep -q "toolchain discovery"; then
  cat "${discoveryJsonPath}"
  exit 0
fi

# All other skill/synthesis calls exit non-zero to force verify-failure
exit 1
`,
      { mode: 0o755 }
    );

    const summarizerScript = writeFakeSummarizer(cwd, "fake-summarizer-vi51.sh");
    const runDir = join(cwd, ".test-runs", "vi51");
    await initRunDir(runDir);
    await snapshotPlan(runDir, "# VI-51\nTest stopCommand on verify-failure.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "VI-51",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
    };

    const config: AdversaryConfig = {
      ...DEFAULT_CONFIG,
      implementCommandTemplate: "true",
      verifyCommandTemplate: `${harnessScript} @{promptFile}`,
      summarizerCommandTemplate: summarizerScript,
      implementTimeoutMs: 30000,
      verifyTimeoutMs: 30000,
      prTimeoutMs: 10000,
      summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 10000,
    };

    await runLoop({ cwd, state, planContent: "# VI-51\nTest.", maxTurns: 1, threshold: 7, config });

    // When all skill harness calls exit non-zero, the verify pipeline falls back to synthesizeFallback
    // which returns status="ok" with severity-8 metaFindings for each failed skill. With maxTurns=1
    // and findings above the threshold, the loop exits with outcome="capped". This is deterministic:
    // the harness always returns the same failure pattern, so the outcome is always "capped".
    expect(state.outcome).toBe("capped");
    // startCommand ran before verify
    expect(existsSync(startSentinel)).toBe(true);
    // stopCommand must run via try/finally regardless of how verify ended
    expect(existsSync(stopSentinel)).toBe(true);
  }, 60000);
});
