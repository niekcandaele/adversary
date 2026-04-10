import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFinalSummary, generatePrBody } from "../src/summary/index.js";
import type { RunState } from "../src/types/index.js";

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

describe("generatePrBody", () => {
  test("creates pr-body.md", async () => {
    const tmpDir = await makeTmpDir();
    try {
      const state = makeState(tmpDir);
      await generatePrBody(state, 7);
      const file = Bun.file(join(tmpDir, "pr-body.md"));
      expect(await file.exists()).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("body contains plan title and outcome", async () => {
    const tmpDir = await makeTmpDir();
    try {
      const state = makeState(tmpDir, { outcome: "clean" });
      const body = await generatePrBody(state, 7);
      expect(body).toContain("Build a Bun CLI");
      expect(body).toContain("Clean");
      expect(body).toContain("automatically by the adversary orchestrator");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
