/**
 * Unit tests for validateRawFindings and filterFindingsByScope in src/verify/findings.ts
 */
import { test, expect, describe } from "bun:test";
import { validateRawFindings, filterFindingsByScope } from "../src/verify/findings.js";
import type { VerifyFinding, VerifyScope } from "../src/types/index.js";

function makeScope(paths: string[]): VerifyScope {
  return {
    baseBranch: "main",
    mergeBase: "abc123",
    files: paths.map((path) => ({ path, status: "modified" as const })),
    diffCommand: "git diff main..HEAD",
    diffStat: "1 file changed",
  };
}

function makeFinding(overrides: Partial<VerifyFinding> = {}): VerifyFinding {
  return {
    title: "Test finding",
    severity: 5,
    description: "A finding",
    sources: ["test"],
    ...overrides,
  };
}

describe("filterFindingsByScope", () => {
  test("keeps findings with no location.path unconditionally", () => {
    const scope = makeScope(["src/foo.ts"]);
    const findings = [
      makeFinding({ location: undefined }),
      makeFinding({ title: "No loc" }),
    ];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(2);
  });

  test("keeps findings whose path exactly matches a scope file", () => {
    const scope = makeScope(["src/foo.ts", "src/bar.ts"]);
    const findings = [
      makeFinding({ location: { path: "src/foo.ts" } }),
      makeFinding({ location: { path: "src/bar.ts" } }),
    ];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(2);
  });

  test("drops findings whose path is outside the scope", () => {
    const scope = makeScope(["src/foo.ts"]);
    const findings = [
      makeFinding({ location: { path: "src/unrelated.ts" } }),
      makeFinding({ location: { path: "other/module.ts" } }),
    ];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(0);
  });

  test("tolerates absolute-vs-relative: keeps when finding path is a suffix of scope path", () => {
    // Scope has relative path, finding has absolute path
    const scope = makeScope(["src/foo.ts"]);
    const findings = [
      makeFinding({ location: { path: "/home/user/repo/src/foo.ts" } }),
    ];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(1);
  });

  test("tolerates absolute-vs-relative: keeps when scope path is a suffix of finding path", () => {
    // Scope has absolute path, finding has relative path
    const scope = makeScope(["/home/user/repo/src/foo.ts"]);
    const findings = [
      makeFinding({ location: { path: "src/foo.ts" } }),
    ];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(1);
  });

  test("returns all findings when scope has no files", () => {
    const scope = makeScope([]);
    const findings = [
      makeFinding({ location: { path: "src/anything.ts" } }),
      makeFinding(),
    ];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(2);
  });

  // VI-10/VI-12: path-component-aware suffix matching
  test("(VI-10) short path matches via shared trailing segments", () => {
    // "cli/run.ts" should match scope path "src/cli/run.ts" via trailing segment match
    const scope = makeScope(["src/cli/run.ts"]);
    const findings = [makeFinding({ location: { path: "cli/run.ts" } })];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(1);
  });

  test("(VI-12) diverging middle segments do NOT match", () => {
    // "src/other/run.ts" should NOT match scope "src/cli/run.ts"
    // even though both end in "run.ts"
    const scope = makeScope(["src/cli/run.ts"]);
    const findings = [makeFinding({ location: { path: "src/other/run.ts" } })];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(0);
  });

  test("(VI-12) single-filename match does NOT match a different-directory same-filename", () => {
    // "run.ts" should match "src/cli/run.ts" (trailing segment match)
    // but "src/other/run.ts" should NOT match "src/cli/run.ts" (middle segment diverges)
    const scope = makeScope(["src/cli/run.ts"]);
    const findings = [
      makeFinding({ location: { path: "run.ts" } }),        // should match (trailing seg)
      makeFinding({ location: { path: "src/other/run.ts" } }), // should NOT match
    ];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(1);
    expect(result[0]?.location?.path).toBe("run.ts");
  });

  test("mixed: some in scope, some out of scope, some without location", () => {
    const scope = makeScope(["src/foo.ts"]);
    const findings = [
      makeFinding({ location: { path: "src/foo.ts" } }),         // in scope
      makeFinding({ location: { path: "src/bar.ts" } }),         // out of scope
      makeFinding({ location: undefined }),                       // no location — keep
      makeFinding({ title: "Coverage gap" }),                     // no location — keep
    ];
    const result = filterFindingsByScope(findings, scope);
    expect(result).toHaveLength(3);
    expect(result.some((f) => f.location?.path === "src/bar.ts")).toBe(false);
  });
});

describe("validateRawFindings", () => {
  test("returns empty array for empty input", () => {
    const result = validateRawFindings([], "test-skill");
    expect(result).toHaveLength(0);
  });

  test("returns valid finding with all fields", () => {
    const raw = [
      {
        title: "A Bug",
        severity: 7,
        description: "Something is wrong",
        sources: ["reviewer"],
      },
    ];
    const result = validateRawFindings(raw, "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("A Bug");
    expect(result[0]!.severity).toBe(7);
    expect(result[0]!.description).toBe("Something is wrong");
    expect(result[0]!.sources).toEqual(["reviewer"]);
  });

  test("skips non-object entries (null, string, number)", () => {
    const raw = [null, "a string", 42, { title: "Valid", severity: 5, description: "OK" }];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("Valid");
  });

  test("skips entries with wrong type for title (non-string)", () => {
    const raw = [
      { title: 123, severity: 5, description: "desc" },
      { title: null, severity: 5, description: "desc" },
      { title: "Valid", severity: 5, description: "desc" },
    ];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("Valid");
  });

  test("skips entries with wrong type for severity (non-number)", () => {
    const raw = [
      { title: "T", severity: "high", description: "desc" },
      { title: "T", severity: null, description: "desc" },
      { title: "Valid", severity: 8, description: "desc" },
    ];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.severity).toBe(8);
  });

  test("skips entries with wrong type for description (non-string)", () => {
    const raw = [
      { title: "T", severity: 5, description: [] },
      { title: "T", severity: 5, description: 42 },
      { title: "Valid", severity: 5, description: "OK" },
    ];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("OK");
  });

  test("uses sourceName as default when sources is not an array", () => {
    const raw = [{ title: "T", severity: 5, description: "desc", sources: "not-an-array" }];
    const result = validateRawFindings(raw as unknown[], "my-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.sources).toEqual(["my-skill"]);
  });

  test("uses sourceName as default when sources is missing", () => {
    const raw = [{ title: "T", severity: 5, description: "desc" }];
    const result = validateRawFindings(raw as unknown[], "fallback-source");
    expect(result).toHaveLength(1);
    expect(result[0]!.sources).toEqual(["fallback-source"]);
  });

  test("filters non-string entries from sources array", () => {
    const raw = [{ title: "T", severity: 5, description: "desc", sources: ["valid", 42, null, "also-valid"] }];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.sources).toEqual(["valid", "also-valid"]);
  });

  test("includes location when path is a string", () => {
    const raw = [
      {
        title: "T",
        severity: 5,
        description: "desc",
        location: { path: "src/foo.ts", line: 42 },
      },
    ];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.location).toEqual({ path: "src/foo.ts", line: 42 });
  });

  test("omits location.line when it is not a number", () => {
    const raw = [
      {
        title: "T",
        severity: 5,
        description: "desc",
        location: { path: "src/foo.ts", line: "not-a-number" },
      },
    ];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.location).toEqual({ path: "src/foo.ts" });
    expect(result[0]!.location?.line).toBeUndefined();
  });

  test("omits location entirely when path is not a string", () => {
    const raw = [
      {
        title: "T",
        severity: 5,
        description: "desc",
        location: { path: 123 },
      },
    ];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.location).toBeUndefined();
  });

  test("omits location when location object is null", () => {
    const raw = [{ title: "T", severity: 5, description: "desc", location: null }];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.location).toBeUndefined();
  });

  test("handles partial location object (only path, no line)", () => {
    const raw = [
      {
        title: "T",
        severity: 5,
        description: "desc",
        location: { path: "src/bar.ts" },
      },
    ];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(1);
    expect(result[0]!.location).toEqual({ path: "src/bar.ts" });
  });

  test("validates multiple mixed entries — valid and invalid", () => {
    const raw = [
      { title: "Good", severity: 5, description: "OK" },
      null,
      { title: "Also Good", severity: 8, description: "Also OK" },
      { severity: 5, description: "Missing title" },
    ];
    const result = validateRawFindings(raw as unknown[], "test-skill");
    expect(result).toHaveLength(2);
    expect(result[0]!.title).toBe("Good");
    expect(result[1]!.title).toBe("Also Good");
  });
});
