import { test, expect, describe } from "bun:test";
import { detectPlatform } from "../src/preflight/index.js";

describe("detectPlatform", () => {
  test("detects github from https URL", () => {
    expect(detectPlatform("https://github.com/user/repo.git")).toBe("github");
  });

  test("detects github from git URL", () => {
    expect(detectPlatform("git@github.com:user/repo.git")).toBe("github");
  });

  test("detects gitlab from https URL", () => {
    expect(detectPlatform("https://gitlab.com/user/repo.git")).toBe("gitlab");
  });

  test("detects gitlab from custom domain", () => {
    expect(detectPlatform("https://gitlab.mycompany.com/user/repo.git")).toBe("gitlab");
  });

  test("returns unknown for other remotes", () => {
    expect(detectPlatform("https://bitbucket.org/user/repo.git")).toBe("unknown");
  });

  test("returns unknown for null remote", () => {
    expect(detectPlatform(null)).toBe("unknown");
  });
});
