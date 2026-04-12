import { join } from "node:path";
import type {
  AdversaryConfig,
  SkillResult,
  VerifyFinding,
  VerifyReport,
  VerifyScope,
  ToolchainDiscovery,
  BuiltinSkillName,
} from "../types/index.js";
import { runStep } from "../runner/index.js";
import { ensureDir, writeText, writeJsonFile } from "../utils/fs.js";
import { interpolate } from "../utils/slugify.js";
import { loadSkillTemplate } from "../prompts/skills/loader.js";
import {
  buildScopeContext,
  buildScopeMetadata,
  buildDiscoveryContext,
  buildPhase1FindingsSummary,
  buildSkillFindingsJson,
} from "./prompt-builder.js";
import { synthesizeFallback } from "./synthesis-fallback.js";
import { extractJson } from "../utils/json.js";

const BUILTIN_PARALLEL_SKILLS: BuiltinSkillName[] = [
  "reviewer",
  "qa",
  "tester",
  "static-analysis",
  "ux-reviewer",
  "plan-completeness",
];

/**
 * Run the full multi-phase verification pipeline.
 *
 * Note: `config.verifyCommandTemplate` is used for both the discovery step
 * (src/discovery/index.ts) and each verification skill invocation here.
 * This is intentional — discovery and verification both invoke an LLM harness
 * with a generated prompt file. If requirements diverge in the future, these
 * could be split into separate config fields (e.g. `discoveryCommandTemplate`).
 */
export async function runVerification(options: {
  cwd: string;
  turnDir: string;
  scope: VerifyScope;
  discovery: ToolchainDiscovery;
  planContent: string;
  config: AdversaryConfig;
  projectSkills: string;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifyReport> {
  const { cwd, turnDir, scope, discovery, planContent, config, projectSkills, env } = options;

  // Setup directory structure
  const verifyDir = join(turnDir, "verify");
  const skillsDir = join(verifyDir, "skills");
  await ensureDir(skillsDir);

  // Write scope and discovery for reference
  await writeJsonFile(join(verifyDir, "scope.json"), scope);
  await writeJsonFile(join(verifyDir, "discovery.json"), discovery);

  // Build common template variables
  const scopeContext = buildScopeContext(scope);
  const scopeMetadata = buildScopeMetadata(scope);
  const discoveryJson = buildDiscoveryContext(discovery);

  const commonVars = {
    scopeContext,
    scopeMetadata,
    diffStat: scope.diffStat,
    discoveryJson,
    planContent,
    projectSkills,
  };

  // ── Phase 1: Parallel skills ─────────────────────────────────────────────

  const phase1Skills = [...BUILTIN_PARALLEL_SKILLS];
  const customParallel = config.customVerificationSteps.filter((s) => s.phase === "parallel");

  const allParallelNames = [
    ...phase1Skills.map((s) => s as string),
    ...customParallel.map((s) => s.name),
  ];
  process.stdout.write(
    `\n  [verify] Running ${allParallelNames.length} skills in parallel: ${allParallelNames.join(", ")}\n`
  );

  const phase1Promises = [
    ...phase1Skills.map((skill) =>
      runSkill({
        skill,
        cwd,
        skillsDir,
        scope,
        discovery,
        commonVars,
        config,
        env,
        timeoutMs: config.verifyTimeoutMs,
      })
    ),
    ...customParallel.map((step) =>
      runCustomStep({
        step,
        cwd,
        skillsDir,
        scope,
        commonVars,
        config,
        env,
      })
    ),
  ];

  const phase1Settled = await Promise.allSettled(phase1Promises);
  const phase1Results: SkillResult[] = phase1Settled.map((r, i) => {
    const skillName =
      i < phase1Skills.length
        ? (phase1Skills[i] as string)
        : (customParallel[i - phase1Skills.length]?.name ?? "custom");

    if (r.status === "fulfilled") {
      return r.value;
    } else {
      process.stderr.write(`  Warning: skill "${skillName}" threw: ${r.reason}\n`);
      return {
        skill: skillName,
        exitCode: 1,
        durationMs: 0,
        findings: [],
        status: "error" as const,
      };
    }
  });

  // ── Phase 2: Exerciser (sequential) ─────────────────────────────────────

  process.stdout.write(`  [verify] Running exerciser...\n`);
  const phase1Summary = buildPhase1FindingsSummary(phase1Results);

  const exerciserResult = await runSkill({
    skill: "exerciser",
    cwd,
    skillsDir,
    scope,
    discovery,
    commonVars: { ...commonVars, phase1Findings: phase1Summary },
    config,
    env,
    timeoutMs: config.verifyTimeoutMs,
  });

  // Run custom sequential steps — they receive phase1Findings in their vars
  const customSequential = config.customVerificationSteps.filter((s) => s.phase === "sequential");
  const customSequentialResults: SkillResult[] = [];
  for (const step of customSequential) {
    process.stdout.write(`  [verify] Running custom step: ${step.name}...\n`);
    const result = await runCustomStep({
      step,
      cwd,
      skillsDir,
      scope,
      commonVars: { ...commonVars, phase1Findings: phase1Summary },
      config,
      env,
    });
    customSequentialResults.push(result);
  }

  const allResults = [...phase1Results, exerciserResult, ...customSequentialResults];

  // ── Phase 3: Synthesis ────────────────────────────────────────────────────

  process.stdout.write(`  [verify] Synthesizing findings...\n`);
  const report = await runSynthesis({
    cwd,
    verifyDir,
    allResults,
    commonVars,
    config,
    env,
  });

  // Write final output
  await writeJsonFile(join(turnDir, "verify.json"), report);

  return report;
}

/**
 * Run a single built-in skill via the harness.
 */
async function runSkill(options: {
  skill: string;
  cwd: string;
  skillsDir: string;
  scope: VerifyScope;
  discovery: ToolchainDiscovery;
  commonVars: Record<string, string>;
  config: AdversaryConfig;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<SkillResult> {
  const { skill, cwd, skillsDir, commonVars, config, env, timeoutMs } = options;

  const override = config.skillOverrides[skill];
  let template: string;
  try {
    template = await loadSkillTemplate(skill, override);
  } catch (e) {
    process.stderr.write(`  Warning: failed to load skill template "${skill}": ${e}\n`);
    return {
      skill,
      exitCode: 1,
      durationMs: 0,
      findings: [],
      status: "error",
    };
  }

  // Interpolate all variables. Use a function replacement to prevent `$`
  // in user-derived values being interpreted as special replacement patterns
  // (e.g. $&, $', $$) by String.replace().
  let prompt = template;
  for (const [key, value] of Object.entries(commonVars)) {
    const safeValue = value;
    prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), () => safeValue);
  }

  // Warn if any {word} placeholders remain after interpolation — this indicates
  // a template references a variable that was not provided.
  const remaining = prompt.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g);
  if (remaining) {
    const unique = [...new Set(remaining)].join(", ");
    process.stderr.write(
      `  Warning: skill "${skill}" prompt has unreplaced placeholders after interpolation: ${unique}\n`
    );
  }

  // Write prompt file
  const promptPath = join(skillsDir, `${skill}.prompt.md`);
  await writeText(promptPath, prompt);

  // Run harness
  const vars: Record<string, string> = { promptFile: promptPath };
  const command = interpolate(config.verifyCommandTemplate, vars);
  const stdoutPath = join(skillsDir, `${skill}.stdout.log`);
  const stderrPath = join(skillsDir, `${skill}.stderr.log`);

  const stepResult = await runStep({
    command,
    cwd,
    stdoutPath,
    stderrPath,
    timeoutMs,
    label: skill,
    env,
  });

  // Parse findings from stdout
  const stdoutText = await Bun.file(stdoutPath).text();
  const { findings, status } = parseSkillOutput(stdoutText, skill, stepResult.timedOut);

  // Write parsed output
  await writeJsonFile(join(skillsDir, `${skill}.output.json`), { skill, status, findings });

  const durationSecs = Math.round(stepResult.durationMs / 1000);
  process.stdout.write(
    `  [verify] ${skill} completed (${durationSecs}s, ${findings.length} finding${findings.length !== 1 ? "s" : ""}, status: ${status})\n`
  );

  return {
    skill,
    exitCode: stepResult.exitCode,
    durationMs: stepResult.durationMs,
    findings,
    status,
  };
}

/**
 * Run a custom verification step via its command template.
 *
 * Note: custom steps do not receive a generated prompt file. The {promptFile}
 * variable is NOT available in custom step commandTemplates — use the other
 * template variables ({scopeContext}, {discoveryJson}, etc.) instead.
 */
async function runCustomStep(options: {
  step: { name: string; commandTemplate: string; phase: string; timeoutMs?: number };
  cwd: string;
  skillsDir: string;
  scope: VerifyScope;
  commonVars: Record<string, string>;
  config: AdversaryConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillResult> {
  const { step, cwd, skillsDir, commonVars, config, env } = options;
  const timeoutMs = step.timeoutMs ?? config.verifyTimeoutMs;

  // Warn at runtime if the custom step template references {promptFile} — custom steps
  // do not receive a generated prompt file; only built-in skills use {promptFile}.
  if (step.commandTemplate.includes("{promptFile}")) {
    process.stderr.write(
      `  Warning: custom step "${step.name}" commandTemplate contains {promptFile}, which is not available for custom steps. ` +
        `Use {contextFile} to pass the full context, or other scalar template variables instead.\n`
    );
  }

  // Build safe scalar vars for template interpolation.
  // Multi-line vars (scopeContext, planContent, etc.) must NOT be interpolated directly
  // into a shell command template — they break shell parsing and enable injection.
  // Instead, write all context to a file and expose it via {contextFile}.
  const contextFilePath = join(skillsDir, `${step.name}.context.txt`);
  const contextContent = [
    `## Scope Context\n\n${commonVars.scopeContext ?? ""}`,
    `## Scope Metadata\n\n${commonVars.scopeMetadata ?? ""}`,
    `## Diff Stat\n\n${commonVars.diffStat ?? ""}`,
    `## Discovery\n\n${commonVars.discoveryJson ?? ""}`,
    `## Plan\n\n${commonVars.planContent ?? ""}`,
    ...(commonVars.phase1Findings ? [`## Phase 1 Findings\n\n${commonVars.phase1Findings}`] : []),
    ...(commonVars.projectSkills ? [`## Project Skills\n\n${commonVars.projectSkills}`] : []),
  ].join("\n\n---\n\n");
  await writeText(contextFilePath, contextContent);

  // Only safe scalar vars (path-like) are interpolated into the command.
  // The contextFile path is safe to inline — it is a filesystem path we control.
  const vars: Record<string, string> = { contextFile: contextFilePath };

  const command = interpolate(step.commandTemplate, vars);
  const stdoutPath = join(skillsDir, `${step.name}.stdout.log`);
  const stderrPath = join(skillsDir, `${step.name}.stderr.log`);

  const stepResult = await runStep({
    command,
    cwd,
    stdoutPath,
    stderrPath,
    timeoutMs,
    label: step.name,
    env,
  });

  const stdoutText = await Bun.file(stdoutPath).text();
  const { findings, status } = parseSkillOutput(stdoutText, step.name, stepResult.timedOut);

  await writeJsonFile(join(skillsDir, `${step.name}.output.json`), { skill: step.name, status, findings });

  return {
    skill: step.name,
    exitCode: stepResult.exitCode,
    durationMs: stepResult.durationMs,
    findings,
    status,
  };
}

/**
 * Parse skill output JSON from stdout.
 */
function parseSkillOutput(
  stdout: string,
  skillName: string,
  timedOut: boolean
): { findings: VerifyFinding[]; status: SkillResult["status"] } {
  if (timedOut) {
    return { findings: [], status: "timeout" };
  }

  try {
    const parsed = extractJson(stdout) as Record<string, unknown>;
    const VALID_STATUSES: ReadonlySet<string> = new Set(["completed", "blocked", "error", "timeout"]);
    const rawStatus = typeof parsed.status === "string" && VALID_STATUSES.has(parsed.status)
      ? (parsed.status as SkillResult["status"])
      : "completed";
    const status = rawStatus;
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings: VerifyFinding[] = [];

    for (let i = 0; i < rawFindings.length; i++) {
      const f = rawFindings[i] as Record<string, unknown>;
      if (typeof f !== "object" || f === null) {
        process.stderr.write(
          `  Warning: skill "${skillName}" findings[${i}] is not an object — skipping\n`
        );
        continue;
      }
      if (typeof f.title !== "string") {
        process.stderr.write(
          `  Warning: skill "${skillName}" findings[${i}].title must be a string — skipping\n`
        );
        continue;
      }
      if (typeof f.severity !== "number") {
        process.stderr.write(
          `  Warning: skill "${skillName}" findings[${i}].severity must be a number — skipping\n`
        );
        continue;
      }
      if (typeof f.description !== "string") {
        process.stderr.write(
          `  Warning: skill "${skillName}" findings[${i}].description must be a string — skipping\n`
        );
        continue;
      }
      // Construct from explicit validated fields only — do not spread arbitrary LLM keys
      const rawLocation = f.location as Record<string, unknown> | undefined;
      const location: VerifyFinding["location"] =
        rawLocation &&
        typeof rawLocation === "object" &&
        typeof rawLocation.path === "string"
          ? {
              path: rawLocation.path,
              ...(typeof rawLocation.line === "number" ? { line: rawLocation.line } : {}),
            }
          : undefined;
      findings.push({
        title: f.title as string,
        severity: f.severity as number,
        description: f.description as string,
        sources: Array.isArray(f.sources)
          ? (f.sources as unknown[]).filter((s): s is string => typeof s === "string")
          : [skillName],
        ...(location ? { location } : {}),
      });
    }

    return { findings, status };
  } catch {
    process.stderr.write(
      `  Warning: could not parse output from skill "${skillName}" — treating as error\n`
    );
    return { findings: [], status: "error" };
  }
}

/**
 * Run the synthesis step to deduplicate and merge all findings.
 */
async function runSynthesis(options: {
  cwd: string;
  verifyDir: string;
  allResults: SkillResult[];
  commonVars: Record<string, string>;
  config: AdversaryConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifyReport> {
  const { cwd, verifyDir, allResults, commonVars, config, env } = options;

  const skillFindingsJson = buildSkillFindingsJson(allResults);

  let template: string;
  try {
    template = await loadSkillTemplate("synthesis", config.skillOverrides?.synthesis);
  } catch (e) {
    process.stderr.write(`  Warning: failed to load synthesis template: ${e}\n`);
    return synthesizeFallback(allResults);
  }

  // Interpolate {skillFindings} and all commonVars into the template.
  // Use function replacement to prevent `$` in values being misinterpreted as
  // special replacement patterns (e.g. $&, $', $$).
  let prompt = template;
  for (const [key, value] of Object.entries({ ...commonVars, skillFindings: skillFindingsJson })) {
    prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), () => value);
  }
  const promptPath = join(verifyDir, "synthesis.prompt.md");
  await writeText(promptPath, prompt);

  const vars: Record<string, string> = { promptFile: promptPath };
  const command = interpolate(config.verifyCommandTemplate, vars);
  const stdoutPath = join(verifyDir, "synthesis.stdout.log");
  const stderrPath = join(verifyDir, "synthesis.stderr.log");

  const stepResult = await runStep({
    command,
    cwd,
    stdoutPath,
    stderrPath,
    timeoutMs: config.verifyTimeoutMs,
    label: "synthesis",
    env,
  });

  const stdoutText = await Bun.file(stdoutPath).text();

  try {
    const parsed = extractJson(stdoutText) as Record<string, unknown>;

    // Validate it looks like a VerifyReport
    if (
      parsed.schemaVersion === 1 &&
      ["ok", "blocked", "error"].includes(parsed.status as string) &&
      Array.isArray(parsed.findings)
    ) {
      // Validate individual findings (skip malformed ones with a warning)
      const validFindings: VerifyFinding[] = [];
      const rawFindings = parsed.findings as unknown[];
      for (let i = 0; i < rawFindings.length; i++) {
        const f = rawFindings[i] as Record<string, unknown>;
        if (
          typeof f === "object" &&
          f !== null &&
          typeof f.title === "string" &&
          typeof f.severity === "number" &&
          typeof f.description === "string"
        ) {
          // Construct from explicit validated fields only — do not spread arbitrary LLM keys
          const sources = Array.isArray(f.sources)
            ? (f.sources as unknown[]).filter((s): s is string => typeof s === "string")
            : ["synthesis"];
          const rawLoc = f.location as Record<string, unknown> | undefined;
          const loc: VerifyFinding["location"] =
            rawLoc &&
            typeof rawLoc === "object" &&
            typeof rawLoc.path === "string"
              ? {
                  path: rawLoc.path,
                  ...(typeof rawLoc.line === "number" ? { line: rawLoc.line } : {}),
                }
              : undefined;
          validFindings.push({
            title: f.title as string,
            severity: f.severity as number,
            description: f.description as string,
            sources,
            ...(loc ? { location: loc } : {}),
          });
        } else {
          process.stderr.write(
            `  Warning: synthesis findings[${i}] is malformed — skipping\n`
          );
        }
      }

      const report: VerifyReport = {
        schemaVersion: 1,
        status: parsed.status as VerifyReport["status"],
        findings: validFindings,
      };

      await writeJsonFile(join(verifyDir, "synthesis.output.json"), report);
      return report;
    }
  } catch {
    // fall through to fallback
  }

  process.stderr.write(
    `  Warning: synthesis output parse failed (exit ${stepResult.exitCode}), using deterministic fallback\n`
  );
  const fallback = synthesizeFallback(allResults);
  await writeJsonFile(join(verifyDir, "synthesis.output.json"), fallback);
  return fallback;
}
