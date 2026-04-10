import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateFirstTurnPrompt,
  generateLaterTurnPrompt,
  generateFindingsFile,
  generateHistoryFile,
} from "../src/prompts/index.js";
import type { VerifyFinding, TurnResult } from "../src/types/index.js";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "adversary-prompts-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("generateFirstTurnPrompt", () => {
  test("includes plan content", async () => {
    const outputPath = join(tmpDir, "first-turn.md");
    const content = await generateFirstTurnPrompt({
      planContent: "# My Plan\n\nDo stuff.",
      threshold: 7,
      turn: 1,
      maxTurns: 5,
      branch: "adversary/20260410-feature",
      outputPath,
    });

    expect(content).toContain("Turn 1 of 5");
    expect(content).toContain("# My Plan");
    expect(content).toContain("Severity Threshold");
    expect(content).toContain("7");
    expect(content).toContain("adversary/20260410-feature");
    // Must tell agent not to manage git
    expect(content).toContain("Do NOT manage git");
    // Must tell agent not to run verify
    expect(content).toContain("Do NOT run the verify");

    // Verify it was written to file
    const written = await Bun.file(outputPath).text();
    expect(written).toBe(content);
  });
});

describe("generateLaterTurnPrompt", () => {
  test("includes findings and history", async () => {
    const outputPath = join(tmpDir, "later-turn.md");
    const findings: VerifyFinding[] = [
      {
        title: "Missing tests",
        severity: 8,
        location: { path: "src/main.ts", line: 10 },
        description: "No unit tests for critical path.",
        sources: ["qa"],
      },
    ];

    const content = await generateLaterTurnPrompt({
      planContent: "# Original Plan\n\nDo stuff.",
      threshold: 7,
      turn: 2,
      maxTurns: 5,
      branch: "adversary/20260410-feature",
      thresholdFindings: findings,
      historyContent: "## Turn 1\n\n- Outcome: continue",
      outputPath,
    });

    expect(content).toContain("Turn 2 of 5");
    expect(content).toContain("Missing tests");
    expect(content).toContain("severity 8");
    expect(content).toContain("src/main.ts");
    expect(content).toContain("Turn 1");
    expect(content).toContain("# Original Plan");
    expect(content).toContain("Do NOT manage git");
    expect(content).toContain("Do NOT run the verify");
  });
});

describe("generateFindingsFile", () => {
  test("outputs no findings message when empty", async () => {
    const outputPath = join(tmpDir, "findings-empty.md");
    await generateFindingsFile([], 7, outputPath);
    const content = await Bun.file(outputPath).text();
    expect(content).toContain("No findings");
  });

  test("includes findings in output", async () => {
    const outputPath = join(tmpDir, "findings.md");
    const findings: VerifyFinding[] = [
      { title: "Test Issue", severity: 9, description: "Desc", sources: ["reviewer"] },
    ];
    await generateFindingsFile(findings, 7, outputPath);
    const content = await Bun.file(outputPath).text();
    expect(content).toContain("Test Issue");
    expect(content).toContain("severity 9");
  });
});

describe("generateHistoryFile", () => {
  test("outputs no turns message when empty", async () => {
    const outputPath = join(tmpDir, "history-empty.md");
    await generateHistoryFile([], outputPath);
    const content = await Bun.file(outputPath).text();
    expect(content).toContain("No previous turns");
  });

  test("includes turn data", async () => {
    const outputPath = join(tmpDir, "history.md");
    const turns: TurnResult[] = [
      {
        turn: 1,
        implementCommand: "pi -p @prompt.md",
        verifyCommand: "pi -p verify",
        implementDurationMs: 5000,
        verifyDurationMs: 3000,
        repoChanged: true,
        commitSha: "abc1234def5678",
        verifyStatus: "ok",
        thresholdFindings: [{ title: "Issue A", severity: 8, description: "Desc", sources: [] }],
        belowThresholdFindings: [],
        outcome: "continue",
      },
    ];
    await generateHistoryFile(turns, outputPath);
    const content = await Bun.file(outputPath).text();
    expect(content).toContain("Turn 1");
    expect(content).toContain("abc1234");
    expect(content).toContain("Issue A");
    expect(content).toContain("sev 8");
  });
});
