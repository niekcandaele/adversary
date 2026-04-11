/**
 * Integration tests for runCommand (src/cli/run.ts)
 *
 * These tests exercise the runCommand orchestrator using fake scripts
 * in a real git repo, similar to the runLoop integration tests.
 *
 * Focused on:
 * (a) failure outcome (implement-failure, verify-failure, verify-blocked, verify-error)
 *     must skip push/PR — no gh pr create call is made
 * (b) PrError from createPr must propagate (throw) out of runCommand
 */
import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { runCommand } from "../src/cli/run.js";
import { PrError } from "../src/pr/index.js";

/**
 * Create a minimal git repo with initial commit and a local bare remote.
 * This avoids needing to fake git push — the push goes to a local bare repo.
 * Returns the repo dir.
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
    ["sh", "-c", "echo 'init' > README.md && git add -A && git commit -m init"],
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
 * Build a fake bin directory with all required scripts.
 *
 * The fake 'gh' script distinguishes 'auth status' from 'pr create':
 * - 'auth status' always exits 0 (preflight passes)
 * - 'pr create' exits with prCreateExitCode and optionally logs args
 *
 * The fake 'git' delegates real git commands but intercepts 'push' to
 * succeed silently (no real remote needed).
 *
 * Returns: { binDir, verifyScriptPath, prCreateArgsLog, summarizerScriptPath }
 */
function makeFakeBin(tmpDir: string, opts: {
  implementExitCode?: number;
  verifyStatus?: "ok" | "blocked" | "error";
  prCreateExitCode?: number;
  prCreateOutput?: string;
}): { binDir: string; verifyScriptPath: string; prCreateArgsLog: string; summarizerScriptPath: string } {
  const {
    implementExitCode = 0,
    verifyStatus = "ok",
    prCreateExitCode = 0,
    prCreateOutput = "https://github.com/owner/repo/pull/99",
  } = opts;

  const binDir = join(tmpDir, "bin");
  mkdirSync(binDir, { recursive: true });

  // Log file for 'gh pr create' args
  const prCreateArgsLog = join(tmpDir, "pr-create-args.log");

  // Fake 'pi' — exits 0 for --help (preflight check), and with implementExitCode otherwise.
  writeScript(binDir, "pi",
    `#!/bin/sh\nif [ "$1" = "--help" ]; then\n  exit 0\nfi\nexit ${implementExitCode}\n`
  );

  // Fake summarizer script — outputs valid PR summary JSON
  const summarizerScriptPath = writeScript(binDir, "fake-summarizer.sh",
    `#!/bin/sh\necho '{ "title": "Implement plan changes", "summary": "- Changes made", "reviewerGuide": "Review src/ changes", "testPlan": "Run bun test", "issueNumber": null }'\nexit 0\n`
  );

  // Fake verify JSON
  const verifyJsonPath = join(tmpDir, "verify-output.json");
  const findings = verifyStatus === "blocked"
    ? [{ title: "Blocked", severity: 9, description: "Blocked", sources: ["qa"] }]
    : [];
  writeFileSync(verifyJsonPath, JSON.stringify({
    schemaVersion: 1,
    status: verifyStatus,
    findings,
  }));

  // Fake verify script
  const verifyScriptPath = join(binDir, "verify-script.sh");
  writeScript(binDir, "verify-script.sh",
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --output=*) OUTPUT="\${arg#*=}" ;;
  esac
done
if [ -n "$OUTPUT" ]; then
  cp "${verifyJsonPath}" "$OUTPUT"
fi
exit 0
`
  );

  // Fake 'gh' — handles both 'auth status' (preflight) and 'pr create'
  writeScript(binDir, "gh",
    `#!/bin/sh
# Detect subcommand: 'auth status' vs 'pr create'
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "${prCreateArgsLog}"
  echo "${prCreateOutput}"
  exit ${prCreateExitCode}
fi
# Any other gh command: succeed silently
exit 0
`
  );

  // Fake 'glab' — not expected to be called
  writeScript(binDir, "glab",
    `#!/bin/sh\necho "glab not expected" >&2\nexit 1\n`
  );

  // Note: we do NOT fake 'git' — real git push goes to a local bare repo (set up as origin).
  // This avoids Bun's PATH caching issue where Bun resolves 'git' at import time.

  return { binDir, verifyScriptPath, prCreateArgsLog, summarizerScriptPath };
}

/**
 * Write a fake config file to a temp dir OUTSIDE the repo (so it doesn't
 * create untracked files in the working tree).
 */
function writeFakeConfig(tmpDir: string, binDir: string, verifyScriptPath: string, summarizerScriptPath: string): string {
  const configPath = join(tmpDir, ".pi-adversary.json");
  const config = {
    baseBranch: "main",
    implementCommandTemplate: `${join(binDir, "pi")} -p {promptFile}`,
    verifyCommandTemplate: `${verifyScriptPath} --output={verifyOutputFile}`,
    summarizerCommandTemplate: summarizerScriptPath,
    implementTimeoutMs: 15000,
    verifyTimeoutMs: 15000,
    prTimeoutMs: 15000,
    summarizerTimeoutMs: 15000,
  };
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

/**
 * Run runCommand with a fake PATH (via options.env) and explicit cwd (via options.cwd).
 *
 * This avoids mutating process.env.PATH and calling process.chdir(), both of which
 * are global process state mutations that are unsafe for parallel test execution.
 * Instead, we pass the env and cwd directly to runCommand so each test is isolated.
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
  test("(a) implement-failure outcome skips push and PR creation", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-"));
    const { binDir, verifyScriptPath, prCreateArgsLog, summarizerScriptPath } = makeFakeBin(tmpBinDir, {
      implementExitCode: 1, // implement fails → implement-failure
      verifyStatus: "ok",
      prCreateExitCode: 0,
    });

    // Plan and config go into tmpBinDir (outside the repo) to keep working tree clean
    const planPath = writePlan(tmpBinDir, "Test Impl Failure Skips PR");
    const configPath = writeFakeConfig(tmpBinDir, binDir, verifyScriptPath, summarizerScriptPath);

    // runCommand should complete without throwing (failure outcome = exit 0)
    await runWithFakePath(repoDir, binDir, planPath, configPath);

    // 'gh pr create' must NOT have been called
    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(false);
  }, 60000);

  test("(a) verify-blocked outcome skips push and PR creation", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-blocked-"));
    const { binDir, verifyScriptPath, prCreateArgsLog, summarizerScriptPath } = makeFakeBin(tmpBinDir, {
      implementExitCode: 0,
      verifyStatus: "blocked",
      prCreateExitCode: 0,
    });

    const planPath = writePlan(tmpBinDir, "Test Blocked Skips PR");
    const configPath = writeFakeConfig(tmpBinDir, binDir, verifyScriptPath, summarizerScriptPath);

    await runWithFakePath(repoDir, binDir, planPath, configPath);

    // 'gh pr create' must NOT have been called
    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(false);
  }, 60000);

  test("(a) verify-error outcome skips push and PR creation", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-verifyerror-"));
    const { binDir, verifyScriptPath, prCreateArgsLog, summarizerScriptPath } = makeFakeBin(tmpBinDir, {
      implementExitCode: 0,
      verifyStatus: "error",
      prCreateExitCode: 0,
    });

    const planPath = writePlan(tmpBinDir, "Test Verify Error Skips PR");
    const configPath = writeFakeConfig(tmpBinDir, binDir, verifyScriptPath, summarizerScriptPath);

    await runWithFakePath(repoDir, binDir, planPath, configPath);

    // 'gh pr create' must NOT have been called
    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(false);
  }, 60000);

  test("(b) PrError from createPr propagates out of runCommand", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-prerror-"));
    const { binDir, verifyScriptPath, summarizerScriptPath } = makeFakeBin(tmpBinDir, {
      implementExitCode: 0,
      verifyStatus: "ok",
      prCreateExitCode: 1, // gh pr create fails → PrError
      prCreateOutput: "authentication failed",
    });

    const planPath = writePlan(tmpBinDir, "Test PrError Propagation");
    const configPath = writeFakeConfig(tmpBinDir, binDir, verifyScriptPath, summarizerScriptPath);

    await runWithFakePath(repoDir, binDir, planPath, configPath, PrError);
  }, 60000);

  test("(c) PR summarizer failure throws out of runCommand", async () => {
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-pr-summary-fail-"));

    // Build a bin dir where the summarizer for PR summary fails
    const binDir = join(tmpBinDir, "bin");
    mkdirSync(binDir, { recursive: true });

    const prCreateArgsLog = join(tmpBinDir, "pr-create-args.log");

    // Fake 'pi' — exits 0 for --help (preflight check), and 0 otherwise (implement succeeds)
    writeScript(binDir, "pi",
      `#!/bin/sh\nif [ "$1" = "--help" ]; then\n  exit 0\nfi\nexit 0\n`
    );

    // Fake summarizer — fails (exits non-zero) to simulate PR summarizer failure
    const failSummarizerScript = writeScript(tmpBinDir, "fail-pr-summarizer.sh",
      `#!/bin/sh\nexit 1\n`
    );

    // Fake verify JSON (clean — so loop completes and we reach PR creation)
    const verifyJsonPath = join(tmpBinDir, "verify-output.json");
    writeFileSync(verifyJsonPath, JSON.stringify({
      schemaVersion: 1,
      status: "ok",
      findings: [],
    }));

    const verifyScriptPath = join(binDir, "verify-script.sh");
    writeScript(binDir, "verify-script.sh",
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --output=*) OUTPUT="\${arg#*=}" ;;
  esac
done
if [ -n "$OUTPUT" ]; then
  cp "${verifyJsonPath}" "$OUTPUT"
fi
exit 0
`
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

    const configPath = join(tmpBinDir, ".pi-adversary.json");
    const config = {
      baseBranch: "main",
      implementCommandTemplate: `${join(binDir, "pi")} -p {promptFile}`,
      verifyCommandTemplate: `${verifyScriptPath} --output={verifyOutputFile}`,
      summarizerCommandTemplate: failSummarizerScript,
      implementTimeoutMs: 15000,
      verifyTimeoutMs: 15000,
      prTimeoutMs: 15000,
      summarizerTimeoutMs: 15000,
    };
    writeFileSync(configPath, JSON.stringify(config));

    const planPath = writePlan(tmpBinDir, "Test PR Summary Failure Throws");

    const fakeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    // PR summarizer failure must throw with a message indicating the summarizer failed
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

    // 'gh pr create' must NOT have been called since summary failed
    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(false);
  }, 60000);

  test("(d) summarizer-failure (commit-msg) skips push and PR creation", async () => {
    // This test verifies VI-1: summarizer-failure must be included in isFailureOutcome.
    // Implement succeeds and makes repo changes, but the commit-message summarizer fails.
    // runCommand must NOT push or call 'gh pr create'.
    const repoDir = await makeGitRepo();
    const tmpBinDir = mkdtempSync(join(tmpdir(), "adversary-run-fakebin-summfail-"));

    const binDir = join(tmpBinDir, "bin");
    mkdirSync(binDir, { recursive: true });

    const prCreateArgsLog = join(tmpBinDir, "pr-create-args.log");

    // Fake 'pi' — exits 0 for --help (preflight), and creates a repo change on normal run
    // so that hasChanges() returns true and generateCommitMessage is called.
    writeScript(binDir, "pi",
      `#!/bin/sh
if [ "$1" = "--help" ]; then
  exit 0
fi
# Create a file change in cwd so the repo has staged changes
echo "change $(date +%s%N)" >> implement-output.txt
exit 0
`
    );

    // Commit-message summarizer fails (exits non-zero)
    const failSummarizerScript = writeScript(tmpBinDir, "fail-commit-summarizer.sh",
      `#!/bin/sh\nexit 1\n`
    );

    // Fake verify JSON (won't be reached because summarizer fails first, but needed for config)
    const verifyJsonPath = join(tmpBinDir, "verify-output.json");
    writeFileSync(verifyJsonPath, JSON.stringify({
      schemaVersion: 1,
      status: "ok",
      findings: [],
    }));

    const verifyScriptPath = join(tmpBinDir, "verify-script.sh");
    writeScript(tmpBinDir, "verify-script.sh",
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --output=*) OUTPUT="\${arg#*=}" ;;
  esac
done
if [ -n "$OUTPUT" ]; then
  cp "${verifyJsonPath}" "$OUTPUT"
fi
exit 0
`
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

    const configPath = join(tmpBinDir, ".pi-adversary.json");
    const config = {
      baseBranch: "main",
      implementCommandTemplate: `${join(binDir, "pi")} -p {promptFile}`,
      verifyCommandTemplate: `${verifyScriptPath} --output={verifyOutputFile}`,
      summarizerCommandTemplate: failSummarizerScript,
      implementTimeoutMs: 15000,
      verifyTimeoutMs: 15000,
      prTimeoutMs: 15000,
      summarizerTimeoutMs: 15000,
    };
    writeFileSync(configPath, JSON.stringify(config));

    const planPath = writePlan(tmpBinDir, "Test Commit-Msg Summarizer Failure Skips PR");

    const fakeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    // runCommand should resolve without throwing — summarizer-failure is a terminal outcome (exit 0)
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

    // 'gh pr create' must NOT have been called
    const argsFile = Bun.file(prCreateArgsLog);
    expect(await argsFile.exists()).toBe(false);
  }, 60000);
});
