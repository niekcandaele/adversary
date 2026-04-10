import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { ensureDir, writeText, readText, fileExists, readJsonFile, writeJsonFile } from "../src/utils/fs.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "adversary-fs-test-"));
}

describe("ensureDir", () => {
  test("creates a new directory", async () => {
    const base = makeTempDir();
    const target = join(base, "a", "b", "c");
    await ensureDir(target);
    expect(existsSync(target)).toBe(true);
  });

  test("does not throw if directory already exists", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    await ensureDir(dir); // second call should be idempotent
    expect(existsSync(dir)).toBe(true);
  });
});

describe("writeText / readText", () => {
  test("writes and reads back text", async () => {
    const dir = makeTempDir();
    const file = join(dir, "test.txt");
    await writeText(file, "hello world");
    const content = await readText(file);
    expect(content).toBe("hello world");
  });

  test("creates intermediate directories", async () => {
    const dir = makeTempDir();
    const file = join(dir, "nested", "dir", "file.txt");
    await writeText(file, "data");
    expect(existsSync(file)).toBe(true);
  });

  test("overwrites existing file", async () => {
    const dir = makeTempDir();
    const file = join(dir, "file.txt");
    await writeText(file, "first");
    await writeText(file, "second");
    const content = await readText(file);
    expect(content).toBe("second");
  });
});

describe("fileExists", () => {
  test("returns true for existing file", async () => {
    const dir = makeTempDir();
    const file = join(dir, "exists.txt");
    await writeText(file, "x");
    expect(fileExists(file)).toBe(true);
  });

  test("returns false for missing file", () => {
    expect(fileExists("/nonexistent/path/file.txt")).toBe(false);
  });
});

describe("writeJsonFile / readJsonFile", () => {
  test("serializes and deserializes JSON", async () => {
    const dir = makeTempDir();
    const file = join(dir, "data.json");
    const data = { schemaVersion: 1, status: "ok", findings: [{ title: "T", severity: 7 }] };
    await writeJsonFile(file, data);
    const read = await readJsonFile<typeof data>(file);
    expect(read.schemaVersion).toBe(1);
    expect(read.status).toBe("ok");
    expect(read.findings[0]?.severity).toBe(7);
  });

  test("produces pretty-printed JSON", async () => {
    const dir = makeTempDir();
    const file = join(dir, "pretty.json");
    await writeJsonFile(file, { a: 1 });
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("\n"); // pretty-printed has newlines
  });
});
