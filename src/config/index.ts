import { join } from "node:path";
import type { AdversaryConfig } from "../types/index.js";
import { DEFAULT_CONFIG } from "../types/index.js";
import { fileExists } from "../utils/fs.js";
import { getGlobalConfigPath, resolveGitRoot } from "./paths.js";

const CONFIG_FILENAME = ".adversary.json";
const LEGACY_CONFIG_FILENAME = ".pi-adversary.json";

function parseConfigLayer(raw: Record<string, unknown>): Partial<AdversaryConfig> {
  const layer: Partial<AdversaryConfig> = {};
  if (typeof raw.baseBranch === "string") layer.baseBranch = raw.baseBranch;
  if (typeof raw.implementCommandTemplate === "string")
    layer.implementCommandTemplate = raw.implementCommandTemplate;
  if (typeof raw.verifyCommandTemplate === "string")
    layer.verifyCommandTemplate = raw.verifyCommandTemplate;
  if (typeof raw.summarizerCommandTemplate === "string")
    layer.summarizerCommandTemplate = raw.summarizerCommandTemplate;
  if (typeof raw.implementTimeoutMs === "number")
    layer.implementTimeoutMs = raw.implementTimeoutMs;
  if (typeof raw.verifyTimeoutMs === "number") layer.verifyTimeoutMs = raw.verifyTimeoutMs;
  if (typeof raw.prTimeoutMs === "number") layer.prTimeoutMs = raw.prTimeoutMs;
  if (typeof raw.summarizerTimeoutMs === "number")
    layer.summarizerTimeoutMs = raw.summarizerTimeoutMs;
  return layer;
}

async function loadLayer(path: string): Promise<Partial<AdversaryConfig>> {
  if (!fileExists(path)) {
    return {};
  }

  let raw: Record<string, unknown>;
  try {
    raw = await Bun.file(path).json();
  } catch (e) {
    throw new Error(`Failed to parse config file ${path}: ${e}`);
  }

  return parseConfigLayer(raw);
}

export async function loadConfig(cwd: string, overridePath?: string): Promise<AdversaryConfig> {
  const gitRoot = resolveGitRoot(cwd);

  if (!overridePath && fileExists(join(gitRoot, LEGACY_CONFIG_FILENAME)) && !fileExists(join(gitRoot, CONFIG_FILENAME))) {
    process.stderr.write(
      `Warning: .pi-adversary.json is no longer read — rename it to .adversary.json or your settings will be ignored.\n`
    );
  }

  const globalLayer = await loadLayer(getGlobalConfigPath());
  const projectPath = overridePath ?? join(gitRoot, CONFIG_FILENAME);
  const projectLayer = await loadLayer(projectPath);

  return {
    ...DEFAULT_CONFIG,
    ...globalLayer,
    ...projectLayer,
  };
}
