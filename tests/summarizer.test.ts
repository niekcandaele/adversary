import { test, expect, describe } from "bun:test";
import { extractJson, generateCommitMessage, generatePrSummary } from "../src/summarizer/index.js";
import { generateCommitMessagePrompt, generatePrBodyPrompt } from "../src/prompts/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdversaryConfig } from "../src/types/index.js";

// ── extractJson ───────────────────────────────────────────────────────────────

describe("extractJson", () => {
  test("parses clean JSON output", () => {
    const stdout = '{ "commitMessage": "Add foo feature" }';
    const result = extractJson(stdout) as Record<string, unknown>;
    expect(result.commitMessage).toBe("Add foo feature");
  });

  test("extracts JSON from output with preamble text", () => {
    const stdout = `Here is my analysis of the changes.
After reviewing the diff, I suggest this message:
{ "commitMessage": "Refactor config loader to support new fields" }
That should work well.`;
    const result = extractJson(stdout) as Record<string, unknown>;
    expect(result.commitMessage).toBe("Refactor config loader to support new fields");
  });

  test("extracts JSON from output with trailing text", () => {
    const stdout = `{ "title": "Add summarizer", "issueNumber": 42 } - end of output`;
    const result = extractJson(stdout) as Record<string, unknown>;
    expect(result.title).toBe("Add summarizer");
    expect(result.issueNumber).toBe(42);
  });

  test("handles nested JSON objects", () => {
    const stdout = `{ "outer": { "inner": "value" }, "count": 3 }`;
    const result = extractJson(stdout) as Record<string, unknown>;
    expect((result.outer as Record<string, unknown>).inner).toBe("value");
    expect(result.count).toBe(3);
  });

  test("handles JSON with strings containing braces", () => {
    const stdout = `{ "message": "Fix { broken } template" }`;
    const result = extractJson(stdout) as Record<string, unknown>;
    expect(result.message).toBe("Fix { broken } template");
  });

  test("throws when no JSON object found", () => {
    expect(() => extractJson("No JSON here at all")).toThrow();
  });

  test("throws for unbalanced braces", () => {
    expect(() => extractJson("{ unclosed brace")).toThrow();
  });

  test("handles preamble text containing literal { brace", () => {
    // The preamble has a '{' that is NOT part of the real JSON
    const stdout = `I created a { complex } result:\n{"commitMessage": "fix: auth"}`;
    const result = extractJson(stdout) as Record<string, unknown>;
    expect(result.commitMessage).toBe("fix: auth");
  });

  test("handles escaped quotes inside JSON string values", () => {
    const stdout = `{"msg": "He said \\"hello\\""}`;
    const result = extractJson(stdout) as Record<string, unknown>;
    expect(result.msg).toBe('He said "hello"');
  });

  test("handles null issueNumber in PR summary JSON", () => {
    const stdout = `{ "title": "My PR", "summary": "x", "reviewerGuide": "y", "testPlan": "z", "issueNumber": null }`;
    const result = extractJson(stdout) as Record<string, unknown>;
    expect(result.issueNumber).toBeNull();
  });
});

// ── generateCommitMessagePrompt ───────────────────────────────────────────────

describe("generateCommitMessagePrompt", () => {
  test("writes file and returns content string", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "adversary-summarizer-test-"));
    try {
      const outputPath = join(tmpDir, "commit-msg-prompt.md");
      const content = await generateCommitMessagePrompt({
        branch: "adversary/2026-feature",
        planTitle: "Build a feature",
        turn: 2,
        outputPath,
      });

      expect(content).toContain("adversary/2026-feature");
      expect(content).toContain("Build a feature");
      expect(content).toContain("Turn number: 2");
      expect(content).toContain("commitMessage");

      const file = Bun.file(outputPath);
      expect(await file.exists()).toBe(true);
      const text = await file.text();
      expect(text).toBe(content);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("content instructs agent to return JSON with commitMessage key", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "adversary-summarizer-test-"));
    try {
      const content = await generateCommitMessagePrompt({
        branch: "feature/branch",
        planTitle: "My Plan",
        turn: 1,
        outputPath: join(tmpDir, "prompt.md"),
      });

      // Must tell agent to return JSON
      expect(content).toContain("JSON");
      expect(content).toContain('"commitMessage"');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── generatePrBodyPrompt ──────────────────────────────────────────────────────

describe("generatePrBodyPrompt", () => {
  test("writes file and returns content string", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "adversary-summarizer-test-"));
    try {
      const outputPath = join(tmpDir, "pr-body-prompt.md");
      const content = await generatePrBodyPrompt({
        branch: "adversary/feature",
        baseBranch: "main",
        planTitle: "Improve system",
        planContent: "# Improve system\n\nDo stuff.",
        outputPath,
      });

      expect(content).toContain("adversary/feature");
      expect(content).toContain("main");
      expect(content).toContain("Improve system");
      expect(content).toContain("title");
      expect(content).toContain("summary");
      expect(content).toContain("reviewerGuide");
      expect(content).toContain("testPlan");
      expect(content).toContain("issueNumber");

      const file = Bun.file(outputPath);
      expect(await file.exists()).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("includes plan content in output", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "adversary-summarizer-test-"));
    try {
      const planContent = "# My Plan\n\nCloses issue #99. Do important things.";
      const content = await generatePrBodyPrompt({
        branch: "feature/branch",
        baseBranch: "develop",
        planTitle: "My Plan",
        planContent,
        outputPath: join(tmpDir, "prompt.md"),
      });

      expect(content).toContain(planContent);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("instructs agent to return JSON with required keys", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "adversary-summarizer-test-"));
    try {
      const content = await generatePrBodyPrompt({
        branch: "feature/branch",
        baseBranch: "main",
        planTitle: "Test Plan",
        planContent: "# Test Plan\n\nBuild stuff.",
        outputPath: join(tmpDir, "prompt.md"),
      });

      expect(content).toContain("JSON");
      expect(content).toContain('"title"');
      expect(content).toContain('"summary"');
      expect(content).toContain('"reviewerGuide"');
      expect(content).toContain('"testPlan"');
      expect(content).toContain('"issueNumber"');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── generateCommitMessage unit tests ─────────────────────────────────────────

function makeConfig(summarizerScript: string): AdversaryConfig {
  return {
    implementCommandTemplate: "true",
    verifyCommandTemplate: "true",
    summarizerCommandTemplate: summarizerScript,
    implementTimeoutMs: 10000,
    verifyTimeoutMs: 10000,
    testTimeoutMs: 30000,
    prTimeoutMs: 10000,
    summarizerTimeoutMs: 10000,
    servicesTimeoutMs: 10000,
    browserAutomation: "warn",
    customVerificationSteps: [],
    skillOverrides: {},
  };
}

async function makeGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "adversary-summarizer-unit-"));
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };
  await run("git", "init", "-b", "main");
  await run("git", "config", "user.email", "test@test.com");
  await run("git", "config", "user.name", "Test");
  return dir;
}

describe("generateCommitMessage", () => {
  test("returns commitMessage from summarizer script output", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-commit-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "commitMessage": "feat: add smart commit messages" }'\nexit 0\n`,
        { mode: 0o755 }
      );
      const turnDir = join(tmpDir, "turn-1");
      await Bun.spawn(["mkdir", "-p", turnDir], { cwd: tmpDir }).exited;

      const config = makeConfig(script);
      const result = await generateCommitMessage({
        config,
        turnDir,
        branch: "adversary/test",
        planTitle: "Test Plan",
        turn: 1,
        cwd,
      });

      expect(result.commitMessage).toBe("feat: add smart commit messages");
      expect(result.turnSummary).toBe("");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("returns turnSummary when provided by summarizer", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-commit-summary-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "commitMessage": "feat: add analytics", "turnSummary": "Added ClickHouse reader and analytics service." }'\nexit 0\n`,
        { mode: 0o755 }
      );
      const turnDir = join(tmpDir, "turn-1");
      await Bun.spawn(["mkdir", "-p", turnDir], { cwd: tmpDir }).exited;

      const config = makeConfig(script);
      const result = await generateCommitMessage({
        config,
        turnDir,
        branch: "adversary/test",
        planTitle: "Test Plan",
        turn: 1,
        cwd,
      });

      expect(result.commitMessage).toBe("feat: add analytics");
      expect(result.turnSummary).toBe("Added ClickHouse reader and analytics service.");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when summarizer exits non-zero", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-commit-fail-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "fail-summarizer.sh");
      writeFileSync(script, `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
      const turnDir = join(tmpDir, "turn-1");
      await Bun.spawn(["mkdir", "-p", turnDir], { cwd: tmpDir }).exited;

      const config = makeConfig(script);
      await expect(
        generateCommitMessage({
          config,
          turnDir,
          branch: "adversary/test",
          planTitle: "Test Plan",
          turn: 1,
          cwd,
        })
      ).rejects.toThrow("Summarizer command failed");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when summarizer outputs invalid JSON", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-commit-invalid-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "invalid-summarizer.sh");
      writeFileSync(script, `#!/bin/sh\necho 'not json at all'\nexit 0\n`, { mode: 0o755 });
      const turnDir = join(tmpDir, "turn-1");
      await Bun.spawn(["mkdir", "-p", turnDir], { cwd: tmpDir }).exited;

      const config = makeConfig(script);
      await expect(
        generateCommitMessage({
          config,
          turnDir,
          branch: "adversary/test",
          planTitle: "Test Plan",
          turn: 1,
          cwd,
        })
      ).rejects.toThrow();
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when commitMessage field is missing from JSON", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-commit-missing-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "missing-field-summarizer.sh");
      writeFileSync(script, `#!/bin/sh\necho '{ "something": "else" }'\nexit 0\n`, { mode: 0o755 });
      const turnDir = join(tmpDir, "turn-1");
      await Bun.spawn(["mkdir", "-p", turnDir], { cwd: tmpDir }).exited;

      const config = makeConfig(script);
      await expect(
        generateCommitMessage({
          config,
          turnDir,
          branch: "adversary/test",
          planTitle: "Test Plan",
          turn: 1,
          cwd,
        })
      ).rejects.toThrow("invalid commitMessage");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  // VI-11: whitespace-only commitMessage is rejected
  test("throws when commitMessage is whitespace-only", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-commit-ws-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "whitespace-summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "commitMessage": "     " }'\nexit 0\n`,
        { mode: 0o755 }
      );
      const turnDir = join(tmpDir, "turn-1");
      await Bun.spawn(["mkdir", "-p", turnDir], { cwd: tmpDir }).exited;

      const config = makeConfig(script);
      await expect(
        generateCommitMessage({
          config,
          turnDir,
          branch: "adversary/test",
          planTitle: "Test Plan",
          turn: 1,
          cwd,
        })
      ).rejects.toThrow("invalid commitMessage");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });
});

// ── generatePrSummary unit tests ──────────────────────────────────────────────

describe("generatePrSummary", () => {
  test("returns parsed PR summary from summarizer script output", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-pr-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "pr-summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "title": "My PR", "summary": "Changes made", "reviewerGuide": "Check src/", "testPlan": "Run tests", "issueNumber": 42 }'\nexit 0\n`,
        { mode: 0o755 }
      );
      const runDir = tmpDir;

      const config = makeConfig(script);
      const result = await generatePrSummary({
        config,
        runDir,
        branch: "adversary/test",
        baseBranch: "main",
        planTitle: "Test Plan",
        planContent: "# Test Plan\nDo stuff.",
        cwd,
      });

      expect(result.title).toBe("My PR");
      expect(result.summary).toBe("Changes made");
      expect(result.reviewerGuide).toBe("Check src/");
      expect(result.testPlan).toBe("Run tests");
      expect(result.issueNumber).toBe(42);
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when PR summarizer exits non-zero", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-pr-fail-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "fail-pr-summarizer.sh");
      writeFileSync(script, `#!/bin/sh\nexit 1\n`, { mode: 0o755 });

      const config = makeConfig(script);
      await expect(
        generatePrSummary({
          config,
          runDir: tmpDir,
          branch: "adversary/test",
          baseBranch: "main",
          planTitle: "Test Plan",
          planContent: "# Test Plan\nDo stuff.",
          cwd,
        })
      ).rejects.toThrow("PR summarizer command failed");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when PR summarizer returns invalid JSON", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-pr-invalid-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "invalid-pr-summarizer.sh");
      writeFileSync(script, `#!/bin/sh\necho 'not json'\nexit 0\n`, { mode: 0o755 });

      const config = makeConfig(script);
      await expect(
        generatePrSummary({
          config,
          runDir: tmpDir,
          branch: "adversary/test",
          baseBranch: "main",
          planTitle: "Test Plan",
          planContent: "# Test Plan\nDo stuff.",
          cwd,
        })
      ).rejects.toThrow();
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when PR summarizer returns JSON with wrong-typed title (number)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-pr-wrongtype-title-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "wrongtype-title-summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "title": 123, "summary": "s", "reviewerGuide": "rg", "testPlan": "tp", "issueNumber": null }'\nexit 0\n`,
        { mode: 0o755 }
      );

      const config = makeConfig(script);
      await expect(
        generatePrSummary({
          config,
          runDir: tmpDir,
          branch: "adversary/test",
          baseBranch: "main",
          planTitle: "Test Plan",
          planContent: "# Test Plan\nDo stuff.",
          cwd,
        })
      ).rejects.toThrow("invalid title");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when PR summarizer returns JSON with null summary", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-pr-wrongtype-summary-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "wrongtype-summary-summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "title": "My PR", "summary": null, "reviewerGuide": "rg", "testPlan": "tp", "issueNumber": null }'\nexit 0\n`,
        { mode: 0o755 }
      );

      const config = makeConfig(script);
      await expect(
        generatePrSummary({
          config,
          runDir: tmpDir,
          branch: "adversary/test",
          baseBranch: "main",
          planTitle: "Test Plan",
          planContent: "# Test Plan\nDo stuff.",
          cwd,
        })
      ).rejects.toThrow("invalid summary");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when PR summarizer returns JSON with wrong-typed reviewerGuide (number)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-pr-wrongtype-rg-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "wrongtype-rg-summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "title": "My PR", "summary": "s", "reviewerGuide": 42, "testPlan": "tp", "issueNumber": null }'\nexit 0\n`,
        { mode: 0o755 }
      );

      const config = makeConfig(script);
      await expect(
        generatePrSummary({
          config,
          runDir: tmpDir,
          branch: "adversary/test",
          baseBranch: "main",
          planTitle: "Test Plan",
          planContent: "# Test Plan\nDo stuff.",
          cwd,
        })
      ).rejects.toThrow("invalid reviewerGuide");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when PR summarizer returns JSON with wrong-typed testPlan (boolean)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-pr-wrongtype-tp-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "wrongtype-tp-summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "title": "My PR", "summary": "s", "reviewerGuide": "rg", "testPlan": true, "issueNumber": null }'\nexit 0\n`,
        { mode: 0o755 }
      );

      const config = makeConfig(script);
      await expect(
        generatePrSummary({
          config,
          runDir: tmpDir,
          branch: "adversary/test",
          baseBranch: "main",
          planTitle: "Test Plan",
          planContent: "# Test Plan\nDo stuff.",
          cwd,
        })
      ).rejects.toThrow("invalid testPlan");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("throws when PR summarizer returns JSON with string issueNumber", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-pr-wrongtype-issue-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "wrongtype-issue-summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "title": "My PR", "summary": "s", "reviewerGuide": "rg", "testPlan": "tp", "issueNumber": "string" }'\nexit 0\n`,
        { mode: 0o755 }
      );

      const config = makeConfig(script);
      await expect(
        generatePrSummary({
          config,
          runDir: tmpDir,
          branch: "adversary/test",
          baseBranch: "main",
          planTitle: "Test Plan",
          planContent: "# Test Plan\nDo stuff.",
          cwd,
        })
      ).rejects.toThrow("invalid issueNumber");
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });

  test("handles null issueNumber in PR summary", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adversary-gen-pr-null-issue-"));
    const cwd = await makeGitRepo();
    try {
      const script = join(tmpDir, "null-issue-summarizer.sh");
      writeFileSync(
        script,
        `#!/bin/sh\necho '{ "title": "PR", "summary": "S", "reviewerGuide": "RG", "testPlan": "TP", "issueNumber": null }'\nexit 0\n`,
        { mode: 0o755 }
      );

      const config = makeConfig(script);
      const result = await generatePrSummary({
        config,
        runDir: tmpDir,
        branch: "adversary/test",
        baseBranch: "main",
        planTitle: "Test Plan",
        planContent: "# Test Plan\nDo stuff.",
        cwd,
      });

      expect(result.issueNumber).toBeNull();
    } finally {
      await Bun.spawn(["rm", "-rf", tmpDir, cwd]).exited;
    }
  });
});
