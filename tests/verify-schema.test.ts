import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { parseVerifyOutput, filterFindings, VerifyParseError } from "../src/loop/index.js";
import type { VerifyFinding } from "../src/types/index.js";

// Helper: write JSON to a temp file and return its path
function writeTempJson(data: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "adversary-test-"));
  const file = join(dir, "verify.json");
  writeFileSync(file, JSON.stringify(data));
  return file;
}

describe("parseVerifyOutput — valid input", () => {
  test("minimal ok report", async () => {
    const path = writeTempJson({ schemaVersion: 1, status: "ok", findings: [] });
    const report = await parseVerifyOutput(path);
    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("ok");
    expect(report.findings).toHaveLength(0);
  });

  test("report with findings", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [
        { title: "T", severity: 7, description: "D", sources: ["reviewer"] },
      ],
    });
    const report = await parseVerifyOutput(path);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.severity).toBe(7);
  });

  test("error status", async () => {
    const path = writeTempJson({ schemaVersion: 1, status: "error", findings: [] });
    const report = await parseVerifyOutput(path);
    expect(report.status).toBe("error");
  });
});

describe("parseVerifyOutput — error cases", () => {
  test("missing file throws VerifyParseError", async () => {
    await expect(parseVerifyOutput("/nonexistent/path/verify.json")).rejects.toBeInstanceOf(
      VerifyParseError
    );
  });

  test("missing schemaVersion throws VerifyParseError", async () => {
    const path = writeTempJson({ status: "ok", findings: [] });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("wrong schemaVersion throws VerifyParseError", async () => {
    const path = writeTempJson({ schemaVersion: 2, status: "ok", findings: [] });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("invalid status throws VerifyParseError", async () => {
    const path = writeTempJson({ schemaVersion: 1, status: "unknown", findings: [] });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("blocked status is no longer valid — throws VerifyParseError", async () => {
    const path = writeTempJson({ schemaVersion: 1, status: "blocked", findings: [] });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("non-array findings throws VerifyParseError", async () => {
    const path = writeTempJson({ schemaVersion: 1, status: "ok", findings: "bad" });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("non-object input throws VerifyParseError", async () => {
    const path = writeTempJson([1, 2, 3]);
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("null input throws VerifyParseError", async () => {
    const path = writeTempJson(null);
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });
});

describe("parseVerifyOutput — individual finding validation", () => {
  test("finding missing title throws VerifyParseError", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [{ severity: 7, description: "D", sources: ["reviewer"] }],
    });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("finding missing severity throws VerifyParseError", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [{ title: "T", description: "D", sources: ["reviewer"] }],
    });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("finding missing description throws VerifyParseError", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [{ title: "T", severity: 7, sources: ["reviewer"] }],
    });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("finding missing sources throws VerifyParseError", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [{ title: "T", severity: 7, description: "D" }],
    });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("finding with non-string title throws VerifyParseError", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [{ title: 42, severity: 7, description: "D", sources: [] }],
    });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("finding with non-number severity throws VerifyParseError", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [{ title: "T", severity: "high", description: "D", sources: [] }],
    });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("finding with null severity throws VerifyParseError (JSON.stringify(NaN) === 'null')", async () => {
    // Standard JSON cannot encode NaN (JSON.stringify(NaN) === "null"). The resulting null
    // fails the typeof !== "number" check, which is the real guard here.
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [{ title: "T", severity: null, description: "D", sources: [] }],
    });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("finding with non-array sources throws VerifyParseError", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [{ title: "T", severity: 7, description: "D", sources: "reviewer" }],
    });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("null finding entry throws VerifyParseError", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [null],
    });
    await expect(parseVerifyOutput(path)).rejects.toBeInstanceOf(VerifyParseError);
  });

  test("valid finding with optional location passes", async () => {
    const path = writeTempJson({
      schemaVersion: 1,
      status: "ok",
      findings: [
        {
          title: "T",
          severity: 7,
          description: "D",
          sources: ["reviewer"],
          location: { path: "src/foo.ts", line: 10, column: 1 },
        },
      ],
    });
    const report = await parseVerifyOutput(path);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.location?.line).toBe(10);
  });
});

describe("filterFindings", () => {
  const findings: VerifyFinding[] = [
    { title: "A", severity: 9, description: "", sources: [] },
    { title: "B", severity: 7, description: "", sources: [] },
    { title: "C", severity: 5, description: "", sources: [] },
    { title: "D", severity: 3, description: "", sources: [] },
  ];

  test("splits correctly at threshold 7", () => {
    const { thresholdFindings, belowThresholdFindings } = filterFindings(findings, 7);
    expect(thresholdFindings.map((f) => f.title)).toEqual(["A", "B"]);
    expect(belowThresholdFindings.map((f) => f.title)).toEqual(["C", "D"]);
  });

  test("threshold 1 — all above", () => {
    const { thresholdFindings, belowThresholdFindings } = filterFindings(findings, 1);
    expect(thresholdFindings).toHaveLength(4);
    expect(belowThresholdFindings).toHaveLength(0);
  });

  test("threshold 10 — none above", () => {
    const { thresholdFindings, belowThresholdFindings } = filterFindings(findings, 10);
    expect(thresholdFindings).toHaveLength(0);
    expect(belowThresholdFindings).toHaveLength(4);
  });

  test("empty findings array", () => {
    const { thresholdFindings, belowThresholdFindings } = filterFindings([], 7);
    expect(thresholdFindings).toHaveLength(0);
    expect(belowThresholdFindings).toHaveLength(0);
  });

  test("boundary: severity exactly at threshold is included above", () => {
    const single: VerifyFinding[] = [{ title: "X", severity: 7, description: "", sources: [] }];
    const { thresholdFindings } = filterFindings(single, 7);
    expect(thresholdFindings).toHaveLength(1);
  });
});
