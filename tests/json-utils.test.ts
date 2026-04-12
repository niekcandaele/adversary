/**
 * Tests for the shared extractJson utility (src/utils/json.ts)
 * Covers VI-5: unit tests for the consolidated extractJson.
 */
import { test, expect, describe } from "bun:test";
import { extractJson } from "../src/utils/json.js";

describe("extractJson", () => {
  test("parses raw JSON object", () => {
    const result = extractJson('{"status":"ok","findings":[]}');
    expect(result).toEqual({ status: "ok", findings: [] });
  });

  test("parses raw JSON with surrounding whitespace", () => {
    const result = extractJson('  \n{"foo": 42}\n  ');
    expect(result).toEqual({ foo: 42 });
  });

  test("extracts JSON from markdown json code fence", () => {
    const text = 'Here is the result:\n```json\n{"status":"ok","findings":[]}\n```\nDone.';
    const result = extractJson(text);
    expect(result).toEqual({ status: "ok", findings: [] });
  });

  test("extracts JSON from generic code fence (no language tag)", () => {
    const text = "Result:\n```\n{\"x\": 1}\n```";
    const result = extractJson(text);
    expect(result).toEqual({ x: 1 });
  });

  test("extracts JSON using brace-balancing when wrapped in prose", () => {
    const text = 'The analysis is done. {"status":"ok","findings":[{"title":"T","severity":5}]} End.';
    const result = extractJson(text) as Record<string, unknown>;
    expect(result.status).toBe("ok");
  });

  test("handles nested objects correctly via brace-balancing", () => {
    const text = 'Prefix {"a": {"b": {"c": 3}}} suffix';
    const result = extractJson(text);
    expect(result).toEqual({ a: { b: { c: 3 } } });
  });

  test("handles escaped braces in strings (brace-balancing)", () => {
    const text = 'Output: {"key": "value with { brace inside }"}';
    const result = extractJson(text);
    expect(result).toEqual({ key: "value with { brace inside }" });
  });

  test("throws with a useful message when no JSON found", () => {
    expect(() => extractJson("This is plain text with no JSON")).toThrow(
      /Could not extract JSON/
    );
  });

  test("throws when output is empty", () => {
    expect(() => extractJson("")).toThrow(/Could not extract JSON/);
  });

  test("throws with output preview in the error message", () => {
    expect(() => extractJson("no json here xyz")).toThrow(/Output preview:/);
  });

  test("discovery output (bare discovery JSON)", () => {
    const json = JSON.stringify({
      testCommand: "bun test",
      buildCommand: null,
      lintCommands: [],
      typeCheckCommands: [],
      startCommand: null,
      browserDeps: [],
    });
    const result = extractJson(json) as Record<string, unknown>;
    expect(result.testCommand).toBe("bun test");
    expect(result.browserDeps).toEqual([]);
  });

  test("re-export from discovery module still works", async () => {
    const { extractJson: discoveryExtractJson } = await import("../src/discovery/index.js");
    const result = discoveryExtractJson('{"x":1}');
    expect(result).toEqual({ x: 1 });
  });
});
