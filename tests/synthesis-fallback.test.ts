/**
 * Tests for deterministic synthesis fallback (src/verify/synthesis-fallback.ts)
 */
import { test, expect, describe } from "bun:test";
import { synthesizeFallback } from "../src/verify/synthesis-fallback.js";
import type { SkillResult } from "../src/types/index.js";

describe("synthesizeFallback", () => {
  test("returns empty findings when no skills ran", () => {
    const report = synthesizeFallback([]);
    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("ok");
    expect(report.findings).toHaveLength(0);
  });

  test("returns ok status when all skills completed", () => {
    const results: SkillResult[] = [
      { skill: "reviewer", exitCode: 0, durationMs: 100, findings: [], status: "completed" },
      { skill: "qa", exitCode: 0, durationMs: 200, findings: [], status: "completed" },
    ];
    const report = synthesizeFallback(results);
    expect(report.status).toBe("ok");
  });

  test("returns error status when any skill has error", () => {
    const results: SkillResult[] = [
      { skill: "reviewer", exitCode: 0, durationMs: 100, findings: [], status: "completed" },
      { skill: "qa", exitCode: 1, durationMs: 0, findings: [], status: "error" },
    ];
    const report = synthesizeFallback(results);
    expect(report.status).toBe("error");
  });

  test("concatenates all findings from all skills", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Issue A", severity: 5, description: "Desc A", sources: ["reviewer"], location: { path: "a.ts", line: 10 } },
        ],
      },
      {
        skill: "qa",
        exitCode: 0,
        durationMs: 200,
        status: "completed",
        findings: [
          { title: "Issue B", severity: 8, description: "Desc B", sources: ["qa"], location: { path: "b.ts", line: 20 } },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    expect(report.findings).toHaveLength(2);
    const titles = report.findings.map((f) => f.title);
    expect(titles).toContain("Issue A");
    expect(titles).toContain("Issue B");
  });

  test("deduplicates findings at same location with same title, keeping highest severity", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Null pointer dereference", severity: 5, description: "Desc reviewer", sources: ["reviewer"], location: { path: "shared.ts", line: 42 } },
        ],
      },
      {
        skill: "qa",
        exitCode: 0,
        durationMs: 200,
        status: "completed",
        findings: [
          { title: "Null pointer dereference", severity: 8, description: "Desc qa", sources: ["qa"], location: { path: "shared.ts", line: 42 } },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    // Should deduplicate — same path:line AND same title
    expect(report.findings).toHaveLength(1);
    // Should take highest severity
    expect(report.findings[0]?.severity).toBe(8);
    // Should merge sources
    expect(report.findings[0]?.sources).toContain("reviewer");
    expect(report.findings[0]?.sources).toContain("qa");
  });

  test("does NOT deduplicate findings at same location but different titles (VI-4)", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Same Issue (rev)", severity: 5, description: "Desc reviewer", sources: ["reviewer"], location: { path: "shared.ts", line: 42 } },
        ],
      },
      {
        skill: "qa",
        exitCode: 0,
        durationMs: 200,
        status: "completed",
        findings: [
          { title: "Same Issue (qa)", severity: 8, description: "Desc qa", sources: ["qa"], location: { path: "shared.ts", line: 42 } },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    // Different titles at same location — must NOT be merged
    expect(report.findings).toHaveLength(2);
  });

  test("does not deduplicate findings at different locations", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Issue at A", severity: 5, description: "At A", sources: ["reviewer"], location: { path: "a.ts", line: 1 } },
          { title: "Issue at B", severity: 5, description: "At B", sources: ["reviewer"], location: { path: "b.ts", line: 1 } },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    expect(report.findings).toHaveLength(2);
  });

  test("sorts findings by severity descending", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Low", severity: 2, description: "Low", sources: ["reviewer"], location: { path: "a.ts", line: 1 } },
          { title: "High", severity: 9, description: "High", sources: ["reviewer"], location: { path: "b.ts", line: 1 } },
          { title: "Medium", severity: 5, description: "Med", sources: ["reviewer"], location: { path: "c.ts", line: 1 } },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    expect(report.findings[0]?.severity).toBe(9);
    expect(report.findings[1]?.severity).toBe(5);
    expect(report.findings[2]?.severity).toBe(2);
  });

  test("handles timeout status as error-like", () => {
    const results: SkillResult[] = [
      { skill: "reviewer", exitCode: 124, durationMs: 90000, findings: [], status: "timeout" },
    ];
    const report = synthesizeFallback(results);
    expect(report.status).toBe("error");
  });

  // VI-15: location-less finding dedup
  test("deduplicates location-less findings with same title", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Same Title", severity: 5, description: "From reviewer", sources: ["reviewer"] },
        ],
      },
      {
        skill: "qa",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Same Title", severity: 7, description: "From qa", sources: ["qa"] },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    // Should dedup — same title, no location → same key "noLoc:Same Title"
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.severity).toBe(7); // highest
    expect(report.findings[0]?.sources).toContain("reviewer");
    expect(report.findings[0]?.sources).toContain("qa");
  });

  test("does not deduplicate location-less findings with different titles", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Title A", severity: 5, description: "A", sources: ["reviewer"] },
          { title: "Title B", severity: 3, description: "B", sources: ["reviewer"] },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    // Different titles → different keys → not deduped
    expect(report.findings).toHaveLength(2);
    const titles = report.findings.map((f) => f.title);
    expect(titles).toContain("Title A");
    expect(titles).toContain("Title B");
  });

  // VI-19: dedup key for finding with location.path but no location.line
  // VI-4: distinct findings at the same location should NOT be merged
  test("preserves distinct findings at the same file:line (different titles)", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Missing null check", severity: 5, description: "No null guard", sources: ["reviewer"], location: { path: "src/foo.ts", line: 10 } },
          { title: "Incorrect error handling", severity: 7, description: "Wrong error type", sources: ["reviewer"], location: { path: "src/foo.ts", line: 10 } },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    // Both have same path:line but different titles — must NOT be merged
    expect(report.findings).toHaveLength(2);
    const titles = report.findings.map((f) => f.title);
    expect(titles).toContain("Missing null check");
    expect(titles).toContain("Incorrect error handling");
  });

  test("still merges truly duplicate findings at same file:line (same title)", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Same Bug", severity: 5, description: "From reviewer", sources: ["reviewer"], location: { path: "src/foo.ts", line: 10 } },
        ],
      },
      {
        skill: "qa",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Same Bug", severity: 8, description: "From qa", sources: ["qa"], location: { path: "src/foo.ts", line: 10 } },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    // Same title, same location — should be merged into one with highest severity
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.severity).toBe(8);
    expect(report.findings[0]?.sources).toContain("reviewer");
    expect(report.findings[0]?.sources).toContain("qa");
  });

  test("deduplicates findings with same path, no line number, and same title", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Missing exports", severity: 4, description: "From reviewer", sources: ["reviewer"], location: { path: "src/foo.ts" } },
        ],
      },
      {
        skill: "qa",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Missing exports", severity: 6, description: "From qa", sources: ["qa"], location: { path: "src/foo.ts" } },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    // Same title + path "src/foo.ts" + no line → same key → deduped
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.severity).toBe(6);
    expect(report.findings[0]?.sources).toContain("reviewer");
    expect(report.findings[0]?.sources).toContain("qa");
  });

  test("does NOT deduplicate findings with same path, no line, but different titles", () => {
    const results: SkillResult[] = [
      {
        skill: "reviewer",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Issue At File (reviewer)", severity: 4, description: "From reviewer", sources: ["reviewer"], location: { path: "src/foo.ts" } },
        ],
      },
      {
        skill: "qa",
        exitCode: 0,
        durationMs: 100,
        status: "completed",
        findings: [
          { title: "Issue At File (qa)", severity: 6, description: "From qa", sources: ["qa"], location: { path: "src/foo.ts" } },
        ],
      },
    ];
    const report = synthesizeFallback(results);
    // Different titles → different keys despite same path:noLine
    expect(report.findings).toHaveLength(2);
  });
});
