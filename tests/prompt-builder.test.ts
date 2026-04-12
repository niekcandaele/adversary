/**
 * Tests for prompt builder utilities (src/verify/prompt-builder.ts)
 */
import { test, expect, describe } from "bun:test";
import {
  buildScopeContext,
  buildScopeMetadata,
  buildDiscoveryContext,
  buildPhase1FindingsSummary,
  buildSkillFindingsJson,
} from "../src/verify/prompt-builder.js";
import type { VerifyScope, ToolchainDiscovery, SkillResult } from "../src/types/index.js";

const emptyScope: VerifyScope = {
  baseBranch: "main",
  mergeBase: "deadbeef",
  files: [],
  diffCommand: "git diff --name-status deadbeef...HEAD",
  diffStat: "",
};

const sampleScope: VerifyScope = {
  baseBranch: "main",
  mergeBase: "abc123",
  files: [
    { path: "src/foo.ts", status: "added" },
    { path: "src/bar.ts", status: "modified" },
    { path: "old.ts", status: "deleted" },
  ],
  diffCommand: "git diff --name-status abc123...HEAD",
  diffStat: "3 files changed, 100 insertions(+), 50 deletions(-)",
};

const sampleDiscovery: ToolchainDiscovery = {
  testCommand: "bun test",
  buildCommand: "bun build",
  lintCommands: ["bunx eslint src/"],
  typeCheckCommands: ["bunx tsc --noEmit"],
  startCommand: "bun run dev",
  browserDeps: ["playwright"],
};

describe("buildScopeContext", () => {
  test("returns message for empty scope", () => {
    expect(buildScopeContext(emptyScope)).toBe("No files changed in scope.");
  });

  test("includes file count", () => {
    const ctx = buildScopeContext(sampleScope);
    expect(ctx).toContain("3 total");
  });

  test("includes file paths with statuses in uppercase", () => {
    const ctx = buildScopeContext(sampleScope);
    expect(ctx).toContain("[ADDED] src/foo.ts");
    expect(ctx).toContain("[MODIFIED] src/bar.ts");
    expect(ctx).toContain("[DELETED] old.ts");
  });
});

describe("buildScopeMetadata", () => {
  test("includes base branch", () => {
    const meta = buildScopeMetadata(sampleScope);
    expect(meta).toContain("main");
  });

  test("includes merge base", () => {
    const meta = buildScopeMetadata(sampleScope);
    expect(meta).toContain("abc123");
  });

  test("includes diff command", () => {
    const meta = buildScopeMetadata(sampleScope);
    expect(meta).toContain("git diff --name-status");
  });
});

describe("buildDiscoveryContext", () => {
  test("returns valid JSON string", () => {
    const json = buildDiscoveryContext(sampleDiscovery);
    const parsed = JSON.parse(json);
    expect(parsed.testCommand).toBe("bun test");
    expect(parsed.buildCommand).toBe("bun build");
    expect(parsed.lintCommands).toEqual(["bunx eslint src/"]);
    expect(parsed.browserDeps).toEqual(["playwright"]);
  });

  test("handles null values", () => {
    const emptyDiscovery: ToolchainDiscovery = {
      testCommand: null,
      buildCommand: null,
      lintCommands: [],
      typeCheckCommands: [],
      startCommand: null,
      browserDeps: [],
    };
    const json = buildDiscoveryContext(emptyDiscovery);
    const parsed = JSON.parse(json);
    expect(parsed.testCommand).toBeNull();
  });
});

describe("buildPhase1FindingsSummary", () => {
  test("returns message when no findings", () => {
    const results: SkillResult[] = [
      { skill: "reviewer", exitCode: 0, durationMs: 100, findings: [], status: "completed" },
    ];
    const summary = buildPhase1FindingsSummary(results);
    expect(summary).toContain("No findings");
  });

  test("includes finding count and details", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Big Bug", severity: 8, description: "Something is wrong", sources: ["reviewer"], location: { path: "src/foo.ts", line: 10 } },
        ],
      },
      {
        skill: "qa",
        exitCode: 0,
        durationMs: 200,
        status: "completed",
        findings: [
          { title: "Missing Test", severity: 6, description: "No tests found", sources: ["qa"] },
        ],
      },
    ];
    const summary = buildPhase1FindingsSummary(results);
    expect(summary).toContain("2 issue");
    expect(summary).toContain("Big Bug");
    expect(summary).toContain("Missing Test");
    expect(summary).toContain("Severity 8");
    expect(summary).toContain("Severity 6");
  });

  test("truncates long descriptions", () => {
    const longDesc = "a".repeat(200);
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Issue", severity: 5, description: longDesc, sources: ["reviewer"] },
        ],
      },
    ];
    const summary = buildPhase1FindingsSummary(results);
    expect(summary).toContain("...");
  });

  // VI-24: finding with location.path but no location.line
  test("handles finding with location path but no line number", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          {
            title: "File-level Issue",
            severity: 5,
            description: "Something wrong in this file",
            sources: ["reviewer"],
            location: { path: "src/bar.ts" },
          },
        ],
      },
    ];
    const summary = buildPhase1FindingsSummary(results);
    expect(summary).toContain("File-level Issue");
    expect(summary).toContain("src/bar.ts");
    // Should not throw and should not include ":undefined" or ":NaN"
    expect(summary).not.toContain("undefined");
    expect(summary).not.toContain("NaN");
  });
});

describe("buildSkillFindingsJson", () => {
  test("serializes all results to JSON", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Issue", severity: 5, description: "Desc", sources: ["reviewer"] },
        ],
      },
    ];
    const json = buildSkillFindingsJson(results);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].skill).toBe("reviewer");
    expect(parsed[0].findings).toHaveLength(1);
    expect(parsed[0].findings[0].title).toBe("Issue");
  });

  test("includes status and durationMs", () => {
    const results: SkillResult[] = [
      { skill: "tester", exitCode: 0, durationMs: 5000, findings: [], status: "completed" },
    ];
    const json = buildSkillFindingsJson(results);
    const parsed = JSON.parse(json);
    expect(parsed[0].status).toBe("completed");
    expect(parsed[0].durationMs).toBe(5000);
  });
});
