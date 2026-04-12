import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { generateFinalSummary, assemblePrBody } from "../src/summary/index.js";
import type { RunState, PrSummaryOutput } from "../src/types/index.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "adversary-summary-test-"));
}

function makeState(tmpDir: string, overrides: Partial<RunState> = {}): RunState {
  return {
    runDir: tmpDir,
    planFile: "/repo/PLAN.md",
    planTitle: "Build a Bun CLI",
    branch: "adversary/20260410-build-a-bun-cli",
    baseBranch: "main",
    startedAt: "2026-04-10T12:00:00Z",
    turns: [],
    outcome: "clean",
    ...overrides,
  };
}

describe("generateFinalSummary", () => {
  test("creates final-summary.md and final-summary.json", async () => {
    const tmpDir = await makeTmpDir();
    try {
      const state = makeState(tmpDir);
      await generateFinalSummary(state, 7);

      const mdFile = Bun.file(join(tmpDir, "final-summary.md"));
      const jsonFile = Bun.file(join(tmpDir, "final-summary.json"));

      expect(await mdFile.exists()).toBe(true);
      expect(await jsonFile.exists()).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("summary contains plan title and outcome", async () => {
    const tmpDir = await makeTmpDir();
    try {
      const state = makeState(tmpDir, { outcome: "capped" });
      await generateFinalSummary(state, 7);

      const md = await Bun.file(join(tmpDir, "final-summary.md")).text();
      expect(md).toContain("Build a Bun CLI");
      expect(md).toContain("Capped");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("JSON has required fields", async () => {
    const tmpDir = await makeTmpDir();
    try {
      const state = makeState(tmpDir, { outcome: "clean" });
      await generateFinalSummary(state, 7);

      const json = await Bun.file(join(tmpDir, "final-summary.json")).json();
      expect(json.schemaVersion).toBe(1);
      expect(json.planTitle).toBe("Build a Bun CLI");
      expect(json.outcome).toBe("clean");
      expect(json.threshold).toBe(7);
      expect(Array.isArray(json.thresholdFindings)).toBe(true);
      expect(Array.isArray(json.belowThresholdFindings)).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("includes findings from last turn", async () => {
    const tmpDir = await makeTmpDir();
    try {
      const state = makeState(tmpDir, {
        turns: [
          {
            turn: 1,
            implementCommand: "pi -p @prompt.md",
            verifyCommand: "pi -p verify",
            implementDurationMs: 1000,
            verifyDurationMs: 2000,
            repoChanged: true,
            commitSha: "abc123",
            verifyStatus: "ok",
            thresholdFindings: [
              { title: "Critical Bug", severity: 9, description: "Crashes on startup", sources: ["reviewer"] },
            ],
            belowThresholdFindings: [
              { title: "Minor Style", severity: 2, description: "Formatting", sources: [] },
            ],
            outcome: "capped",
          },
        ],
        outcome: "capped",
      });
      await generateFinalSummary(state, 7);

      const json = await Bun.file(join(tmpDir, "final-summary.json")).json();
      expect(json.thresholdFindings).toHaveLength(1);
      expect(json.thresholdFindings[0].title).toBe("Critical Bug");
      expect(json.belowThresholdFindings).toHaveLength(1);
      expect(json.belowThresholdFindings[0].title).toBe("Minor Style");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("assemblePrBody", () => {
  function makeLlmOutput(overrides: Partial<PrSummaryOutput> = {}): PrSummaryOutput {
    return {
      title: "Add smart commit messages and rich PR descriptions",
      summary: "- Implement summarizer module\n- Wire into loop and PR flow",
      reviewerGuide: "Start with src/summarizer/index.ts, then loop/index.ts",
      testPlan: "Run `bun test` — new tests in tests/summarizer.test.ts",
      issueNumber: null,
      ...overrides,
    };
  }

  test("includes LLM summary section", () => {
    const tmpDir = "/tmp/test-run";
    const state = makeState(tmpDir, { outcome: "clean" });
    const body = assemblePrBody(state, 7, makeLlmOutput());
    expect(body).toContain("Implement summarizer module");
    expect(body).toContain("## Summary");
  });

  test("includes reviewer guide section", () => {
    const tmpDir = "/tmp/test-run";
    const state = makeState(tmpDir, { outcome: "clean" });
    const body = assemblePrBody(state, 7, makeLlmOutput());
    expect(body).toContain("## Reviewer Guide");
    expect(body).toContain("src/summarizer/index.ts");
  });

  test("includes test plan section", () => {
    const tmpDir = "/tmp/test-run";
    const state = makeState(tmpDir, { outcome: "clean" });
    const body = assemblePrBody(state, 7, makeLlmOutput());
    expect(body).toContain("## Test Plan");
    expect(body).toContain("bun test");
  });

  test("includes Closes #N when issueNumber is set", () => {
    const tmpDir = "/tmp/test-run";
    const state = makeState(tmpDir, { outcome: "clean" });
    const body = assemblePrBody(state, 7, makeLlmOutput({ issueNumber: 99 }));
    expect(body).toContain("Closes #99");
  });

  test("does not include Closes # when issueNumber is null", () => {
    const tmpDir = "/tmp/test-run";
    const state = makeState(tmpDir, { outcome: "clean" });
    const body = assemblePrBody(state, 7, makeLlmOutput({ issueNumber: null }));
    expect(body).not.toContain("Closes #");
  });

  test("includes orchestration metadata in collapsed details", () => {
    const tmpDir = "/tmp/test-run";
    const state = makeState(tmpDir, { outcome: "capped" });
    const body = assemblePrBody(state, 7, makeLlmOutput());
    expect(body).toContain("<details>");
    expect(body).toContain("Orchestration metadata");
    expect(body).toContain("adversary/20260410-build-a-bun-cli");
    expect(body).toContain("Capped");
  });

  test("adversary warning is present", () => {
    const tmpDir = "/tmp/test-run";
    const state = makeState(tmpDir, { outcome: "clean" });
    const body = assemblePrBody(state, 7, makeLlmOutput());
    expect(body).toContain("automatically by the adversary orchestrator");
  });

  test("includes threshold and below-threshold findings from turns", () => {
    const tmpDir = "/tmp/test-run";
    const state = makeState(tmpDir, {
      outcome: "capped",
      turns: [
        {
          turn: 1,
          implementCommand: "pi -p @prompt.md",
          verifyCommand: "pi -p verify",
          implementDurationMs: 1000,
          verifyDurationMs: 2000,
          repoChanged: true,
          commitSha: "abc123",
          verifyStatus: "ok",
          thresholdFindings: [
            { title: "Security Vuln", severity: 9, description: "SQL injection risk", sources: ["reviewer"] },
          ],
          belowThresholdFindings: [
            { title: "Minor Lint", severity: 2, description: "Unused import", sources: ["static-analysis"] },
          ],
          outcome: "capped",
        },
      ],
    });
    const body = assemblePrBody(state, 7, makeLlmOutput());
    // Threshold findings must appear in the metadata block
    expect(body).toContain("Security Vuln");
    expect(body).toContain("SQL injection risk");
    expect(body).toContain("severity 9");
    // Below-threshold findings must also appear
    expect(body).toContain("Minor Lint");
    expect(body).toContain("Unused import");
    expect(body).toContain("severity 2");
  });

  test("works without explicit cwd param (uses process.cwd() default)", () => {
    const state = makeState("/tmp/test-run", { outcome: "clean" });
    // Call assemblePrBody without the optional cwd argument
    const body = assemblePrBody(state, 7, makeLlmOutput());
    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("## Summary");
  });

  test("sanitizePath: runDir under homedir uses ~/... notation in PR body", () => {
    const runDir = join(homedir(), ".local", "state", "adversary", "myrepo-abc12345", "runs", "20260410-test");
    const state = makeState(runDir, { outcome: "clean" });
    const body = assemblePrBody(state, 7, makeLlmOutput());
    expect(body).toContain("~/");
    expect(body).not.toContain(homedir() + "/");
  });

  test("displayPlanFile: planFile under cwd shows relative path in PR body", () => {
    const cwd = "/projects/myrepo";
    const planFile = "/projects/myrepo/plans/PLAN.md";
    const state = makeState("/tmp/run", { planFile, outcome: "clean" });
    const body = assemblePrBody(state, 7, makeLlmOutput(), cwd);
    expect(body).toContain("plans/PLAN.md");
    expect(body).not.toContain("/projects/myrepo/plans/PLAN.md");
  });

  test("displayPlanFile: planFile outside cwd but under homedir shows ~/... in PR body", () => {
    const cwd = "/projects/myrepo";
    const planFile = join(homedir(), "plans", "PLAN.md");
    const state = makeState("/tmp/run", { planFile, outcome: "clean" });
    const body = assemblePrBody(state, 7, makeLlmOutput(), cwd);
    expect(body).toContain("~/plans/PLAN.md");
    expect(body).not.toContain(homedir() + "/plans/PLAN.md");
  });
});
