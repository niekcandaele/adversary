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
  if (typeof raw.testTimeoutMs === "number") layer.testTimeoutMs = raw.testTimeoutMs;
  if (typeof raw.prTimeoutMs === "number") layer.prTimeoutMs = raw.prTimeoutMs;
  if (typeof raw.summarizerTimeoutMs === "number")
    layer.summarizerTimeoutMs = raw.summarizerTimeoutMs;

  // browserAutomation
  if (raw.browserAutomation !== undefined) {
    if (!["warn", "require", "skip"].includes(raw.browserAutomation as string)) {
      throw new Error(
        `Invalid browserAutomation value: "${raw.browserAutomation}". Must be "warn", "require", or "skip".`
      );
    }
    layer.browserAutomation = raw.browserAutomation as import("../types/index.js").BrowserAutomationMode;
  }

  // customVerificationSteps
  if (raw.customVerificationSteps !== undefined) {
    if (!Array.isArray(raw.customVerificationSteps)) {
      throw new Error("customVerificationSteps must be an array");
    }
    const steps = raw.customVerificationSteps as unknown[];
    const seenNames = new Set<string>();
    layer.customVerificationSteps = steps.map((step, i) => {
      const s = step as Record<string, unknown>;
      if (typeof s.name !== "string") {
        throw new Error(`customVerificationSteps[${i}].name must be a string`);
      }
      if (!/^[A-Za-z0-9._-]+$/.test(s.name)) {
        throw new Error(
          `customVerificationSteps[${i}].name contains invalid characters (only alphanumeric, dots, hyphens, underscores allowed)`
        );
      }
      if (seenNames.has(s.name)) {
        throw new Error(`customVerificationSteps[${i}].name must be unique: "${s.name}"`);
      }
      seenNames.add(s.name);
      if (typeof s.commandTemplate !== "string") {
        throw new Error(`customVerificationSteps[${i}].commandTemplate must be a string`);
      }
      if (s.phase !== "parallel-review" && s.phase !== "deterministic") {
        throw new Error(
          `customVerificationSteps[${i}].phase must be "parallel-review" or "deterministic"`
        );
      }
      if (s.phase === "deterministic") {
        if (!['test', 'build', 'lint', 'typecheck'].includes(s.kind as string)) {
          throw new Error(
            `customVerificationSteps[${i}].kind must be "test", "build", "lint", or "typecheck" when phase is "deterministic"`
          );
        }
      } else if (s.kind !== undefined) {
        throw new Error(
          `customVerificationSteps[${i}].kind must be omitted when phase is "parallel-review"`
        );
      }
      return {
        name: s.name,
        commandTemplate: s.commandTemplate,
        phase: s.phase as import("../types/index.js").VerificationStepPhase,
        timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : undefined,
        kind: s.kind as import("../types/index.js").DeterministicStepKind | undefined,
      };
    });
  }

  // skillOverrides
  if (raw.skillOverrides !== undefined) {
    if (typeof raw.skillOverrides !== "object" || raw.skillOverrides === null || Array.isArray(raw.skillOverrides)) {
      throw new Error("skillOverrides must be an object");
    }
    const overrides = raw.skillOverrides as Record<string, unknown>;
    const parsed: Record<string, import("../types/index.js").SkillOverride> = {};
    for (const [key, val] of Object.entries(overrides)) {
      const v = val as Record<string, unknown>;
      if (v.extraContext !== undefined && v.promptFile !== undefined) {
        throw new Error(
          `skillOverrides.${key}: extraContext and promptFile are mutually exclusive`
        );
      }
      parsed[key] = {
        extraContext: typeof v.extraContext === "string" ? v.extraContext : undefined,
        promptFile: typeof v.promptFile === "string" ? v.promptFile : undefined,
      };
    }
    layer.skillOverrides = parsed;
  }

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

  // Note: this is a shallow merge. Array/object fields (customVerificationSteps,
  // skillOverrides) are replaced entirely by whichever layer sets them last —
  // they are NOT deep-merged. Set the full array/object in the most specific
  // config layer you want to take effect.
  return {
    ...DEFAULT_CONFIG,
    ...globalLayer,
    ...projectLayer,
  };
}
