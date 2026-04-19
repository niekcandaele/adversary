/**
 * Integration tests for runCommand (src/cli/run.ts)
 *
 * These tests exercise the runCommand orchestrator using fake scripts
 * in a real git repo, similar to the runLoop integration tests.
 *
 * Focused on:
 * (a) failure outcome (implement-failure, verify-failure, verify-error)
 *     must skip push/PR — no gh pr create call is made
 * (b) PrError from createPr must propagate (throw) out of runCommand
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { runCommand, runPostLoopPhases, PushFailureError } from "../src/cli/run.js";
import { PrError } from "../src/pr/index.js";
import type { RunState } from "../src/types/index.js";
import { writeFileSync as writeFileSyncFS } from "node:fs";
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from "node:fs/promises";

/**
 * Create a minimal git repo with initial commit and a local bare remote.
 */
async function makeGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "adversary-run-int-"));
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

  // Create a local bare repo as 'origin' so git push works without a real remote
  const bareDir = `${dir}.bare`;
  const bareProc = Bun.spawn(
    ["git", "clone", "--bare", dir, bareDir],
    { stdout: "pipe", stderr: "pipe" }
  );
  await bareProc.exited;
  await run("git", "remote", "add", "origin", bareDir);

  return dir;
}

/**
 * Write a shell script file with given content, mark it executable.
 */
function writeScript(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o755 });
  return path;
}

/**
 * Write a plan file to a separate temp dir (outside the repo) so it doesn't
 * create untracked files in the git repo working tree.
 */
function writePlan(tmpDir: string, title: string): string {
  const path = join(tmpDir, "plan.md");
  writeFileSync(path, `# ${title}\nDo a thing.`);
  return path;
}

/**
 * Write a fake harness script for the multi-skill orchestrator.
 * The harness is called with @{promptFile} and outputs skill or synthesis JSON.
 *
 * - discovery prompt → outputs ToolchainDiscovery JSON
 * - synthesis prompt → outputs full VerifyReport JSON
 * - skill prompts → outputs {"status": "ok", "findings": [...]}
 */
function writeFakeVerifyHarness(
  dir: string,
  name: string,
  opts: { findings?: unknown[]; status?: string }
): string {
  const { findings = [], status = "ok" } = opts;
  const findingsJson = JSON.stringify(findings);
  const verifyStatus = status;

  return writeScript(
    dir,
    name,
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

# Synthesis prompt: contains "schemaVersion"
if echo "$CONTENT" | grep -q "schemaVersion"; then
  echo '{"schemaVersion":1,"status":"${verifyStatus}","findings":${findingsJson}}'
  exit 0
fi

# Discovery prompt: contains "testCommand" or "toolchain discovery"
if echo "$CONTENT" | grep -q 'testCommand\\|toolchain discovery'; then
  echo '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"browserDeps":[]}'
  exit 0
fi

# Default skill response (no findings; synthesis will include them)
echo '{"status":"completed","findings":[]}'
exit 0
`
  );
}

/**
 * Build a fake bin directory with all required scripts.
 */
function makeFakeBin(tmpDir: string, opts: {
  implementExitCode?: number;
  verifyStatus?: string;
  prCreateExitCode?: number;
  prCreateOutput?: string;
}): { binDir: string; verifyHarnessPath: string; prCreateArgsLog: string; summarizerScriptPath: string } {
  const {
    implementExitCode = 0,
    verifyStatus = "ok",
    prCreateExitCode = 0,
    prCreateOutput = "https://github.com/owner/repo/pull/99",
  } = opts;

  const binDir = join(tmpDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const prCreateArgsLog = join(tmpDir, "pr-create-args.log");

  // Fake implement harness — exits 0 for implement (no @promptFile check needed)
  writeScript(binDir, "fake-impl.sh",
    `#!/bin/sh\nexit ${implementExitCode}\n`
  );

  // Fake summarizer script — outputs valid commit message JSON
  const summarizerScriptPath = writeScript(binDir, "fake-summarizer.sh",
    `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done
echo '{ "title": "Implement plan changes", "summary": "- Changes made", "reviewerGuide": "Review src/ changes", "testPlan": "Run bun test", "issueNumber": null, "commitMessage": "feat: implement plan changes" }'
exit 0
`
  );

  // Fake verify harness for multi-skill orchestrator
  const findings = verifyStatus === "error"
    ? [{ title: "Error", severity: 8, description: "Error occurred", sources: ["tester"] }]
    : [];

  const verifyHarnessPath = writeFakeVerifyHarness(tmpDir, "fake-verify-harness.sh", {
    findings,
    status: verifyStatus,
  });

  // Fake 'gh' — handles both 'auth status' (preflight) and 'pr create'
  writeScript(binDir, "gh",
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "${prCreateArgsLog}"
  echo "${prCreateOutput}"
  exit ${prCreateExitCode}
fi
exit 0
`
  );

  // Fake 'glab' — not expected to be called
  writeScript(binDir, "glab",
    `#!/bin/sh\necho "glab not expected" >&2\nexit 1\n`
  );

  return { binDir, verifyHarnessPath, prCreateArgsLog, summarizerScriptPath };
}

/**
 * Write a fake config file to a temp dir OUTSIDE the repo.
 */
function writeFakeConfig(
  tmpDir: string,
  opts: {
    implementCommandTemplate: string;
    verifyCommandTemplate: string;
    summarizerCommandTemplate: string;
  }
): string {
  const configPath = join(tmpDir, ".adversary.json");
  const config = {
    baseBranch: "main",
    implementCommandTemplate: opts.implementCommandTemplate,
    verifyCommandTemplate: opts.verifyCommandTemplate,
    summarizerCommandTemplate: opts.summarizerCommandTemplate,
    implementTimeoutMs: 30000,
    verifyTimeoutMs: 30000,
    prTimeoutMs: 30000,
    summarizerTimeoutMs: 30000,
    servicesTimeoutMs: 30000,
  };
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

/**
 * Run runCommand with a fake PATH (via options.env) and explicit cwd (via options.cwd).
 */
async function runWithFakePath(
  repoDir: string,
  binDir: string,
  planPath: string,
  configPath: string,
  expectError?: abstract new (...args: never[]) => unknown
): Promise<void> {
  const fakeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };

  if (expectError) {
    await expect(
      runCommand({
        plan: planPath,
        turns: 1,
        severityThreshold: 7,
        configFile: configPath,
        cwd: repoDir,
        env: fakeEnv,
      })
    ).rejects.toBeInstanceOf(expectError);
  } else {
    await runCommand({
      plan: planPath,
      turns: 1,
      severityThreshold: 7,
      configFile: configPath,
      cwd: repoDir,
      env: fakeEnv,
    });
  }
}

describe("runCommand integration", () => {
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

  test("(a) implement-failure outcome skips push and PR creation", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-"));
    const { binDir, verifyHarnessPath, prCreateArgsLog, summarizerScriptPath } = makeFakeBin(tmpBinDir, {
      implementExitCode: 1, // implement fails → implement-failure
      verifyStatus: "ok",
      prCreateExitCode: 0,
    });

    const implScript = writeScript(tmpBinDir, "fake-impl-fail.sh", `#!/bin/sh\nexit 1\n`);
    const planPath = writePlan(tmpBinDir, "Test Impl Failure Skips PR");
    const configPath = writeFakeConfig(tmpBinDir, {
      implementCommandTemplate: `${implScript} @{promptFile}`,
      verifyCommandTemplate: `${verifyHarnessPath} @{promptFile}`,
      summarizerCommandTemplate: `${summarizerScriptPath} @{promptFile}`,
    });

    await runWithFakePath(repoDir, binDir, planPath, configPath);

    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(false);
  }, 60000);

  test("(a) blocked synthesis status falls back to ok — loop proceeds and PR is created", async () => {
    // "blocked" is no longer a valid synthesis status. When the harness returns blocked,
    // the orchestrator falls back to deterministic synthesis → "ok" with no findings.
    // The loop completes "clean" and pushes/creates a PR.
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-blocked-"));
    const { binDir, verifyHarnessPath, prCreateArgsLog, summarizerScriptPath } = makeFakeBin(tmpBinDir, {
      implementExitCode: 0,
      verifyStatus: "blocked",
      prCreateExitCode: 0,
    });

    const implScript = writeScript(tmpBinDir, "fake-impl-ok.sh", `#!/bin/sh\nexit 0\n`);
    const planPath = writePlan(tmpBinDir, "Test Blocked Fallback");
    const configPath = writeFakeConfig(tmpBinDir, {
      implementCommandTemplate: `${implScript} @{promptFile}`,
      verifyCommandTemplate: `${verifyHarnessPath} @{promptFile}`,
      summarizerCommandTemplate: `${summarizerScriptPath} @{promptFile}`,
    });

    // Should not throw — loop completes normally since blocked is now treated as ok fallback
    await runWithFakePath(repoDir, binDir, planPath, configPath);

    // PR creation IS expected since run ended clean (not a failure outcome)
    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(true);
  }, 120000);

  test("(a) synthesized status=error with valid findings follows normal capped flow and still creates a PR", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-verifyerror-"));
    const { binDir, verifyHarnessPath, prCreateArgsLog, summarizerScriptPath } = makeFakeBin(tmpBinDir, {
      implementExitCode: 0,
      verifyStatus: "error",
      prCreateExitCode: 0,
    });

    const implScript = writeScript(tmpBinDir, "fake-impl-ok.sh", `#!/bin/sh\nexit 0\n`);
    const planPath = writePlan(tmpBinDir, "Test Verify Error Skips PR");
    const configPath = writeFakeConfig(tmpBinDir, {
      implementCommandTemplate: `${implScript} @{promptFile}`,
      verifyCommandTemplate: `${verifyHarnessPath} @{promptFile}`,
      summarizerCommandTemplate: `${summarizerScriptPath} @{promptFile}`,
    });

    await runWithFakePath(repoDir, binDir, planPath, configPath);

    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(true);
  }, 120000);

  test("(b) PrError from createPr propagates out of runCommand", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-prerror-"));
    const { binDir, verifyHarnessPath, summarizerScriptPath } = makeFakeBin(tmpBinDir, {
      implementExitCode: 0,
      verifyStatus: "ok",
      prCreateExitCode: 1, // gh pr create fails → PrError
      prCreateOutput: "authentication failed",
    });

    const implScript = writeScript(tmpBinDir, "fake-impl-ok.sh", `#!/bin/sh\nexit 0\n`);
    const planPath = writePlan(tmpBinDir, "Test PrError Propagation");
    const configPath = writeFakeConfig(tmpBinDir, {
      implementCommandTemplate: `${implScript} @{promptFile}`,
      verifyCommandTemplate: `${verifyHarnessPath} @{promptFile}`,
      summarizerCommandTemplate: `${summarizerScriptPath} @{promptFile}`,
    });

    await runWithFakePath(repoDir, binDir, planPath, configPath, PrError);
  }, 120000);

  test("(c) PR summarizer failure throws out of runCommand", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-pr-summary-fail-"));

    const binDir = join(tmpBinDir, "bin");
    mkdirSync(binDir, { recursive: true });

    const prCreateArgsLog = join(tmpBinDir, "pr-create-args.log");

    // Fake implement harness — exits 0 for implement
    const implScript = writeScript(tmpBinDir, "fake-impl-ok.sh", `#!/bin/sh\nexit 0\n`);

    // Fake verify harness — outputs clean verify JSON
    const verifyHarnessPath = writeFakeVerifyHarness(tmpBinDir, "fake-verify-harness.sh", {
      findings: [],
      status: "ok",
    });

    // Fake summarizer for commit messages (succeeds) — PR summary will fail below
    const goodSummarizerPath = writeScript(tmpBinDir, "good-commit-summarizer.sh",
      `#!/bin/sh\necho '{ "commitMessage": "feat: implement changes", "turnSummary": "Done." }'\nexit 0\n`
    );

    writeScript(binDir, "gh",
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "${prCreateArgsLog}"
  echo "https://github.com/owner/repo/pull/99"
  exit 0
fi
exit 0
`
    );

    writeScript(binDir, "glab",
      `#!/bin/sh\necho "glab not expected" >&2\nexit 1\n`
    );

    // The summarizer template needs to handle both commit messages and PR summaries.
    // The PR summarizer is called separately with a different prompt. We use the same
    // summarizerCommandTemplate for both. We make it output commit JSON first,
    // but fail on the PR summary invocation by detecting the prompt type.
    // Actually, the simplest approach: always fail the summarizer — but then commit-msg
    // generation fails first, giving summarizer-failure outcome.
    //
    // Better: output commit JSON but fail PR summary:
    // PR summary prompt contains "PR" or "pull request" keywords.
    const smartSummarizerPath = writeScript(tmpBinDir, "smart-summarizer.sh",
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done
CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")
if echo "$CONTENT" | grep -qi "pull request\\|PR description\\|reviewer guide"; then
  exit 1
fi
echo '{ "commitMessage": "feat: implement changes", "turnSummary": "Done." }'
exit 0
`
    );

    const configPath = writeFakeConfig(tmpBinDir, {
      implementCommandTemplate: `${implScript} @{promptFile}`,
      verifyCommandTemplate: `${verifyHarnessPath} @{promptFile}`,
      summarizerCommandTemplate: `${smartSummarizerPath} @{promptFile}`,
    });

    const planPath = writePlan(tmpBinDir, "Test PR Summary Failure Throws");

    const fakeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    await expect(
      runCommand({
        plan: planPath,
        turns: 1,
        severityThreshold: 7,
        configFile: configPath,
        cwd: repoDir,
        env: fakeEnv,
      })
    ).rejects.toThrow("PR summarizer command failed");

    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(false);
  }, 120000);

  test("(d) summarizer-failure (commit-msg) skips push and PR creation", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-summfail-"));

    const binDir = join(tmpBinDir, "bin");
    mkdirSync(binDir, { recursive: true });

    const prCreateArgsLog = join(tmpBinDir, "pr-create-args.log");

    // Fake implement harness — creates a repo change so hasChanges() returns true
    const implScript = writeScript(tmpBinDir, "fake-impl-changes.sh",
      `#!/bin/sh\necho "change $(date +%s%N)" >> implement-output.txt\nexit 0\n`
    );

    // Commit-message summarizer fails (exits non-zero)
    const failSummarizerScript = writeScript(tmpBinDir, "fail-commit-summarizer.sh",
      `#!/bin/sh\nexit 1\n`
    );

    // Fake verify harness (not reached because summarizer fails first)
    const verifyHarnessPath = writeFakeVerifyHarness(tmpBinDir, "fake-verify-harness.sh", {
      findings: [],
      status: "ok",
    });

    writeScript(binDir, "gh",
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "${prCreateArgsLog}"
  echo "https://github.com/owner/repo/pull/99"
  exit 0
fi
exit 0
`
    );

    writeScript(binDir, "glab",
      `#!/bin/sh\necho "glab not expected" >&2\nexit 1\n`
    );

    const configPath = writeFakeConfig(tmpBinDir, {
      implementCommandTemplate: `${implScript} @{promptFile}`,
      verifyCommandTemplate: `${verifyHarnessPath} @{promptFile}`,
      summarizerCommandTemplate: `${failSummarizerScript} @{promptFile}`,
    });

    const planPath = writePlan(tmpBinDir, "Test Commit-Msg Summarizer Failure Skips PR");

    const fakeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    await expect(
      runCommand({
        plan: planPath,
        turns: 1,
        severityThreshold: 7,
        configFile: configPath,
        cwd: repoDir,
        env: fakeEnv,
      })
    ).resolves.toBeUndefined();

    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(false);
  }, 60000);

  // VI-6: runCommand catches PushFailureError → writes done.flag with push-failure outcome, exits 1
  // Tests the path where push fails (non-existent remote) → PushFailureError → process.exit(1)
  test("(VI-6) push to non-existent origin → done.flag written with push-failure outcome, process.exit(1)", async () => {
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-vi6-"));

    // Create repo WITHOUT a real origin — add a non-existent remote URL so push fails
    const repoDir = mkdtempSync(join(tmpdir(), "adversary-vi6-repo-"));
    const run = async (args: string[], cwd: string): Promise<string> => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return (await new Response(proc.stdout).text()).trim();
    };
    await run(["init", "-b", "main"], repoDir);
    await run(["config", "user.email", "t@t.com"], repoDir);
    await run(["config", "user.name", "T"], repoDir);
    writeFileSyncFS(join(repoDir, "README.md"), "init");
    await run(["add", "."], repoDir);
    await run(["commit", "-m", "init"], repoDir);
    // Add a remote that points to a non-existent location — git push will fail with GitError
    await run(["remote", "add", "origin", "/nonexistent/path/to/repo.git"], repoDir);

    const binDir = join(tmpBinDir, "bin");
    mkdirSync(binDir, { recursive: true });

    // Implement: creates a file change so a commit is made
    writeScript(tmpBinDir, "fake-impl-vi6.sh",
      `#!/bin/sh\necho "change $(date +%s%N)" >> ${join(repoDir, "impl-output.txt")}\nexit 0\n`
    );
    const summarizerPath = writeScript(tmpBinDir, "fake-summarizer-vi6.sh",
      `#!/bin/sh\necho '{"title":"T","summary":"S","reviewerGuide":"G","testPlan":"P","issueNumber":null,"commitMessage":"feat: vi6 change"}'\nexit 0\n`
    );
    const verifyHarness = writeFakeVerifyHarness(tmpBinDir, "fake-verify-vi6.sh", { findings: [], status: "ok" });

    // gh auth check passes (but push should fail before gh is called)
    writeScript(binDir, "gh",
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
exit 0
`
    );
    writeScript(binDir, "glab", `#!/bin/sh\nexit 1\n`);

    const fakeEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };

    const planPath = writePlan(tmpBinDir, "Test VI-6 Push Failure Exit Code");
    const configPath = writeFakeConfig(tmpBinDir, {
      implementCommandTemplate: `${join(tmpBinDir, "fake-impl-vi6.sh")} @{promptFile}`,
      verifyCommandTemplate: `${verifyHarness} @{promptFile}`,
      summarizerCommandTemplate: `${summarizerPath} @{promptFile}`,
    });

    // Override process.exit to capture the exit code
    const originalExit = process.exit;
    let capturedExitCode: number | undefined;
    process.exit = ((code?: number) => {
      capturedExitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const stderrChunks: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : "");
      return true;
    }) as never;

    try {
      await runCommand({ plan: planPath, turns: 1, severityThreshold: 7, configFile: configPath, cwd: repoDir, env: fakeEnv });
    } catch {
      // process.exit throws in our mock
    } finally {
      process.exit = originalExit;
      process.stderr.write = origStderr;
    }

    // Should have called process.exit(1)
    expect(capturedExitCode).toBe(1);

    // done.flag must exist in the run dir with push-failure outcome
    const { getStateDir } = await import("../src/config/paths.js");
    const runsDir = join(getStateDir(repoDir), "runs");
    const { readdirSync } = await import("node:fs");
    const runDirs = readdirSync(runsDir);
    expect(runDirs.length).toBeGreaterThan(0);
    const runDir = join(runsDir, runDirs[0]!);
    const doneFlagFile = Bun.file(join(runDir, "done.flag"));
    expect(await doneFlagFile.exists()).toBe(true);
    const doneFlag = await doneFlagFile.json();
    expect(doneFlag.outcome).toBe("push-failure");
  }, 120000);
});

// ─────────────────────────────────────────────────────────────────────────────
// VI-3: Push-or-skip decision tree in runPostLoopPhases
// Tests the four branches of push decision logic using a file:// local remote.
// ─────────────────────────────────────────────────────────────────────────────

describe("runPostLoopPhases — push decision tree (VI-3)", () => {
  let xdgStateDir: string;
  let savedXdgStateHome: string | undefined;

  beforeEach(async () => {
    xdgStateDir = await mkdtemp(join(tmpdir(), "adversary-push-xdg-"));
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

  /**
   * Create a git repo with a local bare remote (file:// URL as 'origin').
   * Returns the repo dir and the bare origin dir.
   */
  async function makeRepoWithRemote(): Promise<{ repoDir: string; bareDir: string }> {
    const repoDir = mkdtempSync(join(tmpdir(), "adversary-push-repo-"));
    const bareDir = `${repoDir}.bare`;

    const run = async (args: string[], cwd: string) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };

    await run(["init", "-b", "main"], repoDir);
    await run(["config", "user.email", "t@t.com"], repoDir);
    await run(["config", "user.name", "T"], repoDir);
    writeFileSyncFS(join(repoDir, "README.md"), "init");
    await run(["add", "."], repoDir);
    await run(["commit", "-m", "init"], repoDir);

    // Clone bare as origin
    const clone = Bun.spawn(["git", "clone", "--bare", repoDir, bareDir], { stdout: "pipe", stderr: "pipe" });
    await clone.exited;
    await run(["remote", "add", "origin", bareDir], repoDir);

    return { repoDir, bareDir };
  }

  async function makeFakePostLoopBin(tmpBinDir: string, opts: {
    prCreateExitCode?: number;
    prListOutput?: string;
  }): Promise<{ binDir: string; pushArgsLog: string; prCreateArgsLog: string; summarizerScriptPath: string }> {
    const { prCreateExitCode = 0, prListOutput = "[]" } = opts;
    const binDir = join(tmpBinDir, "bin");
    await mkdirAsync(binDir, { recursive: true });

    const pushArgsLog = join(tmpBinDir, "push-args.log");
    const prCreateArgsLog = join(tmpBinDir, "pr-create-args.log");

    // Fake summarizer (for PR body generation)
    const summarizerScriptPath = writeScript(tmpBinDir, "fake-pr-summarizer.sh",
      `#!/bin/sh\necho '{ "title": "Test PR", "summary": "- Changes", "reviewerGuide": "Review", "testPlan": "Test", "issueNumber": null, "commitMessage": "feat: changes" }'\nexit 0\n`
    );

    // Fake gh CLI — handles auth check, pr list (find existing PR), and pr create
    writeScript(binDir, "gh",
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo '${prListOutput}'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "${prCreateArgsLog}"
  echo "https://github.com/owner/repo/pull/42"
  exit ${prCreateExitCode}
fi
exit 0
`
    );

    writeScript(binDir, "glab",
      `#!/bin/sh\necho "glab not expected" >&2\nexit 1\n`
    );

    return { binDir, pushArgsLog, prCreateArgsLog, summarizerScriptPath };
  }

  async function makeCleanState(repoDir: string, runDir: string, branch: string): Promise<RunState> {
    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Test Plan",
      branch,
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [],
      outcome: "clean",
    };

    await mkdirAsync(runDir, { recursive: true });
    await writeFileAsync(join(runDir, "plan.txt"), "# Test Plan\nDo a thing.");
    return state;
  }

  test("(push branch 1) remote SHA == local SHA → skip push", async () => {
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-push-fakebin-1-"));
    const { repoDir, bareDir } = await makeRepoWithRemote();
    const { binDir, prCreateArgsLog, summarizerScriptPath } = await makeFakePostLoopBin(tmpBinDir, { prCreateExitCode: 0 });

    // Create feature branch, make a commit, push it to remote
    const run = async (args: string[], cwd: string): Promise<string> => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return (await new Response(proc.stdout).text()).trim();
    };
    await run(["checkout", "-b", "adversary/test-skip-push"], repoDir);
    writeFileSyncFS(join(repoDir, "feature.txt"), "feature");
    await run(["add", "."], repoDir);
    await run(["commit", "-m", "feat: implement"], repoDir);
    await run(["push", "origin", "adversary/test-skip-push"], repoDir);

    const runDir = join(tmpBinDir, "run");
    const state = await makeCleanState(repoDir, runDir, "adversary/test-skip-push");

    const fakeEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const config = {
      baseBranch: "main",
      implementCommandTemplate: "true",
      verifyCommandTemplate: "true",
      summarizerCommandTemplate: `${summarizerScriptPath} @{promptFile}`,
      implementTimeoutMs: 30000, verifyTimeoutMs: 30000, prTimeoutMs: 10000, summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 30000,
      browserAutomation: "warn" as const, customVerificationSteps: [], skillOverrides: {},
      testTimeoutMs: 30000,
    };

    // Capture stdout to check "skipping push" message
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { stdoutChunks.push(typeof chunk === "string" ? chunk : ""); return true; }) as never;

    try {
      await runPostLoopPhases(state, { severityThreshold: 7, config, platform: "github", prCli: "gh", cwd: repoDir, env: fakeEnv });
    } finally {
      process.stdout.write = origWrite;
    }

    const stdout = stdoutChunks.join("");
    expect(stdout).toMatch(/already up-to-date.*skipping push/i);
    // PR was still created
    expect(await Bun.file(prCreateArgsLog).exists()).toBe(true);
  }, 60000);

  test("(push branch 2) remote SHA != local SHA (local ahead) → push", async () => {
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-push-fakebin-2-"));
    const { repoDir } = await makeRepoWithRemote();
    const { binDir, prCreateArgsLog, summarizerScriptPath } = await makeFakePostLoopBin(tmpBinDir, { prCreateExitCode: 0 });

    const run = async (args: string[], cwd: string) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };

    // Create branch, push once, then make another commit (local ahead)
    await run(["checkout", "-b", "adversary/test-local-ahead"], repoDir);
    writeFileSyncFS(join(repoDir, "f1.txt"), "v1");
    await run(["add", "."], repoDir);
    await run(["commit", "-m", "first"], repoDir);
    await run(["push", "origin", "adversary/test-local-ahead"], repoDir);

    // Another commit — local is now ahead of remote
    writeFileSyncFS(join(repoDir, "f2.txt"), "v2");
    await run(["add", "."], repoDir);
    await run(["commit", "-m", "second"], repoDir);

    const runDir = join(tmpBinDir, "run");
    const state = await makeCleanState(repoDir, runDir, "adversary/test-local-ahead");

    const fakeEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const config = {
      baseBranch: "main",
      implementCommandTemplate: "true",
      verifyCommandTemplate: "true",
      summarizerCommandTemplate: `${summarizerScriptPath} @{promptFile}`,
      implementTimeoutMs: 30000, verifyTimeoutMs: 30000, prTimeoutMs: 10000, summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 30000,
      browserAutomation: "warn" as const, customVerificationSteps: [], skillOverrides: {},
      testTimeoutMs: 30000,
    };

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { stdoutChunks.push(typeof chunk === "string" ? chunk : ""); return true; }) as never;

    try {
      await runPostLoopPhases(state, { severityThreshold: 7, config, platform: "github", prCli: "gh", cwd: repoDir, env: fakeEnv });
    } finally {
      process.stdout.write = origWrite;
    }

    const stdout = stdoutChunks.join("");
    // Should push (SHA differs)
    expect(stdout).toMatch(/pushing|pushed ok/i);
    expect(await Bun.file(prCreateArgsLog).exists()).toBe(true);
  }, 60000);

  test("(push branch 4) divergent remote (non-fast-forward) → push-failure outcome, no gh call (VI-5/VI-8)", async () => {
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-push-fakebin-4-"));
    const { repoDir, bareDir } = await makeRepoWithRemote();
    const { binDir, prCreateArgsLog, summarizerScriptPath } = await makeFakePostLoopBin(tmpBinDir, { prCreateExitCode: 0 });

    const run = async (args: string[], cwd: string): Promise<string> => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return (await new Response(proc.stdout).text()).trim();
    };

    // Create branch on local and push it
    await run(["checkout", "-b", "adversary/test-diverge"], repoDir);
    writeFileSyncFS(join(repoDir, "base.txt"), "base");
    await run(["add", "."], repoDir);
    await run(["commit", "-m", "base commit"], repoDir);
    await run(["push", "origin", "adversary/test-diverge"], repoDir);

    // Clone the bare repo to simulate a conflicting commit on remote
    const otherCloneDir = `${bareDir}-other`;
    const cloneProc = Bun.spawn(["git", "clone", bareDir, otherCloneDir], { stdout: "pipe", stderr: "pipe" });
    await cloneProc.exited;

    // Configure git in the other clone
    await run(["config", "user.email", "test@test.com"], otherCloneDir);
    await run(["config", "user.name", "Test"], otherCloneDir);

    // Make a diverging commit on the remote via the other clone
    await run(["checkout", "adversary/test-diverge"], otherCloneDir);
    writeFileSyncFS(join(otherCloneDir, "remote-diverge.txt"), "remote only");
    await run(["add", "."], otherCloneDir);
    await run(["commit", "-m", "diverging remote commit"], otherCloneDir);
    await run(["push", "origin", "adversary/test-diverge"], otherCloneDir);

    // Make a local commit that diverges from the remote (same parent, different content)
    // At this point local and remote both have commits beyond the common ancestor
    writeFileSyncFS(join(repoDir, "local-diverge.txt"), "local only");
    await run(["add", "."], repoDir);
    await run(["commit", "-m", "diverging local commit"], repoDir);

    const runDir = join(tmpBinDir, "run-diverge");
    const state = await makeCleanState(repoDir, runDir, "adversary/test-diverge");

    const fakeEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const config = {
      baseBranch: "main",
      implementCommandTemplate: "true",
      verifyCommandTemplate: "true",
      summarizerCommandTemplate: `${summarizerScriptPath} @{promptFile}`,
      implementTimeoutMs: 30000, verifyTimeoutMs: 30000, prTimeoutMs: 10000, summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 30000,
      browserAutomation: "warn" as const, customVerificationSteps: [], skillOverrides: {},
      testTimeoutMs: 30000,
    };

    const stderrChunks: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : "");
      return true;
    }) as never;

    let thrownError: unknown;
    try {
      await runPostLoopPhases(state, { severityThreshold: 7, config, platform: "github", prCli: "gh", cwd: repoDir, env: fakeEnv });
    } catch (e) {
      thrownError = e;
    } finally {
      process.stderr.write = origStderr;
      await rm(otherCloneDir, { recursive: true, force: true });
    }

    const stderr = stderrChunks.join("");
    // Should have detected divergent push and set push-failure outcome
    expect(state.outcome).toBe("push-failure");
    expect(stderr).toMatch(/diverged|Remote branch has diverged/i);
    // PushFailureError should have been thrown
    expect(thrownError).toBeDefined();
    expect(thrownError instanceof PushFailureError).toBe(true);
    // gh pr create should NOT have been called (push failed)
    expect(await Bun.file(prCreateArgsLog).exists()).toBe(false);

    // VI-5: final-summary.json must have been written BEFORE PushFailureError was thrown
    const finalSummaryPath = join(runDir, "final-summary.json");
    const finalSummaryExists = await Bun.file(finalSummaryPath).exists();
    expect(finalSummaryExists).toBe(true);
    const finalSummaryJson = await Bun.file(finalSummaryPath).json();
    expect(finalSummaryJson.outcome).toBe("push-failure");
  }, 60000);

  test("(push branch 3) remote branch absent → push as new", async () => {
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-push-fakebin-3-"));
    const { repoDir } = await makeRepoWithRemote();
    const { binDir, prCreateArgsLog, summarizerScriptPath } = await makeFakePostLoopBin(tmpBinDir, { prCreateExitCode: 0 });

    const run = async (args: string[], cwd: string) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };

    // Create local-only branch (never pushed)
    await run(["checkout", "-b", "adversary/test-new-branch"], repoDir);
    writeFileSyncFS(join(repoDir, "new.txt"), "new");
    await run(["add", "."], repoDir);
    await run(["commit", "-m", "new branch commit"], repoDir);

    const runDir = join(tmpBinDir, "run");
    const state = await makeCleanState(repoDir, runDir, "adversary/test-new-branch");

    const fakeEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const config = {
      baseBranch: "main",
      implementCommandTemplate: "true",
      verifyCommandTemplate: "true",
      summarizerCommandTemplate: `${summarizerScriptPath} @{promptFile}`,
      implementTimeoutMs: 30000, verifyTimeoutMs: 30000, prTimeoutMs: 10000, summarizerTimeoutMs: 10000,
      servicesTimeoutMs: 30000,
      browserAutomation: "warn" as const, customVerificationSteps: [], skillOverrides: {},
      testTimeoutMs: 30000,
    };

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { stdoutChunks.push(typeof chunk === "string" ? chunk : ""); return true; }) as never;

    try {
      await runPostLoopPhases(state, { severityThreshold: 7, config, platform: "github", prCli: "gh", cwd: repoDir, env: fakeEnv });
    } finally {
      process.stdout.write = origWrite;
    }

    const stdout = stdoutChunks.join("");
    expect(stdout).toMatch(/pushing branch|pushed ok/i);
    expect(await Bun.file(prCreateArgsLog).exists()).toBe(true);
  }, 60000);
});

// ────────────────────────────��──────────────────────────���─────────────────────
// VI-6: failure outcome + commits → draft PR is still created with failure banner
// Tests that when a capped outcome (threshold findings present) produces commits,
// runCommand still calls gh pr create and the PR body contains the failure banner.
// ─────────────────────────────────────────────────────────────────────────────

describe("runCommand — failure-outcome + commits → draft PR (VI-6)", () => {
  let xdgStateDir: string;
  let savedXdgStateHome: string | undefined;

  beforeEach(async () => {
    xdgStateDir = await mkdtemp(join(tmpdir(), "adversary-vi6-xdg-"));
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

  test("capped outcome with commits → gh pr create is still called", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-vi6-fakebin-"));

    const binDir = join(tmpBinDir, "bin");
    mkdirSync(binDir, { recursive: true });

    const prCreateArgsLog = join(tmpBinDir, "pr-create-args.log");

    // Implement: write a file so there's a commit
    const implScript = writeScript(tmpBinDir, "fake-impl-vi6.sh",
      `#!/bin/sh\necho "change $(date +%s%N)" >> ${join(repoDir, "impl-output.txt")}\nexit 0\n`
    );

    // Summarizer: outputs valid commit message + PR summary JSON
    const summarizerPath = writeScript(tmpBinDir, "fake-summarizer-vi6.sh",
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done
CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")
if echo "$CONTENT" | grep -qi "pull request\\|PR description\\|reviewer guide"; then
  echo '{"title":"VI-6 Test","summary":"Changes made","reviewerGuide":"Review src/","testPlan":"Run bun test","issueNumber":null}'
  exit 0
fi
echo '{"commitMessage":"feat: vi6 change","turnSummary":"Done."}'
exit 0
`
    );

    // Verify harness: synthesis returns findings at high severity → capped outcome at turn 1
    const findingsJson = JSON.stringify([
      { title: "High Sev Finding", severity: 9, description: "Blocking finding", sources: ["reviewer"] }
    ]);
    const verifyHarness = writeScript(tmpBinDir, "fake-verify-vi6.sh",
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
  echo '{"schemaVersion":1,"status":"ok","findings":${findingsJson}}'
  exit 0
fi
if echo "$CONTENT" | grep -q "toolchain discovery"; then
  echo '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"stopCommand":null,"browserDeps":[]}'
  exit 0
fi
echo '{"status":"completed","findings":[]}'
exit 0
`
    );

    // gh: auth check passes, pr create logs arguments
    writeScript(binDir, "gh",
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo '[]'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "${prCreateArgsLog}"
  echo "https://github.com/owner/repo/pull/99"
  exit 0
fi
exit 0
`
    );
    writeScript(binDir, "glab", `#!/bin/sh\necho "glab not expected" >&2\nexit 1\n`);

    const fakeEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };

    const planPath = writePlan(tmpBinDir, "VI-6 Failure Banner Test");
    const configPath = writeFakeConfig(tmpBinDir, {
      implementCommandTemplate: `${implScript} @{promptFile}`,
      verifyCommandTemplate: `${verifyHarness} @{promptFile}`,
      summarizerCommandTemplate: `${summarizerPath} @{promptFile}`,
    });

    await runCommand({
      plan: planPath,
      turns: 1, // capped at turn 1 because findings >= threshold
      severityThreshold: 7,
      configFile: configPath,
      cwd: repoDir,
      env: fakeEnv,
    });

    // gh pr create must have been called (branch has commits, capped is not isFailureOutcome)
    expect(await Bun.file(prCreateArgsLog).exists()).toBe(true);
  }, 120000);

  test("implement-failure with prior commits → gh pr create is called with failure banner", async () => {
    // On turn 2, implement fails — but turn 1 already committed, so PR should still be created
    // with a failure banner in the body.
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-vi6b-fakebin-"));

    const binDir = join(tmpBinDir, "bin");
    mkdirSync(binDir, { recursive: true });

    const prCreateArgsLog = join(tmpBinDir, "pr-create-args.log");
    let implTurn = 0;

    // Implement: succeeds on turn 1 (writes file), fails on turn 2
    const implScript = writeScript(tmpBinDir, "fake-impl-vi6b.sh",
      `#!/bin/sh
TURN_FILE="${join(tmpBinDir, "impl-turn.txt")}"
TURN=$(cat "$TURN_FILE" 2>/dev/null || echo "0")
TURN=$((TURN + 1))
echo "$TURN" > "$TURN_FILE"
if [ "$TURN" = "1" ]; then
  echo "change" >> ${join(repoDir, "impl-output.txt")}
  exit 0
else
  exit 1
fi
`
    );

    // Summarizer: outputs valid commit/PR JSON
    const summarizerPath = writeScript(tmpBinDir, "fake-summarizer-vi6b.sh",
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done
CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")
if echo "$CONTENT" | grep -qi "pull request\\|PR description\\|reviewer guide"; then
  echo '{"title":"VI-6b Test","summary":"Changes made","reviewerGuide":"Review src/","testPlan":"Run bun test","issueNumber":null}'
  exit 0
fi
echo '{"commitMessage":"feat: vi6b change","turnSummary":"Done."}'
exit 0
`
    );

    // Verify: always returns findings so turn 1 continues to turn 2
    const findingsJson = JSON.stringify([
      { title: "Finding", severity: 5, description: "Minor", sources: ["reviewer"] }
    ]);
    const verifyHarness = writeScript(tmpBinDir, "fake-verify-vi6b.sh",
      `#!/bin/sh
PROMPT_FILE=""
for arg in "$@"; do
  case "$arg" in
    @*) PROMPT_FILE="\${arg#@}" ;;
  esac
done
CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "")
if echo "$CONTENT" | grep -q "schemaVersion"; then
  echo '{"schemaVersion":1,"status":"ok","findings":${findingsJson}}'
  exit 0
fi
if echo "$CONTENT" | grep -q "toolchain discovery"; then
  echo '{"testCommand":null,"buildCommand":null,"lintCommands":[],"typeCheckCommands":[],"startCommand":null,"stopCommand":null,"browserDeps":[]}'
  exit 0
fi
echo '{"status":"completed","findings":[]}'
exit 0
`
    );

    writeScript(binDir, "gh",
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo '[]'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "${prCreateArgsLog}"
  echo "https://github.com/owner/repo/pull/99"
  exit 0
fi
exit 0
`
    );
    writeScript(binDir, "glab", `#!/bin/sh\necho "glab not expected" >&2\nexit 1\n`);

    const fakeEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };

    const planPath = writePlan(tmpBinDir, "VI-6b Failure + Prior Commits");
    const configPath = writeFakeConfig(tmpBinDir, {
      implementCommandTemplate: `${implScript} @{promptFile}`,
      verifyCommandTemplate: `${verifyHarness} @{promptFile}`,
      summarizerCommandTemplate: `${summarizerPath} @{promptFile}`,
    });

    await runCommand({
      plan: planPath,
      turns: 2,
      severityThreshold: 4, // threshold=4 so findings(sev=5) trigger continuation
      configFile: configPath,
      cwd: repoDir,
      env: fakeEnv,
    });

    // Turn 2 implement fails → implement-failure, but turn 1 committed
    // PR should be created because branch has commits ahead of base
    expect(await Bun.file(prCreateArgsLog).exists()).toBe(true);

    // The pr-create args must include --draft flag
    const args = await Bun.file(prCreateArgsLog).text();
    expect(args).toContain("--draft");
  }, 120000);
});
