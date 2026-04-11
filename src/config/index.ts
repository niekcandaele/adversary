import { join } from "node:path";
import type { AdversaryConfig } from "../types/index.js";
import { DEFAULT_CONFIG } from "../types/index.js";
import { fileExists } from "../utils/fs.js";

const CONFIG_FILENAME = ".pi-adversary.json";

export async function loadConfig(cwd: string, overridePath?: string): Promise<AdversaryConfig> {
  const configPath = overridePath ?? join(cwd, CONFIG_FILENAME);

  if (!fileExists(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  let raw: Record<string, unknown>;
  try {
    raw = await Bun.file(configPath).json();
  } catch (e) {
    throw new Error(`Failed to parse config file ${configPath}: ${e}`);
  }

  return {
    baseBranch: typeof raw.baseBranch === "string" ? raw.baseBranch : DEFAULT_CONFIG.baseBranch,
    implementCommandTemplate:
      typeof raw.implementCommandTemplate === "string"
        ? raw.implementCommandTemplate
        : DEFAULT_CONFIG.implementCommandTemplate,
    verifyCommandTemplate:
      typeof raw.verifyCommandTemplate === "string"
        ? raw.verifyCommandTemplate
        : DEFAULT_CONFIG.verifyCommandTemplate,
    summarizerCommandTemplate:
      typeof raw.summarizerCommandTemplate === "string"
        ? raw.summarizerCommandTemplate
        : DEFAULT_CONFIG.summarizerCommandTemplate,
    implementTimeoutMs:
      typeof raw.implementTimeoutMs === "number"
        ? raw.implementTimeoutMs
        : DEFAULT_CONFIG.implementTimeoutMs,
    verifyTimeoutMs:
      typeof raw.verifyTimeoutMs === "number"
        ? raw.verifyTimeoutMs
        : DEFAULT_CONFIG.verifyTimeoutMs,
    prTimeoutMs:
      typeof raw.prTimeoutMs === "number" ? raw.prTimeoutMs : DEFAULT_CONFIG.prTimeoutMs,
    summarizerTimeoutMs:
      typeof raw.summarizerTimeoutMs === "number"
        ? raw.summarizerTimeoutMs
        : DEFAULT_CONFIG.summarizerTimeoutMs,
  };
}
