import { join } from "node:path";
import type { AdversaryConfig, ToolchainDiscovery, VerifyScope } from "../types/index.js";
import { runStep } from "../runner/index.js";
import { writeText, writeJsonFile, readJsonFile, fileExists, ensureDir } from "../utils/fs.js";
import { interpolate } from "../utils/slugify.js";
import { loadSkillTemplate } from "../prompts/skills/loader.js";
import { buildScopeContext } from "../scope/index.js";
import { extractJson } from "../utils/json.js";

// Re-export for backward compatibility — callers that imported extractJson from here still work.
export { extractJson } from "../utils/json.js";

const DISCOVERY_CACHE_FILE = "discovery.json";
const PROJECT_SKILLS_CACHE_FILE = "projectSkills.txt";

/**
 * Run toolchain discovery. Cached after turn 1 using {runDir}/discovery.json.
 * Also caches project skills in {runDir}/projectSkills.txt to avoid redundant
 * find commands on every turn.
 */
export async function runDiscovery(options: {
  cwd: string;
  scope: VerifyScope;
  config: AdversaryConfig;
  runDir: string;
  turnDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ToolchainDiscovery> {
  const { cwd, scope, config, runDir, turnDir, env } = options;

  // Check cache — both discovery and projectSkills are written together.
  // Known limitation: there is no cache invalidation mechanism. If the project's
  // toolchain changes mid-run (e.g. new dependencies installed, package.json updated),
  // the cached discovery from turn 1 will be used for all subsequent turns.
  // To force re-discovery, delete {runDir}/discovery.json manually.
  const cachePath = join(runDir, DISCOVERY_CACHE_FILE);
  if (fileExists(cachePath)) {
    return await readJsonFile<ToolchainDiscovery>(cachePath);
  }

  // Generate project structure snapshot
  const projectStructure = await gatherProjectStructure(cwd);

  // Discover project skills (cache alongside discovery)
  const projectSkillsCachePath = join(runDir, PROJECT_SKILLS_CACHE_FILE);
  const projectSkills = await discoverProjectSkills(cwd);
  // Write project skills cache so the loop doesn't re-run find commands each turn
  await writeText(projectSkillsCachePath, projectSkills);

  // Load and interpolate discovery template
  const template = await loadSkillTemplate("discovery");
  const scopeContext = buildScopeContext(scope);
  const prompt = template
    .replace("{scopeContext}", () => scopeContext)
    .replace("{projectStructure}", () => projectStructure)
    .replace("{projectSkills}", () => projectSkills);

  // Write prompt file
  const verifyDir = join(turnDir, "verify");
  await ensureDir(verifyDir);
  const promptPath = join(verifyDir, "discovery.prompt.md");
  await writeText(promptPath, prompt);

  // Run harness
  const vars: Record<string, string> = { promptFile: promptPath };
  const command = interpolate(config.verifyCommandTemplate, vars);
  const stdoutPath = join(verifyDir, "discovery.stdout.log");
  const stderrPath = join(verifyDir, "discovery.stderr.log");

  const result = await runStep({
    command,
    cwd,
    stdoutPath,
    stderrPath,
    timeoutMs: config.verifyTimeoutMs,
    label: "discovery",
    env,
  });

  // Parse output
  const stdoutText = await Bun.file(stdoutPath).text();
  let discovery: ToolchainDiscovery;
  let parsedSuccessfully = false;
  try {
    discovery = extractJson(stdoutText) as ToolchainDiscovery;
    parsedSuccessfully = true;
  } catch {
    // Fallback: return empty discovery if parse fails
    process.stderr.write(
      `  Warning: discovery output parse failed (exit ${result.exitCode}), using empty discovery\n`
    );
    discovery = {
      testCommand: null,
      buildCommand: null,
      lintCommands: [],
      typeCheckCommands: [],
      startCommand: null,
      browserDeps: [],
    };
  }

  // Validate and normalize
  discovery = normalizeDiscovery(discovery);

  // Only cache successful discovery — don't poison the cache with empty fallbacks
  if (parsedSuccessfully) {
    await writeJsonFile(cachePath, discovery);
  }

  return discovery;
}

export function normalizeDiscovery(raw: unknown): ToolchainDiscovery {
  // Guard: if input is not an object, return empty discovery rather than crashing
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      testCommand: null,
      buildCommand: null,
      lintCommands: [],
      typeCheckCommands: [],
      startCommand: null,
      browserDeps: [],
    };
  }
  const d = raw as Record<string, unknown>;
  return {
    testCommand: typeof d.testCommand === "string" ? d.testCommand : null,
    buildCommand: typeof d.buildCommand === "string" ? d.buildCommand : null,
    lintCommands: Array.isArray(d.lintCommands)
      ? d.lintCommands.filter((x): x is string => typeof x === "string")
      : [],
    typeCheckCommands: Array.isArray(d.typeCheckCommands)
      ? d.typeCheckCommands.filter((x): x is string => typeof x === "string")
      : [],
    startCommand: typeof d.startCommand === "string" ? d.startCommand : null,
    browserDeps: Array.isArray(d.browserDeps)
      ? d.browserDeps.filter((x): x is string => typeof x === "string")
      : [],
  };
}

// Size limits to prevent unbounded prompt growth
const MAX_FILE_ENTRIES = 500;
const MAX_CONFIG_FILE_BYTES = 10 * 1024; // 10KB

async function gatherProjectStructure(cwd: string): Promise<string> {
  const sections: string[] = [];

  // Directory listing — cap at MAX_FILE_ENTRIES lines to bound prompt size
  const lsProc = Bun.spawn(
    ["find", ".", "-maxdepth", "3", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"],
    { cwd, stdout: "pipe", stderr: "pipe" }
  );
  const lsExitCode = await lsProc.exited;
  if (lsExitCode !== 0) {
    process.stderr.write(`  Warning: project structure find command exited with code ${lsExitCode} — file listing may be incomplete\n`);
  }
  const lsRaw = (await new Response(lsProc.stdout).text()).trim();
  const lsLines = lsRaw.split("\n").filter((l) => l.length > 0);
  const lsTruncated = lsLines.length > MAX_FILE_ENTRIES
    ? lsLines.slice(0, MAX_FILE_ENTRIES).join("\n") + `\n... (${lsLines.length - MAX_FILE_ENTRIES} more files truncated)`
    : lsRaw;
  sections.push("## Project Files (depth 3, excluding node_modules/.git)\n\n" + lsTruncated);

  // Config files — read with size cap to bound prompt size
  const configFiles: Array<{ path: string; lang: string; header: string }> = [
    { path: join(cwd, "package.json"), lang: "json", header: "## package.json" },
    { path: join(cwd, "pyproject.toml"), lang: "toml", header: "## pyproject.toml" },
    { path: join(cwd, "Makefile"), lang: "makefile", header: "## Makefile" },
  ];

  for (const { path, lang, header } of configFiles) {
    if (!fileExists(path)) continue;
    try {
      const content = await Bun.file(path).text();
      const truncated = content.length > MAX_CONFIG_FILE_BYTES
        ? content.slice(0, MAX_CONFIG_FILE_BYTES) + `\n... (truncated at ${MAX_CONFIG_FILE_BYTES} bytes)`
        : content;
      sections.push(`${header}\n\n\`\`\`${lang}\n${truncated}\n\`\`\``);
    } catch {
      // skip unreadable files
    }
  }

  return sections.join("\n\n");
}

/**
 * Read cached project skills from a previous discovery run.
 * Returns empty string if no cache exists (will be populated by runDiscovery).
 */
export async function getCachedProjectSkills(runDir: string): Promise<string> {
  const cachePath = join(runDir, PROJECT_SKILLS_CACHE_FILE);
  if (!fileExists(cachePath)) return "";
  return await Bun.file(cachePath).text();
}

/**
 * Discover project skills from .claude/skills/ and .pi/skills/ directories.
 * Returns concatenated skill content.
 */
export async function discoverProjectSkills(cwd: string): Promise<string> {
  const searchDirs = [
    join(cwd, ".claude", "skills"),
    join(cwd, ".pi", "skills"),
  ];

  const skillContents: string[] = [];

  for (const dir of searchDirs) {
    if (!fileExists(dir)) continue;

    // Find SKILL.md files
    const findProc = Bun.spawn(
      ["find", dir, "-name", "SKILL.md"],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    await findProc.exited;
    const found = (await new Response(findProc.stdout).text()).trim();

    if (!found) continue;

    for (const skillPath of found.split("\n").filter((p) => p.trim())) {
      try {
        const content = await Bun.file(skillPath).text();
        // Use a path relative to cwd to avoid leaking absolute filesystem paths
        const relativePath = skillPath.startsWith(cwd)
          ? skillPath.slice(cwd.length).replace(/^\//, "")
          : skillPath;
        skillContents.push(`### ${relativePath}\n\n${content}`);
      } catch {
        // skip unreadable files
      }
    }
  }

  if (skillContents.length === 0) return "";

  return "## Project Skills\n\n" + skillContents.join("\n\n---\n\n");
}
