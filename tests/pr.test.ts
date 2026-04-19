import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";

import { extractUrl, createPr, PrError } from "../src/pr/index.js";
import type { RunState } from "../src/types/index.js";
import { runPostLoopPhases } from "../src/cli/run.js";
import { fileExists } from "../src/utils/fs.js";

describe("extractUrl", () => {
  test("extracts https URL from typical gh output", () => {
    const output = "https://github.com/owner/repo/pull/42\n";
    expect(extractUrl(output)).toBe("https://github.com/owner/repo/pull/42");
  });

  test("extracts URL from text with prefix message", () => {
    const output = "Creating PR... https://github.com/owner/repo/pull/1\nDone.";
    expect(extractUrl(output)).toBe("https://github.com/owner/repo/pull/1");
  });

  test("returns null when no URL present", () => {
    expect(extractUrl("PR creation failed")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractUrl("")).toBeNull();
  });

  test("handles http URL", () => {
    expect(extractUrl("http://example.com/pr/5")).toBe("http://example.com/pr/5");
  });
});

// Helper: create a minimal fake RunState
function makeState(): RunState {
  return {
    runDir: "/tmp/run",
    planFile: "/tmp/plan.md",
    planTitle: "My Feature Plan",
    branch: "adversary/20260410-123456-my-feature",
    baseBranch: "main",
    startedAt: new Date().toISOString(),
    turns: [],
  };
}

// Helper: write a fake script to a dir and return its full path.
// The script records all CLI arguments to an arg-log file if ARG_LOG is set.
function writeFakeScript(dir: string, name: string, content: string): string {
  const script = join(dir, name);
  writeFileSync(script, content, { mode: 0o755 });
  return script;
}

describe("createPr — gh path", () => {
  test("succeeds when fake gh script exits 0 with URL output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adversary-pr-test-"));
    const argLogFile = join(dir, "gh-args.log");
    // Write $@ one-per-line so we can assert exact arguments
    const fakeGhPath = writeFakeScript(
      dir,
      "gh",
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argLogFile}"\necho "https://github.com/owner/repo/pull/42"\nexit 0\n`
    );

    const state = makeState();
    // Pass the full path to the fake script so we don't need PATH manipulation
    const url = await createPr({
      state,
      platform: "github",
      prCli: fakeGhPath,
      prBody: "Test PR body",
      prTitle: "Add smart commit messages and rich PR descriptions",
      cwd: dir,
      timeoutMs: 10000,
    });
    expect(url).toContain("github.com");

    // Verify CLI arguments include required flags
    const args = readFileSync(argLogFile, "utf8").trim().split("\n");
    expect(args).toContain("pr");
    expect(args).toContain("create");
    expect(args).toContain("--draft");
    expect(args).toContain("--title");
    expect(args).toContain("Add smart commit messages and rich PR descriptions");
    expect(args).toContain("--head");
    expect(args).toContain(state.branch);
    expect(args).toContain("--base");
    expect(args).toContain(state.baseBranch);
  });

  test("throws PrError when fake gh script exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adversary-pr-test-"));
    const fakeGhPath = writeFakeScript(
      dir,
      "gh-fail",
      `#!/bin/sh\necho "authentication failed" >&2\nexit 1\n`
    );

    const state = makeState();
    await expect(
      createPr({
        state,
        platform: "github",
        prCli: fakeGhPath,
        prBody: "Test PR body",
        prTitle: "Test PR Title",
        cwd: dir,
        timeoutMs: 10000,
      })
    ).rejects.toBeInstanceOf(PrError);
  });
});

describe("createPr — glab path", () => {
  test("succeeds when fake glab script exits 0 with URL output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adversary-pr-test-glab-"));
    const argLogFile = join(dir, "glab-args.log");
    const fakeGlabPath = writeFakeScript(
      dir,
      "glab",
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argLogFile}"\necho "https://gitlab.com/owner/repo/-/merge_requests/7"\nexit 0\n`
    );

    const state = makeState();
    const url = await createPr({
      state,
      platform: "gitlab",
      prCli: fakeGlabPath,
      prBody: "Test MR body",
      prTitle: "LLM-generated MR title",
      cwd: dir,
      timeoutMs: 10000,
    });
    expect(url).toContain("gitlab.com");

    // Verify CLI arguments include required flags for glab
    const args = readFileSync(argLogFile, "utf8").trim().split("\n");
    expect(args).toContain("mr");
    expect(args).toContain("create");
    expect(args).toContain("--draft");
    expect(args).toContain("--title");
    expect(args).toContain("LLM-generated MR title");
    expect(args).toContain("--source-branch");
    expect(args).toContain(state.branch);
    expect(args).toContain("--target-branch");
    expect(args).toContain(state.baseBranch);
  });

  test("throws PrError when fake glab script exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adversary-pr-test-glab-"));
    const fakeGlabPath = writeFakeScript(
      dir,
      "glab-fail",
      `#!/bin/sh\necho "remote not found" >&2\nexit 2\n`
    );

    const state = makeState();
    await expect(
      createPr({
        state,
        platform: "gitlab",
        prCli: fakeGlabPath,
        prBody: "Test MR body",
        prTitle: "Test MR Title",
        cwd: dir,
        timeoutMs: 10000,
      })
    ).rejects.toBeInstanceOf(PrError);
  });
});

describe("createPr — timeout", () => {
  test("throws PrError when command exceeds timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adversary-pr-timeout-test-"));
    // Script that blocks with a Bun-friendly approach: spin loop so sh process itself
    // occupies CPU without spawning sub-processes (no SIGTERM propagation issues).
    const fakeGhPath = writeFakeScript(
      dir,
      "gh-slow",
      `#!/bin/sh\nwhile true; do :; done\n`
    );

    const state = makeState();
    await expect(
      createPr({
        state,
        platform: "github",
        prCli: fakeGhPath,
        prBody: "body",
        prTitle: "Test Title",
        cwd: dir,
        timeoutMs: 200, // 200ms — will definitely time out
      })
    ).rejects.toBeInstanceOf(PrError);
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
// VI-4: pr-title.txt resume path tests
// ─────────────────────────────────────────────────────────────────────────────

describe("runPostLoopPhases — pr-title.txt resume path (VI-4)", () => {
  let tmpDir: string;
  let fakeGhPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "adversary-prtitle-test-"));

    // Create a fake gh that returns a PR URL
    fakeGhPath = join(tmpDir, "fake-gh");
    await writeFile(
      fakeGhPath,
      `#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi\nif [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo '[]'; exit 0; fi\necho "https://github.com/owner/repo/pull/1"\nexit 0\n`
    );
    const chmod = Bun.spawn(["chmod", "+x", fakeGhPath], { stdout: "pipe", stderr: "pipe" });
    await chmod.exited;
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reuses pr-body.md and pr-title.txt when both exist — no regeneration", async () => {
    const runDir = join(tmpDir, "run-both-files");
    await mkdir(runDir, { recursive: true });

    // Pre-write pr-body.md and pr-title.txt
    const persistedTitle = "My persisted PR title";
    const persistedBody = "# My persisted PR title\n\nBody content here.";
    await writeFile(join(runDir, "pr-body.md"), persistedBody);
    await writeFile(join(runDir, "pr-title.txt"), persistedTitle);

    // Also write a plan.txt (needed by runPostLoopPhases)
    await writeFile(join(runDir, "plan.txt"), "# My persisted PR title\nDo stuff.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "My persisted PR title",
      branch: "adversary/test-branch",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [
        {
          turn: 1,
          implementCommand: "fake", verifyCommand: "fake",
          implementDurationMs: 0, verifyDurationMs: 0,
          repoChanged: false, verifyStatus: "ok",
          thresholdFindings: [], belowThresholdFindings: [],
          outcome: "clean",
        }
      ],
      outcome: "clean",
    };

    const stdoutChunks: string[] = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : "");
      return true;
    }) as never;

    try {
      await runPostLoopPhases(state, {
        severityThreshold: 7,
        config: {
          baseBranch: "main",
          implementCommandTemplate: "fake",
          verifyCommandTemplate: "fake",
          summarizerCommandTemplate: "fake",
          implementTimeoutMs: 300000,
          verifyTimeoutMs: 300000,
          testTimeoutMs: 300000,
          prTimeoutMs: 10000,
          summarizerTimeoutMs: 300000,
          servicesTimeoutMs: 300000,
          browserAutomation: "warn",
          customVerificationSteps: [],
          skillOverrides: {},
        },
        platform: "github",
        prCli: fakeGhPath as any,
        cwd: tmpDir,
        env: { ...process.env },
      });
    } catch {
      // push/PR creation may fail since we don't have a real git repo — that's OK
    } finally {
      process.stdout.write = origStdout;
    }

    const stdout = stdoutChunks.join("");
    // Should log that it's reusing the existing PR description
    expect(stdout).toMatch(/Reusing existing PR description/i);
    // Should NOT log "pr-title.txt not found" (fallback message)
    expect(stdout).not.toMatch(/pr-title\.txt not found/i);
  });

  test("logs fallback message when pr-body.md exists but pr-title.txt does not", async () => {
    const runDir = join(tmpDir, "run-body-only");
    await mkdir(runDir, { recursive: true });

    // Pre-write only pr-body.md (no pr-title.txt)
    const bodyWithoutH1 = "> ⚠️ This PR was generated by adversary.\n\nBody content.";
    await writeFile(join(runDir, "pr-body.md"), bodyWithoutH1);
    await writeFile(join(runDir, "plan.txt"), "# Plan Title\nDo stuff.");

    const state: RunState = {
      runDir,
      planFile: join(runDir, "plan.txt"),
      planTitle: "Plan Title",
      branch: "adversary/test-branch-2",
      baseBranch: "main",
      startedAt: new Date().toISOString(),
      turns: [
        {
          turn: 1,
          implementCommand: "fake", verifyCommand: "fake",
          implementDurationMs: 0, verifyDurationMs: 0,
          repoChanged: false, verifyStatus: "ok",
          thresholdFindings: [], belowThresholdFindings: [],
          outcome: "clean",
        }
      ],
      outcome: "clean",
    };

    const stdoutChunks: string[] = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : "");
      return true;
    }) as never;

    try {
      await runPostLoopPhases(state, {
        severityThreshold: 7,
        config: {
          baseBranch: "main",
          implementCommandTemplate: "fake",
          verifyCommandTemplate: "fake",
          summarizerCommandTemplate: "fake",
          implementTimeoutMs: 300000,
          verifyTimeoutMs: 300000,
          testTimeoutMs: 300000,
          prTimeoutMs: 10000,
          summarizerTimeoutMs: 300000,
          servicesTimeoutMs: 300000,
          browserAutomation: "warn",
          customVerificationSteps: [],
          skillOverrides: {},
        },
        platform: "github",
        prCli: fakeGhPath as any,
        cwd: tmpDir,
        env: { ...process.env },
      });
    } catch {
      // Expected — no real git remote
    } finally {
      process.stdout.write = origStdout;
    }

    const stdout = stdoutChunks.join("");
    // Should log the fallback message (VI-5)
    expect(stdout).toMatch(/pr-title\.txt not found/i);
  });
});
