/**
 * Unit tests for validateRawFindings in src/verify/findings.ts
 */
import { test, expect, describe } from "bun:test";
import { validateRawFindings } from "../src/verify/findings.js";

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
