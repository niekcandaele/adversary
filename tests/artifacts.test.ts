import { test, expect, describe, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { buildRunDir, listRuns } from "../src/artifacts/index.js";
import { slugify } from "../src/utils/slugify.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ─────────────────────────────────────────────────────────────────────────────
// VI-2: listRuns skips corrupt JSON files with a warning
// ─────────────────────────────────────────────────────────────────────────────

describe("listRuns — corrupt JSON skipped with warning (VI-2)", () => {
  let stateDir: string;
  let savedXdgState: string | undefined;
  let repoDir: string;
  let runsDir: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "adversary-artifacts-corrupt-"));
    savedXdgState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;

    // Create a fake repo dir (no git needed for listRuns — just needs the path)
    repoDir = join(stateDir, "myrepo");
    await mkdir(repoDir, { recursive: true });

    // Compute the runsDir that getStateDir would produce
    const { getStateDir } = await import("../src/config/paths.js");
    runsDir = join(getStateDir(repoDir), "runs");
    await mkdir(runsDir, { recursive: true });
  });

  afterAll(async () => {
    if (savedXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdgState;
    await rm(stateDir, { recursive: true, force: true });
  });

  let savedStderrInTest: typeof process.stderr.write | null = null;

  afterAll(() => {
    // Backstop: ensure process.stderr.write is restored even if the test throws
    if (savedStderrInTest) {
      process.stderr.write = savedStderrInTest;
      savedStderrInTest = null;
    }
  });

  test("listRuns skips a run dir with corrupt run-config.json and logs warning", async () => {
    // Create a valid run
    const validRunDir = join(runsDir, "20240101-120000-valid-run");
    await mkdir(validRunDir, { recursive: true });
    await writeFile(
      join(validRunDir, "run-config.json"),
      JSON.stringify({ startedAt: "2024-01-01T12:00:00.000Z", turns: 5, threshold: 7, branch: "adversary/test", baseBranch: "main" })
    );

    // Create a run with corrupt run-config.json
    const corruptRunDir = join(runsDir, "20240102-120000-corrupt-run");
    await mkdir(corruptRunDir, { recursive: true });
    await writeFile(join(corruptRunDir, "run-config.json"), "{ this is not valid json !!!!");

    const stderrChunks: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    savedStderrInTest = origStderr;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : "");
      return true;
    }) as never;

    let runs: Array<{ runId: string }>;
    try {
      runs = listRuns(repoDir);
    } finally {
      process.stderr.write = origStderr;
      savedStderrInTest = null;
    }

    // Corrupt run must be skipped
    expect(runs.map(r => r.runId)).not.toContain("20240102-120000-corrupt-run");
    // Valid run must still be included
    expect(runs.map(r => r.runId)).toContain("20240101-120000-valid-run");
    // Warning must have been logged
    const stderr = stderrChunks.join("");
    expect(stderr).toMatch(/corrupt run-config\.json/i);
    expect(stderr).toMatch(/20240102-120000-corrupt-run/);
  });
});
