import { join } from "node:path";
import { timestampCompact, slugify } from "../utils/slugify.js";
import { ensureDir, writeJsonFile, writeText } from "../utils/fs.js";
import { getStateDir } from "../config/paths.js";

export function buildRunDir(cwd: string, planSlug: string): string {
  const ts = timestampCompact();
  const slug = slugify(planSlug, 50);
  return join(getStateDir(cwd), "runs", `${ts}-${slug}`);
}

export async function initRunDir(runDir: string): Promise<void> {
  await ensureDir(runDir);
}

export async function saveRunConfig(runDir: string, config: unknown): Promise<void> {
  await writeJsonFile(join(runDir, "run-config.json"), config);
}

export async function snapshotPlan(runDir: string, planContent: string): Promise<void> {
  await writeText(join(runDir, "plan.txt"), planContent);
}
