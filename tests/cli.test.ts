import { test, expect, describe } from "bun:test";
import { parseArgs } from "../src/cli/index.js";
import { validateRunOptions, isFailureOutcome } from "../src/cli/run.js";

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
      "--config", ".adversary.json",
    ]);
    expect(options["plan"]).toBe("plan.md");
    expect(options["turns"]).toBe("6");
    expect(options["severity-threshold"]).toBe("5");
    expect(options["base-branch"]).toBe("develop");
    expect(options["config"]).toBe(".adversary.json");
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

// ─────────────────────────────────────────────────────────────────────────────
// VI-1(a): isFailureOutcome — push-failure must be treated as failure
// ─────────────────────────────────────────────────────────────────────────────

describe("isFailureOutcome (VI-1a)", () => {
  test("returns true for push-failure", () => {
    expect(isFailureOutcome("push-failure")).toBe(true);
  });

  test("returns true for commit-failure", () => {
    expect(isFailureOutcome("commit-failure")).toBe(true);
  });

  test("returns true for implement-failure", () => {
    expect(isFailureOutcome("implement-failure")).toBe(true);
  });

  test("returns true for summarizer-failure", () => {
    expect(isFailureOutcome("summarizer-failure")).toBe(true);
  });

  test("returns true for verify-failure", () => {
    expect(isFailureOutcome("verify-failure")).toBe(true);
  });

  test("returns true for verify-error", () => {
    expect(isFailureOutcome("verify-error")).toBe(true);
  });

  test("returns false for clean", () => {
    expect(isFailureOutcome("clean")).toBe(false);
  });

  test("returns false for capped", () => {
    expect(isFailureOutcome("capped")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isFailureOutcome(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VI-2: parseArgs --yes and -y flags for resume command
// ─────────────────────────────────────────────────────────────────────────────

describe("parseArgs — resume --yes / -y flags (VI-2)", () => {
  test("parses --yes flag for resume command", () => {
    const { command, options } = parseArgs(["node", "adversary", "resume", "--yes"]);
    expect(command).toBe("resume");
    expect(options["yes"]).toBe(true);
  });

  test("parses -y flag for resume command", () => {
    const { command, options } = parseArgs(["node", "adversary", "resume", "-y"]);
    expect(command).toBe("resume");
    expect(options["y"]).toBe(true);
  });

  test("--yes is not in unknownFlags", () => {
    const { unknownFlags } = parseArgs(["node", "adversary", "resume", "--yes"]);
    expect(unknownFlags).not.toContain("--yes");
  });

  test("-y is not in unknownFlags", () => {
    const { unknownFlags } = parseArgs(["node", "adversary", "resume", "-y"]);
    expect(unknownFlags).not.toContain("-y");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VI-1: parseArgs --yes with positional run-id should not consume run-id as --yes value
// ─────────────────────────────────────────────────────────────────────────────

describe("parseArgs — VI-1: --yes does not consume positional run-id", () => {
  test("resume --yes some-run-id: options.yes === true (not the run-id string)", () => {
    const { command, options } = parseArgs(["node", "adversary", "resume", "--yes", "some-run-id"]);
    expect(command).toBe("resume");
    // --yes must be boolean true, NOT the run-id string
    expect(options["yes"]).toBe(true);
    // run-id should not appear as the value of --yes
    expect(options["yes"]).not.toBe("some-run-id");
  });

  test("resume --yes some-run-id: run-id is NOT captured in options (it stays as positional)", () => {
    const { options } = parseArgs(["node", "adversary", "resume", "--yes", "some-run-id"]);
    // 'some-run-id' is not a flag value — it should be treated as a positional (not in options)
    expect(options["yes"]).toBe(true);
    // The run-id 'some-run-id' should not appear anywhere as a flag value
    expect(Object.values(options)).not.toContain("some-run-id");
  });

  test("resume --yes: options.yes === true when no positional follows", () => {
    const { options } = parseArgs(["node", "adversary", "resume", "--yes"]);
    expect(options["yes"]).toBe(true);
  });

  test("resume some-run-id --yes: options.yes === true regardless of order", () => {
    const { command, options } = parseArgs(["node", "adversary", "resume", "some-run-id", "--yes"]);
    expect(command).toBe("resume");
    expect(options["yes"]).toBe(true);
  });
});
