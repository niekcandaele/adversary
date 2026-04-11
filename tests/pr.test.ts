import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";

import { extractUrl, createPr, PrError } from "../src/pr/index.js";
import type { RunState } from "../src/types/index.js";

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
