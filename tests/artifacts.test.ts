import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { buildRunDir } from "../src/artifacts/index.js";
import { slugify } from "../src/utils/slugify.js";

describe("buildRunDir", () => {
  let savedXdgStateHome: string | undefined;

  beforeEach(() => {
    savedXdgStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/tmp/test-state";
  });

  afterEach(() => {
    if (savedXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = savedXdgStateHome;
    }
  });

  test("path is under XDG state dir, not cwd", () => {
    const dir = buildRunDir("/repo", "my-plan");
    expect(dir.startsWith("/tmp/test-state/adversary/")).toBe(true);
    // Must NOT start with cwd
    expect(dir.startsWith("/repo")).toBe(false);
  });

  test("path contains 'runs' subdir", () => {
    const dir = buildRunDir("/repo", "my-plan");
    expect(dir).toContain("/runs/");
  });

  test("includes slug in dir name", () => {
    const dir = buildRunDir("/repo", "add json verify output");
    expect(dir).toContain("add-json-verify-output");
  });

  test("path is deterministic given same input (barring timestamp)", () => {
    const dir1 = buildRunDir("/repo", "my-plan");
    const dir2 = buildRunDir("/repo", "my-plan");
    // Both should contain "my-plan" in the path
    expect(dir1).toContain("my-plan");
    expect(dir2).toContain("my-plan");
  });

  test("state dir encodes cwd basename", () => {
    const dir = buildRunDir("/projects/coolrepo", "my-plan");
    expect(dir).toContain("coolrepo-");
  });
});

describe("slugify for plan names", () => {
  test("plan heading becomes valid dir name", () => {
    const title = "Build a Bun CLI for adversarial implement→verify loops";
    const slug = slugify(title);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});
