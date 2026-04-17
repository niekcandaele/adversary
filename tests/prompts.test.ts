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
import type { TurnTouchEntry } from "../src/git/index.js";

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
    const touchedFilesByTurn = new Map<string, TurnTouchEntry[]>([
      ["packages/app-api/src/lib/clickhouseReader.ts", [{ turn: 1, sha: "abc1234" }, { turn: 5, sha: "def5678" }]],
      ["containers/prometheus/prometheus.yml", [{ turn: 14, sha: "aaa0001" }, { turn: 19, sha: "bbb0002" }]],
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
    expect(content).toContain("packages/app-api/src/lib/clickhouseReader.ts — turns 1 (abc1234), 5 (def5678)");
    expect(content).toContain("containers/prometheus/prometheus.yml — turns 14 (aaa0001), 19 (bbb0002)");
    expect(content).toContain("do not assume it is pre-existing");
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
    const touchedFilesByTurn = new Map<string, TurnTouchEntry[]>([
      ["src/foo.ts", [{ turn: 1, sha: "abc1234" }]],
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
  test("returns empty string for empty map with no commit failures", () => {
    const result = renderTouchedFilesBlock(new Map());
    expect(result).toBe("");
  });

  test("renders single file correctly with SHA", () => {
    const result = renderTouchedFilesBlock(new Map<string, TurnTouchEntry[]>([
      ["src/foo.ts", [{ turn: 3, sha: "abc1234" }]],
    ]));
    expect(result).toContain("Earlier Turns of This Run Touched");
    expect(result).toContain("src/foo.ts — turns 3 (abc1234)");
  });

  test("renders multiple files sorted alphabetically", () => {
    const result = renderTouchedFilesBlock(new Map<string, TurnTouchEntry[]>([
      ["z-last.ts", [{ turn: 2, sha: "aaa" }]],
      ["a-first.ts", [{ turn: 1, sha: "bbb" }]],
      ["m-middle.ts", [{ turn: 3, sha: "ccc" }]],
    ]));
    const aIdx = result.indexOf("a-first.ts");
    const mIdx = result.indexOf("m-middle.ts");
    const zIdx = result.indexOf("z-last.ts");
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });

  test("renders multiple turns for a single file with SHAs", () => {
    const result = renderTouchedFilesBlock(new Map<string, TurnTouchEntry[]>([
      ["src/bar.ts", [{ turn: 1, sha: "aaa0001" }, { turn: 3, sha: "bbb0002" }, { turn: 7, sha: "ccc0003" }]],
    ]));
    expect(result).toContain("src/bar.ts — turns 1 (aaa0001), 3 (bbb0002), 7 (ccc0003)");
  });

  test("render preserves input order — sorting happens upstream in computeTouchedFilesByTurn", () => {
    // The renderer does NOT sort turns within a file's entry list — it preserves
    // whatever order was passed in. Sorting is the responsibility of computeTouchedFilesByTurn.
    const result = renderTouchedFilesBlock(new Map<string, TurnTouchEntry[]>([
      ["src/sorted.ts", [{ turn: 7, sha: "ccc" }, { turn: 1, sha: "aaa" }, { turn: 3, sha: "bbb" }]],
    ]));
    expect(result).toContain("src/sorted.ts — turns 7 (ccc), 1 (aaa), 3 (bbb)");
    // Entries appear in the exact input order, confirming no re-sorting in the renderer.
  });

  test("includes git inspection hint using git show and git log --follow", () => {
    const result = renderTouchedFilesBlock(new Map<string, TurnTouchEntry[]>([
      ["src/baz.ts", [{ turn: 2, sha: "abc" }]],
    ]));
    expect(result).toContain("git show");
    expect(result).toContain("git log --follow");
  });

  test("renders commit-failure note when commitFailureTurns provided", () => {
    const result = renderTouchedFilesBlock(new Map(), [2, 4]);
    expect(result).toContain("Turn(s) 2, 4 have uncommitted edits");
    expect(result).toContain("git status");
  });

  test("renders both files and commit-failure note together", () => {
    const result = renderTouchedFilesBlock(
      new Map<string, TurnTouchEntry[]>([["src/foo.ts", [{ turn: 1, sha: "abc" }]]]),
      [3]
    );
    expect(result).toContain("Earlier Turns of This Run Touched");
    expect(result).toContain("src/foo.ts");
    expect(result).toContain("Turn(s) 3 have uncommitted edits");
  });

  test("failure note appears AFTER the file list in the combined case", () => {
    const result = renderTouchedFilesBlock(
      new Map<string, TurnTouchEntry[]>([["src/foo.ts", [{ turn: 1, sha: "abc" }]]]),
      [3]
    );
    const fileListIdx = result.indexOf("src/foo.ts");
    const failureNoteIdx = result.indexOf("uncommitted edits");
    expect(fileListIdx).toBeGreaterThan(-1);
    expect(failureNoteIdx).toBeGreaterThan(-1);
    // The failure note must come after the file list entry.
    expect(failureNoteIdx).toBeGreaterThan(fileListIdx);
  });

  test("renders summarizer-failure note with correct prose", () => {
    // summarizer-failure turns are treated the same as commit-failure turns
    // — they leave uncommitted edits in the working tree.
    const result = renderTouchedFilesBlock(new Map(), [5]);
    expect(result).toContain("Turn(s) 5 have uncommitted edits");
    expect(result).toContain("git status");
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
