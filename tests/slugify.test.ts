import { test, expect, describe } from "bun:test";
import { slugify, extractPlanTitle, formatDuration, timestampCompact, interpolate } from "../src/utils/slugify.js";

describe("slugify", () => {
  test("converts to lowercase", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("replaces non-alphanumeric with hyphens", () => {
    expect(slugify("foo/bar:baz")).toBe("foo-bar-baz");
  });

  test("trims leading/trailing hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  test("collapses multiple separators", () => {
    expect(slugify("a  b  c")).toBe("a-b-c");
  });

  test("respects maxLen", () => {
    const result = slugify("a".repeat(100), 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("extractPlanTitle", () => {
  test("extracts first heading", () => {
    const md = "# My Plan Title\n\nSome content";
    expect(extractPlanTitle(md)).toBe("My Plan Title");
  });

  test("returns null when no heading", () => {
    expect(extractPlanTitle("No headings here")).toBeNull();
  });

  test("extracts heading from middle of doc", () => {
    const md = "Some intro\n\n# The Real Title\n\nContent";
    expect(extractPlanTitle(md)).toBe("The Real Title");
  });
});

describe("formatDuration", () => {
  test("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  test("formats seconds", () => {
    expect(formatDuration(2500)).toBe("2.5s");
  });

  test("formats minutes", () => {
    expect(formatDuration(90000)).toBe("1m30s");
  });
});

describe("timestampCompact", () => {
  test("returns 15 char string YYYYMMDD-HHmmss", () => {
    const ts = timestampCompact();
    expect(ts).toMatch(/^\d{8}-\d{6}$/);
    expect(ts.length).toBe(15);
  });
});

describe("interpolate", () => {
  test("replaces known variables", () => {
    const result = interpolate("pi -p @{promptFile}", { promptFile: "/path/to/prompt.md" });
    expect(result).toBe("pi -p @/path/to/prompt.md");
  });

  test("leaves unknown variables intact", () => {
    const result = interpolate("cmd {unknown}", {});
    expect(result).toBe("cmd {unknown}");
  });

  test("replaces multiple occurrences", () => {
    const result = interpolate("{a} and {a}", { a: "foo" });
    expect(result).toBe("foo and foo");
  });

  test("handles all plan template vars", () => {
    const vars = {
      cwd: "/repo",
      planFile: "/home/user/.local/state/adversary/repo-abcd1234/runs/ts-plan/plan.txt",
      promptFile: "/home/user/.local/state/adversary/repo-abcd1234/runs/ts-plan/turn-1/implement-input.md",
      findingsFile: "/home/user/.local/state/adversary/repo-abcd1234/runs/ts-plan/turn-1/current-findings.md",
      historyFile: "/home/user/.local/state/adversary/repo-abcd1234/runs/ts-plan/turn-1/run-history.md",
      verifyOutputFile: "/home/user/.local/state/adversary/repo-abcd1234/runs/ts-plan/turn-1/verify.json",
      threshold: "7",
      turn: "1",
      maxTurns: "5",
      branch: "adversary/20260410-123456-my-plan",
    };
    const cmd = 'pi -p "/skill:verify --format=json --output={verifyOutputFile}"';
    const result = interpolate(cmd, vars);
    expect(result).toContain(vars.verifyOutputFile);
  });
});
