import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(join(path, ".."));
  await Bun.write(path, content);
}

export async function readText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const text = await Bun.file(path).text();
  return JSON.parse(text) as T;
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await writeText(path, JSON.stringify(data, null, 2));
}
