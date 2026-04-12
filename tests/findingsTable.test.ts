import { test, expect, describe } from "bun:test";
import { formatFindingsTable } from "../src/ui/findingsTable.js";
import type { VerifyFinding } from "../src/types/index.js";

describe("formatFindingsTable", () => {
  test("returns empty string for empty findings", () => {
    expect(formatFindingsTable([])).toBe("");
  });

  test("renders a single finding with description", () => {
    const findings: VerifyFinding[] = [
      {
        title: "Missing test coverage",
        severity: 3,
        description: "The new endpoint has no integration test.",
        sources: ["reviewer"],
      },
    ];
    const table = formatFindingsTable(findings);
    expect(table).toContain("Missing test coverage");
    expect(table).toContain("3");
    expect(table).toContain("reviewer");
    expect(table).toContain("The new endpoint has no integration test.");
    expect(table).toContain("┌");
    expect(table).toContain("└");
  });

  test("renders multiple findings with row separators", () => {
    const findings: VerifyFinding[] = [
      {
        title: "Bug A",
        severity: 5,
        description: "First issue.",
        sources: ["qa"],
      },
      {
        title: "Bug B",
        severity: 2,
        description: "Second issue.",
        sources: ["reviewer", "qa"],
      },
    ];
    const table = formatFindingsTable(findings);
    expect(table).toContain("Bug A");
    expect(table).toContain("Bug B");
    expect(table).toContain("reviewer, qa");
    // Should have a mid-row separator between findings
    const midSeps = table.match(/├/g);
    expect(midSeps!.length).toBeGreaterThanOrEqual(2); // header sep + row sep
  });

  test("truncates long titles", () => {
    const findings: VerifyFinding[] = [
      {
        title: "A".repeat(200),
        severity: 1,
        description: "Long title finding.",
        sources: ["static-analysis"],
      },
    ];
    const table = formatFindingsTable(findings);
    expect(table).toContain("…");
  });

  test("wraps long descriptions", () => {
    const findings: VerifyFinding[] = [
      {
        title: "Issue",
        severity: 4,
        description:
          "This is a very long description that should be word-wrapped across multiple lines because it exceeds the terminal width when rendered in the table format.",
        sources: ["reviewer"],
      },
    ];
    const table = formatFindingsTable(findings);
    const lines = table.split("\n");
    // Description should span multiple lines (more than just header + 1 data row + borders)
    expect(lines.length).toBeGreaterThan(6);
  });
});
