import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { runStep } from "../src/runner/index.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "adversary-runner-test-"));
}

describe("runStep — successful command", () => {
  test("echoes output and succeeds", async () => {
    const dir = makeTempDir();
    const result = await runStep({
      command: "echo hello world",
      cwd: dir,
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 5000,
      label: "test-echo",
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(existsSync(result.stdoutPath)).toBe(true);
    const stdout = readFileSync(result.stdoutPath, "utf8");
    expect(stdout.trim()).toBe("hello world");
  });

  test("captures stderr separately", async () => {
    const dir = makeTempDir();
    const result = await runStep({
      command: "sh -c 'echo out; echo err >&2'",
      cwd: dir,
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 5000,
      label: "test-stderr",
    });

    expect(result.success).toBe(true);
    const stdout = readFileSync(result.stdoutPath, "utf8");
    const stderr = readFileSync(result.stderrPath, "utf8");
    expect(stdout.trim()).toBe("out");
    expect(stderr.trim()).toBe("err");
  });

  test("records duration", async () => {
    const dir = makeTempDir();
    const result = await runStep({
      command: "true",
      cwd: dir,
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 5000,
      label: "test-duration",
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});

describe("runStep — failing command", () => {
  test("non-zero exit code marks as failed", async () => {
    const dir = makeTempDir();
    const result = await runStep({
      command: "sh -c 'exit 42'",
      cwd: dir,
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 5000,
      label: "test-fail",
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  test("logs are still written on failure", async () => {
    const dir = makeTempDir();
    const result = await runStep({
      command: "sh -c 'echo failed-output; exit 1'",
      cwd: dir,
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 5000,
      label: "test-fail-logs",
    });

    expect(result.success).toBe(false);
    expect(existsSync(result.stdoutPath)).toBe(true);
    const stdout = readFileSync(result.stdoutPath, "utf8");
    expect(stdout.trim()).toBe("failed-output");
  });
});

describe("runStep — timeout behavior", () => {
  test("times out and sets timedOut flag", async () => {
    const dir = makeTempDir();
    const result = await runStep({
      command: "sleep 60",
      cwd: dir,
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 500, // 500ms timeout — will fire before sleep finishes
      label: "test-timeout",
    });

    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(124);
  }, 10000); // allow up to 10s for process kill to complete
});
