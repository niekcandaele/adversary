import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateFirstTurnPrompt,
  generateLaterTurnPrompt,
  generateFindingsFile,
  generateHistoryFile,
  renderTouchedFilesBlock,
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
      repoGuidance: "## Project Skills\n\nFollow repo conventions.",
      outputPath,
    });

    expect(content).toContain("Turn 1 of 5");
    expect(content).toContain("# My Plan");
    expect(content).toContain("Severity Threshold");
    expect(content).toContain("7");
    expect(content).toContain("adversary/20260410-feature");
    expect(content).toContain("Repo Guidance");
    expect(content).toContain("Follow repo conventions.");
    // Must tell agent not to manage git
    expect(content).toContain("Do NOT manage git");
    // Must tell agent not to run verify
    expect(content).toContain("Do NOT run the verify");

    // Verify it was written to file
    const written = await Bun.file(outputPath).text();
    expect(written).toBe(content);
  });

  test("includes Clause 2 (no new test entrypoints) in first-turn prompt", async () => {
    const outputPath = join(tmpDir, "first-turn-clause2.md");
    const content = await generateFirstTurnPrompt({
      planContent: "# Plan",
      threshold: 5,
      turn: 1,
      maxTurns: 3,
      branch: "adversary/test",
      outputPath,
    });

    expect(content).toContain("Do not add new test entrypoints");
    expect(content).toContain("Extend the existing test harness");
  });

  test("does NOT include Clause 1 (pre-existing failure warning) in first-turn prompt", async () => {
    const outputPath = join(tmpDir, "first-turn-no-clause1.md");
    const content = await generateFirstTurnPrompt({
      planContent: "# Plan",
      threshold: 5,
      turn: 1,
      maxTurns: 3,
      branch: "adversary/test",
      outputPath,
    });

    // Clause 1 is only for later turns
    expect(content).not.toContain("Failures that look unrelated to your current findings are suspect");
  });

  test("does NOT include touched-files block in first-turn prompt", async () => {
    const outputPath = join(tmpDir, "first-turn-no-touched.md");
    const content = await generateFirstTurnPrompt({
      planContent: "# Plan",
      threshold: 5,
      turn: 1,
      maxTurns: 3,
      branch: "adversary/test",
      outputPath,
    });

    expect(content).not.toContain("Earlier Turns of This Run Touched");
  });
});

describe("generateLaterTurnPrompt", () => {
  test("includes only current findings plus repo guidance", async () => {
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
      repoGuidance: "## Repo Docs\n\nStay aligned with existing patterns.",
      outputPath,
    });

    expect(content).toContain("Turn 2 of 5");
    expect(content).toContain("Missing tests");
    expect(content).toContain("severity 8");
    expect(content).toContain("src/main.ts");
    expect(content).toContain("Repo Guidance");
    expect(content).toContain("Stay aligned with existing patterns.");
    expect(content).toContain("# Original Plan");
    expect(content).toContain("Do NOT manage git");
    expect(content).toContain("Do NOT run the verify");
    expect(content).not.toContain("Run History");
  });

  test("includes Clause 1 (pre-existing failure warning) in later-turn prompt", async () => {
    const outputPath = join(tmpDir, "later-turn-clause1.md");
    const content = await generateLaterTurnPrompt({
      planContent: "# Plan",
      threshold: 5,
      turn: 2,
      maxTurns: 5,
      branch: "adversary/test",
      thresholdFindings: [],
      outputPath,
    });

    expect(content).toContain("Failures that look unrelated to your current findings are suspect");
    expect(content).toContain("Do not dismiss a failure as");
    expect(content).toContain("treat the failure as yours");
  });

  test("includes Clause 2 (no new test entrypoints) in later-turn prompt", async () => {
    const outputPath = join(tmpDir, "later-turn-clause2.md");
    const content = await generateLaterTurnPrompt({
      planContent: "# Plan",
      threshold: 5,
      turn: 2,
      maxTurns: 5,
      branch: "adversary/test",
      thresholdFindings: [],
      outputPath,
    });

    expect(content).toContain("Do not add new test entrypoints");
    expect(content).toContain("Extend the existing test harness");
  });

  test("includes touched-files block when touchedFilesByTurn is provided", async () => {
    const outputPath = join(tmpDir, "later-turn-touched.md");
    const touchedFilesByTurn = new Map<string, number[]>([
      ["packages/app-api/src/lib/clickhouseReader.ts", [1, 5]],
      ["containers/prometheus/prometheus.yml", [14, 19]],
    ]);

    const content = await generateLaterTurnPrompt({
      planContent: "# Plan",
      threshold: 5,
      turn: 3,
      maxTurns: 10,
      branch: "adversary/test",
      thresholdFindings: [],
      outputPath,
      touchedFilesByTurn,
    });

    expect(content).toContain("Earlier Turns of This Run Touched");
    expect(content).toContain("packages/app-api/src/lib/clickhouseReader.ts — turns 1, 5");
    expect(content).toContain("containers/prometheus/prometheus.yml — turns 14, 19");
    expect(content).toContain("do not assume it is pre-existing", "touched-files block should say 'do not assume it is pre-existing'");
  });

  test("does NOT include touched-files block when map is empty", async () => {
    const outputPath = join(tmpDir, "later-turn-no-touched.md");
    const content = await generateLaterTurnPrompt({
      planContent: "# Plan",
      threshold: 5,
      turn: 2,
      maxTurns: 5,
      branch: "adversary/test",
      thresholdFindings: [],
      outputPath,
      touchedFilesByTurn: new Map(),
    });

    expect(content).not.toContain("Earlier Turns of This Run Touched");
  });

  test("does NOT include touched-files block when touchedFilesByTurn is omitted", async () => {
    const outputPath = join(tmpDir, "later-turn-no-touched-omit.md");
    const content = await generateLaterTurnPrompt({
      planContent: "# Plan",
      threshold: 5,
      turn: 2,
      maxTurns: 5,
      branch: "adversary/test",
      thresholdFindings: [],
      outputPath,
    });

    expect(content).not.toContain("Earlier Turns of This Run Touched");
  });

  test("touched-files block appears before Current Findings section", async () => {
    const outputPath = join(tmpDir, "later-turn-order.md");
    const touchedFilesByTurn = new Map<string, number[]>([
      ["src/foo.ts", [1]],
    ]);

    const content = await generateLaterTurnPrompt({
      planContent: "# Plan",
      threshold: 5,
      turn: 2,
      maxTurns: 5,
      branch: "adversary/test",
      thresholdFindings: [],
      outputPath,
      touchedFilesByTurn,
    });

    const touchedIdx = content.indexOf("Earlier Turns of This Run Touched");
    const findingsIdx = content.indexOf("Current Findings to Fix");
    expect(touchedIdx).toBeGreaterThan(-1);
    expect(findingsIdx).toBeGreaterThan(-1);
    expect(touchedIdx).toBeLessThan(findingsIdx);
  });
});

describe("renderTouchedFilesBlock", () => {
  test("returns empty string for empty map", () => {
    const result = renderTouchedFilesBlock(new Map());
    expect(result).toBe("");
  });

  test("renders single file correctly", () => {
    const result = renderTouchedFilesBlock(new Map([
      ["src/foo.ts", [3]],
    ]));
    expect(result).toContain("Earlier Turns of This Run Touched");
    expect(result).toContain("src/foo.ts — turns 3");
  });

  test("renders multiple files sorted alphabetically", () => {
    const result = renderTouchedFilesBlock(new Map([
      ["z-last.ts", [2]],
      ["a-first.ts", [1]],
      ["m-middle.ts", [3]],
    ]));
    const aIdx = result.indexOf("a-first.ts");
    const mIdx = result.indexOf("m-middle.ts");
    const zIdx = result.indexOf("z-last.ts");
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });

  test("renders multiple turns for a single file", () => {
    const result = renderTouchedFilesBlock(new Map([
      ["src/bar.ts", [1, 3, 7]],
    ]));
    expect(result).toContain("src/bar.ts — turns 1, 3, 7");
  });

  test("includes git inspection hint", () => {
    const result = renderTouchedFilesBlock(new Map([
      ["src/baz.ts", [2]],
    ]));
    expect(result).toContain("git log");
    expect(result).toContain("git show");
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
