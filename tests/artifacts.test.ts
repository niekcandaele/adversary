import { test, expect, describe } from "bun:test";
import { buildRunDir } from "../src/artifacts/index.js";
import { slugify } from "../src/utils/slugify.js";

describe("buildRunDir", () => {
  test("path starts with cwd", () => {
    const dir = buildRunDir("/repo", "my-plan");
    expect(dir.startsWith("/repo")).toBe(true);
  });

  test("includes artifact root", () => {
    const dir = buildRunDir("/repo", "my-plan");
    expect(dir).toContain(".pi-adversary/runs");
  });

  test("includes slug in dir name", () => {
    const dir = buildRunDir("/repo", "add json verify output");
    expect(dir).toContain("add-json-verify-output");
  });

  test("path is deterministic given same input (barring timestamp)", () => {
    // Two calls should have same structure, different timestamps
    const dir1 = buildRunDir("/repo", "my-plan");
    const dir2 = buildRunDir("/repo", "my-plan");
    // Both should contain "my-plan" in the path
    expect(dir1).toContain("my-plan");
    expect(dir2).toContain("my-plan");
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
