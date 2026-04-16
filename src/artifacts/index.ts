import { join, basename } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { timestampCompact, slugify } from "../utils/slugify.js";
import { ensureDir, writeJsonFile, writeText, readJsonFile, fileExists } from "../utils/fs.js";
import { getStateDir } from "../config/paths.js";
import type { DoneFlag, RunInfo, RunOutcome, SavedRunConfig } from "../types/index.js";

export function buildRunDir(cwd: string, planSlug: string): string {
  const ts = timestampCompact();
  const slug = slugify(planSlug, 50);
  return join(getStateDir(cwd), "runs", `${ts}-${slug}`);
}

export async function initRunDir(runDir: string): Promise<void> {
  await ensureDir(runDir);
}

export async function saveRunConfig(runDir: string, config: SavedRunConfig): Promise<void> {
  await writeJsonFile(join(runDir, "run-config.json"), config);
}

export async function snapshotPlan(runDir: string, planContent: string): Promise<void> {
  await writeText(join(runDir, "plan.txt"), planContent);
}

export function runIdFromRunDir(runDir: string): string {
  return basename(runDir);
}

export async function writeDoneFlag(runDir: string, flag: DoneFlag): Promise<void> {
  await writeJsonFile(join(runDir, "done.flag"), flag);
}

export async function readDoneFlag(runDir: string): Promise<DoneFlag | null> {
  const flagPath = join(runDir, "done.flag");
  if (!fileExists(flagPath)) return null;
  return await readJsonFile<DoneFlag>(flagPath);
}

// Matches run directory names like "20240101-120000-plan-slug"
const RUN_DIR_PATTERN = /^\d{8}-\d{6}-/;

export function listRuns(cwd: string): RunInfo[] {
  const runsDir = join(getStateDir(cwd), "runs");
  if (!fileExists(runsDir)) return [];

  const entries = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const runs: RunInfo[] = [];
  for (const entry of entries) {
    // Only log noise for entries that look like intended run dirs; silently skip others
    const looksLikeRunDir = RUN_DIR_PATTERN.test(entry);
    const runDir = join(runsDir, entry);
    const configPath = join(runDir, "run-config.json");
    if (!fileExists(configPath)) {
      if (looksLikeRunDir) {
        process.stderr.write(`  [runs] Skipping run directory '${entry}' — run-config.json not found\n`);
      }
      continue;
    }

    let startedAt = "";
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      startedAt = typeof raw.startedAt === "string" ? raw.startedAt : "";
    } catch {
      process.stderr.write(`  [runs] Skipping run '${entry}': corrupt run-config.json\n`);
      continue;
    }

    const doneFlagPath = join(runDir, "done.flag");
    let completed = false;
    let outcome: RunOutcome | undefined;
    if (fileExists(doneFlagPath)) {
      try {
        const flag = JSON.parse(readFileSync(doneFlagPath, "utf8")) as DoneFlag;
        outcome = flag.outcome;
        // Only clean/capped outcomes are truly "done" and not resumable.
        // Terminal failures (implement-failure, verify-failure, push-failure, etc.)
        // are still resumable, so they count as incomplete for auto-pick purposes.
        completed = flag.outcome === "clean" || flag.outcome === "capped";
      } catch {
        process.stderr.write(`  [runs] Skipping run '${entry}': corrupt done.flag\n`);
        continue;
      }
    }

    runs.push({ runId: entry, runDir, startedAt, completed, outcome });
  }

  // Sort by startedAt descending (most recent first)
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs;
}

export function findLatestIncompleteRun(cwd: string): RunInfo | null {
  const runs = listRuns(cwd);
  return runs.find((r) => !r.completed) ?? null;
}
