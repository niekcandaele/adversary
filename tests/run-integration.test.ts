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
import { runCommand } from "../src/cli/run.js";
import { PrError } from "../src/pr/index.js";

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

  test("(a) verify-error outcome skips push and PR creation", async () => {
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
    expect(await argsFile.exists()).toBe(false);
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
});
