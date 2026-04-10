import { test, expect, describe } from "bun:test";
import { parseArgs } from "../src/cli/index.js";
import { validateRunOptions } from "../src/cli/run.js";

describe("parseArgs", () => {
  test("parses run command with required --plan flag", () => {
    const { command, options, unknownFlags } = parseArgs(["node", "adversary", "run", "--plan", "plan.md"]);
    expect(command).toBe("run");
    expect(options["plan"]).toBe("plan.md");
    expect(unknownFlags).toHaveLength(0);
  });

  test("parses all known flags", () => {
    const { options, unknownFlags } = parseArgs([
      "node", "adversary", "run",
      "--plan", "plan.md",
      "--turns", "6",
      "--severity-threshold", "5",
      "--base-branch", "develop",
      "--config", ".pi-adversary.json",
    ]);
    expect(options["plan"]).toBe("plan.md");
    expect(options["turns"]).toBe("6");
    expect(options["severity-threshold"]).toBe("5");
    expect(options["base-branch"]).toBe("develop");
    expect(options["config"]).toBe(".pi-adversary.json");
    expect(unknownFlags).toHaveLength(0);
  });

  test("detects --help flag", () => {
    const { options } = parseArgs(["node", "adversary", "--help"]);
    expect(options["help"]).toBe(true);
  });

  test("detects -h flag", () => {
    const { options } = parseArgs(["node", "adversary", "-h"]);
    expect(options["help"]).toBe(true);
  });

  test("detects --version flag", () => {
    const { options } = parseArgs(["node", "adversary", "--version"]);
    expect(options["version"]).toBe(true);
  });

  test("detects -v flag", () => {
    const { options } = parseArgs(["node", "adversary", "-v"]);
    expect(options["version"]).toBe(true);
  });

  test("sets command to null when no command given", () => {
    const { command } = parseArgs(["node", "adversary", "--help"]);
    expect(command).toBeNull();
  });

  test("warns on unknown flags", () => {
    const { unknownFlags } = parseArgs(["node", "adversary", "run", "--plan", "p.md", "--unknown-flag"]);
    expect(unknownFlags).toContain("--unknown-flag");
  });

  test("handles boolean flag (no value)", () => {
    const { options } = parseArgs(["node", "adversary", "--help"]);
    expect(options["help"]).toBe(true);
  });

  test("handles empty argv (beyond node/script)", () => {
    const { command, options } = parseArgs(["node", "adversary"]);
    expect(command).toBeNull();
    expect(Object.keys(options)).toHaveLength(0);
  });

  test("--plan followed by single-dash value is consumed as value (not boolean)", () => {
    // The parser only treats the next arg as a boolean if it starts with '--'.
    // Single-dash values like '-not-a-file' are consumed as the flag's value.
    const { options } = parseArgs(["node", "adversary", "run", "--plan", "-not-a-file"]);
    expect(options["plan"]).toBe("-not-a-file");
  });

  test("--plan without value becomes boolean true", () => {
    // When --plan is the last arg, there's no next value, so it becomes boolean true.
    const { options } = parseArgs(["node", "adversary", "run", "--plan"]);
    expect(options["plan"]).toBe(true);
  });
});

describe("validateRunOptions", () => {
  test("accepts valid options", () => {
    expect(() =>
      validateRunOptions({ plan: "plan.md", turns: 5, severityThreshold: 7 })
    ).not.toThrow();
  });

  test("throws when turns < 1", () => {
    expect(() =>
      validateRunOptions({ plan: "plan.md", turns: 0, severityThreshold: 7 })
    ).toThrow("--turns must be >= 1");
  });

  test("throws when turns is negative", () => {
    expect(() =>
      validateRunOptions({ plan: "plan.md", turns: -1, severityThreshold: 7 })
    ).toThrow("--turns must be >= 1");
  });

  test("accepts turns = 1 (minimum)", () => {
    expect(() =>
      validateRunOptions({ plan: "plan.md", turns: 1, severityThreshold: 7 })
    ).not.toThrow();
  });

  test("throws when severityThreshold < 1", () => {
    expect(() =>
      validateRunOptions({ plan: "plan.md", turns: 5, severityThreshold: 0 })
    ).toThrow("--severity-threshold must be between 1 and 10");
  });

  test("throws when severityThreshold > 10", () => {
    expect(() =>
      validateRunOptions({ plan: "plan.md", turns: 5, severityThreshold: 11 })
    ).toThrow("--severity-threshold must be between 1 and 10");
  });

  test("accepts severityThreshold = 1 (lower bound)", () => {
    expect(() =>
      validateRunOptions({ plan: "plan.md", turns: 5, severityThreshold: 1 })
    ).not.toThrow();
  });

  test("accepts severityThreshold = 10 (upper bound)", () => {
    expect(() =>
      validateRunOptions({ plan: "plan.md", turns: 5, severityThreshold: 10 })
    ).not.toThrow();
  });
});
