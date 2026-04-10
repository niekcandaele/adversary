import { test, expect, describe } from "bun:test";
import { parseCommand } from "../src/runner/index.js";

describe("parseCommand", () => {
  test("splits simple command", () => {
    expect(parseCommand("git status")).toEqual(["git", "status"]);
  });

  test("handles single quotes", () => {
    expect(parseCommand("pi -p '/skill:verify --format=json'")).toEqual([
      "pi",
      "-p",
      "/skill:verify --format=json",
    ]);
  });

  test("handles double quotes", () => {
    expect(parseCommand('pi -p "/skill:verify --format=json"')).toEqual([
      "pi",
      "-p",
      "/skill:verify --format=json",
    ]);
  });

  test("handles multiple spaces", () => {
    expect(parseCommand("git  commit  -m  'message'")).toEqual(["git", "commit", "-m", "message"]);
  });

  test("handles at-sign prefix", () => {
    expect(parseCommand("pi -p @/path/to/prompt.md")).toEqual([
      "pi",
      "-p",
      "@/path/to/prompt.md",
    ]);
  });

  test("empty command", () => {
    expect(parseCommand("")).toEqual([]);
  });

  test("single token", () => {
    expect(parseCommand("pi")).toEqual(["pi"]);
  });
});
