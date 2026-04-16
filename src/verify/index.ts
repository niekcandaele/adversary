import { join } from "node:path";
import type {
  AdversaryConfig,
  SkillResult,
  VerifyFinding,
  VerifyReport,
  VerifyScope,
  ToolchainDiscovery,
  BuiltinSkillName,
  CustomVerificationStep,
} from "../types/index.js";
import { runStep } from "../runner/index.js";
import { ensureDir, writeText, writeJsonFile } from "../utils/fs.js";
import { interpolate } from "../utils/slugify.js";
import { getHeadSha } from "../git/index.js";
import { loadSkillTemplate } from "../prompts/skills/loader.js";
import {
  buildScopeContext,
  buildScopeMetadata,
  buildDiscoveryContext,
  buildPhase1FindingsSummary,
} from "./prompt-builder.js";
import { synthesizeFallback } from "./synthesis-fallback.js";
import { extractJson } from "../utils/json.js";
import { runDeterministicCommands } from "./deterministic.js";
import { validateRawFindings } from "./findings.js";
import {
  ensureStepDir,
  writeBranchContextFile,
  writeStepContextFile,
  writeTruncatedHelperArtifacts,
} from "./steps.js";

const BUILTIN_PARALLEL_SKILLS: BuiltinSkillName[] = [
  "reviewer",
  "qa",
  "ux-reviewer",
  "plan-completeness",
];

export async function runVerification(options: {
  cwd: string;
  turnDir: string;
  scope: VerifyScope;
  discovery: ToolchainDiscovery;
  planContent: string;
  planFile?: string;
  config: AdversaryConfig;
  repoGuidance: string;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifyReport> {
  const { cwd, turnDir, scope, discovery, planContent, config, repoGuidance, env } = options;

  const verifyDir = join(turnDir, "verify");
  await ensureDir(join(verifyDir, "steps"));
  await ensureDir(join(verifyDir, "synthesis"));

  const planFile = options.planFile ?? join(verifyDir, "plan.txt");
  if (!options.planFile) {
    await writeText(planFile, planContent);
  }

  await writeJsonFile(join(verifyDir, "scope.json"), scope);
  await writeJsonFile(join(verifyDir, "discovery.json"), discovery);

  const branchContextFile = await writeBranchContextFile({
    verifyDir,
    planFile,
    scope,
    discovery,
    repoGuidance,
  });

  const commonVars = {
    scopeContext: buildScopeContext(scope),
    scopeMetadata: buildScopeMetadata(scope),
    diffStat: scope.diffStat,
    discoveryJson: buildDiscoveryContext(discovery),
    planContent,
    projectSkills: repoGuidance,
    planFile,
    branchContextFile,
  };

  const parallelReviewSteps = config.customVerificationSteps.filter(
    (step) => step.phase === "parallel-review"
  );

  const allParallelNames = [
    ...BUILTIN_PARALLEL_SKILLS,
    ...parallelReviewSteps.map((step) => step.name),
  ];
  process.stdout.write(
    `\n  [verify] Running parallel-review steps: ${allParallelNames.join(", ")}\n`
  );

  const parallelResults = await Promise.allSettled([
    ...BUILTIN_PARALLEL_SKILLS.map((skill) =>
      runBuiltinStep({
        skill,
        cwd,
        verifyDir,
        commonVars,
        config,
        env,
      })
    ),
    ...parallelReviewSteps.map((step) =>
      runParallelReviewCustomStep({
        step,
        cwd,
        verifyDir,
        branchContextFile,
        planFile,
        planContent,
        config,
        env,
      })
    ),
  ]);

  const phase1Results: SkillResult[] = parallelResults.map((result, index) => {
    const stepName = allParallelNames[index] ?? "unknown-step";
    if (result.status === "fulfilled") {
      return result.value;
    }
    return frameworkThrownStep(stepName, `Verification step threw before producing artifacts: ${String(result.reason)}`);
  });

  process.stdout.write("  [verify] Running deterministic steps sequentially...\n");
  const deterministicResults = await runDeterministicCommands({
    discovery,
    cwd,
    verifyDir,
    config,
    branchContextFile,
    planFile,
    planContent,
    env,
  });

  const preExerciserResults = [...phase1Results, ...deterministicResults];

  process.stdout.write("  [verify] Running exerciser...\n");
  const exerciserResult = await runBuiltinStep({
    skill: "exerciser",
    cwd,
    verifyDir,
    commonVars: {
      ...commonVars,
      phase1Findings: buildPhase1FindingsSummary(preExerciserResults),
    },
    config,
    env,
  });

  const allResults = [...preExerciserResults, exerciserResult];

  process.stdout.write("  [verify] Synthesizing findings...\n");
  const report = await runSynthesis({
    cwd,
    verifyDir,
    planFile,
    branchContextFile,
    allResults,
    config,
    env,
  });

  // Stamp the verify report with the current HEAD SHA so resume can detect
  // if the commit was amended or replaced between verification and resumption.
  try {
    report.commitSha = await getHeadSha(cwd);
  } catch {
    // Non-fatal: if we can't read HEAD, just omit the SHA.
  }
  await writeJsonFile(join(turnDir, "verify.json"), report);
  return report;
}

async function runBuiltinStep(options: {
  skill: string;
  cwd: string;
  verifyDir: string;
  commonVars: Record<string, string>;
  config: AdversaryConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillResult> {
  const { skill, cwd, verifyDir, commonVars, config, env } = options;
  const stepDir = await ensureStepDir(verifyDir, skill);

  let template: string;
  try {
    template = await loadSkillTemplate(skill, config.skillOverrides[skill]);
  } catch (error) {
    const finding = metaFinding(skill, `Failed to load prompt template for verification step \`${skill}\`: ${String(error)}`);
    await writeJsonFile(join(stepDir, "output.json"), { skill, status: "error", findings: [finding] });
    return { skill, exitCode: 1, durationMs: 0, findings: [finding], status: "error", artifactDir: stepDir };
  }

  let prompt = template;
  for (const [key, value] of Object.entries(commonVars)) {
    prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), () => value);
  }

  const promptPath = join(stepDir, "prompt.md");
  await writeText(promptPath, prompt);

  const command = interpolate(config.verifyCommandTemplate, { promptFile: promptPath });
  const stdoutPath = join(stepDir, "stdout.log");
  const stderrPath = join(stepDir, "stderr.log");

  const stepResult = await runStep({
    command,
    cwd,
    stdoutPath,
    stderrPath,
    timeoutMs: config.verifyTimeoutMs,
    label: skill,
    env,
  });

  const stdoutText = await Bun.file(stdoutPath).text();
  const stderrText = await Bun.file(stderrPath).text();
  await writeTruncatedHelperArtifacts({ stepDir, stdoutText, stderrText });

  const parsed = parseBuiltinStepOutput(stdoutText, skill, stepResult.timedOut);
  await writeJsonFile(join(stepDir, "output.json"), {
    skill,
    status: parsed.status,
    findings: parsed.findings,
    step: {
      exitCode: stepResult.exitCode,
      timedOut: stepResult.timedOut,
      durationMs: stepResult.durationMs,
      artifactDir: stepDir,
    },
  });

  return {
    skill,
    exitCode: stepResult.exitCode,
    durationMs: stepResult.durationMs,
    findings: parsed.findings,
    status: parsed.status,
    artifactDir: stepDir,
  };
}

async function runParallelReviewCustomStep(options: {
  step: CustomVerificationStep;
  cwd: string;
  verifyDir: string;
  branchContextFile: string;
  planFile: string;
  planContent: string;
  config: AdversaryConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillResult> {
  const { step, cwd, verifyDir, branchContextFile, planFile, planContent, config, env } = options;
  const stepDir = await ensureStepDir(verifyDir, step.name);
  const contextFile = await writeStepContextFile({
    stepDir,
    branchContextFile,
    planFile,
    planContent,
    extraSections: [{ title: "Custom step", body: `Name: ${step.name}\nPhase: ${step.phase}` }],
  });

  const command = interpolate(step.commandTemplate, { contextFile, planFile, cwd });
  const stdoutPath = join(stepDir, "stdout.log");
  const stderrPath = join(stepDir, "stderr.log");
  const timeoutMs = step.timeoutMs ?? config.verifyTimeoutMs;

  try {
    const stepResult = await runStep({
      command,
      rawArgv: ["sh", "-c", command],
      cwd,
      stdoutPath,
      stderrPath,
      timeoutMs,
      label: step.name,
      env,
    });

    const stdoutText = await Bun.file(stdoutPath).text();
    const stderrText = await Bun.file(stderrPath).text();
    const helperArtifacts = await writeTruncatedHelperArtifacts({ stepDir, stdoutText, stderrText });

    let findings: VerifyFinding[];
    let status: SkillResult["status"];

    if (stepResult.timedOut) {
      findings = [metaFinding(step.name, `Parallel-review step \`${step.name}\` timed out after ${Math.round(timeoutMs / 1000)}s.`)];
      status = "timeout";
    } else if (stdoutText.trim() || stderrText.trim()) {
      findings = await analyzeToolOutput({
        stepName: step.name,
        stepDir,
        branchContextFile,
        stdoutPath,
        stderrPath,
        helperArtifacts,
        exitCode: stepResult.exitCode,
        timedOut: false,
        config,
        cwd,
        env,
      });
      status = stepResult.exitCode === 0 ? "completed" : "error";
    } else if (stepResult.exitCode !== 0) {
      findings = [metaFinding(step.name, `Parallel-review step \`${step.name}\` exited non-zero with no readable output.`)];
      status = "error";
    } else {
      findings = [];
      status = "completed";
    }

    await writeJsonFile(join(stepDir, "output.json"), {
      skill: step.name,
      status,
      findings,
      step: {
        exitCode: stepResult.exitCode,
        timedOut: stepResult.timedOut,
        durationMs: stepResult.durationMs,
        artifactDir: stepDir,
        contextFile,
      },
    });

    return {
      skill: step.name,
      exitCode: stepResult.exitCode,
      durationMs: stepResult.durationMs,
      findings,
      status,
      artifactDir: stepDir,
    };
  } catch (error) {
    const finding = metaFinding(step.name, `Parallel-review step \`${step.name}\` failed to run: ${String(error)}`);
    await writeJsonFile(join(stepDir, "output.json"), { skill: step.name, status: "error", findings: [finding] });
    return { skill: step.name, exitCode: 1, durationMs: 0, findings: [finding], status: "error", artifactDir: stepDir };
  }
}

function parseBuiltinStepOutput(
  stdout: string,
  skillName: string,
  timedOut: boolean
): { findings: VerifyFinding[]; status: SkillResult["status"] } {
  if (timedOut) {
    return {
      findings: [metaFinding(skillName, `Verification step \`${skillName}\` timed out before producing structured output.`)],
      status: "timeout",
    };
  }

  try {
    const parsed = extractJson(stdout) as Record<string, unknown>;
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = validateRawFindings(rawFindings, skillName);
    const rawStatus = parsed.status;
    const status = rawStatus === "error" || rawStatus === "timeout" ? rawStatus : "completed";
    return { findings, status };
  } catch {
    return {
      findings: [metaFinding(skillName, `Verification step \`${skillName}\` produced malformed output. Inspect its step artifacts.`)],
      status: "error",
    };
  }
}

async function analyzeToolOutput(options: {
  stepName: string;
  stepDir: string;
  branchContextFile: string;
  stdoutPath: string;
  stderrPath: string;
  helperArtifacts: { stdoutTruncatedPath: string; stderrTruncatedPath: string };
  exitCode: number;
  timedOut: boolean;
  config: AdversaryConfig;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifyFinding[]> {
  const {
    stepName,
    stepDir,
    branchContextFile,
    stdoutPath,
    stderrPath,
    helperArtifacts,
    exitCode,
    timedOut,
    config,
    cwd,
    env,
  } = options;

  let template: string;
  try {
    template = await loadSkillTemplate("tool-output-analyzer");
  } catch {
    return [metaFinding(stepName, `Parallel-review step \`${stepName}\` produced output, but the tool-output analyzer prompt could not be loaded.`)];
  }

  let prompt = template;
  for (const [key, value] of Object.entries({
    stepName,
    branchContextFile,
    stdoutPath,
    stderrPath,
    stdoutSnippetPath: helperArtifacts.stdoutTruncatedPath,
    stderrSnippetPath: helperArtifacts.stderrTruncatedPath,
    exitCode: String(exitCode),
    timedOut: String(timedOut),
  })) {
    prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), () => value);
  }

  const promptPath = join(stepDir, "analysis.prompt.md");
  await writeText(promptPath, prompt);

  const command = interpolate(config.verifyCommandTemplate, { promptFile: promptPath });
  const stdoutAnalysisPath = join(stepDir, "analysis.stdout.log");
  const stderrAnalysisPath = join(stepDir, "analysis.stderr.log");

  try {
    const analyzerStep = await runStep({
      command,
      cwd,
      stdoutPath: stdoutAnalysisPath,
      stderrPath: stderrAnalysisPath,
      timeoutMs: config.verifyTimeoutMs,
      label: `${stepName}-analysis`,
      env,
    });

    if (analyzerStep.timedOut || analyzerStep.exitCode !== 0) {
      return [metaFinding(stepName, `Parallel-review step \`${stepName}\` produced output, but analysis failed.`)];
    }

    const analysisStdout = await Bun.file(stdoutAnalysisPath).text();
    const parsed = extractJson(analysisStdout) as Record<string, unknown>;
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = validateRawFindings(rawFindings, stepName);

    return findings.length > 0
      ? findings
      : exitCode === 0
        ? []
        : [metaFinding(stepName, `Parallel-review step \`${stepName}\` exited non-zero, but analysis found no structured findings.`)];
  } catch {
    return [metaFinding(stepName, `Parallel-review step \`${stepName}\` produced malformed analysis output.`)];
  }
}

async function runSynthesis(options: {
  cwd: string;
  verifyDir: string;
  planFile: string;
  branchContextFile: string;
  allResults: SkillResult[];
  config: AdversaryConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifyReport> {
  const { cwd, verifyDir, planFile, branchContextFile, allResults, config, env } = options;
  const synthesisDir = join(verifyDir, "synthesis");
  await ensureDir(synthesisDir);

  let template: string;
  try {
    template = await loadSkillTemplate("synthesis", config.skillOverrides?.synthesis);
  } catch {
    const fallback = synthesizeFallback(allResults);
    await writeJsonFile(join(synthesisDir, "output.json"), fallback);
    return fallback;
  }

  const stepsJson = JSON.stringify(
    allResults.map((result) => ({
      skill: result.skill,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      artifactDir: result.artifactDir,
      findings: result.findings,
    })),
    null,
    2
  );

  let prompt = template;
  for (const [key, value] of Object.entries({ stepsJson, planFile, branchContextFile })) {
    prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), () => value);
  }

  const promptPath = join(synthesisDir, "prompt.md");
  await writeText(promptPath, prompt);

  const command = interpolate(config.verifyCommandTemplate, { promptFile: promptPath });
  const stdoutPath = join(synthesisDir, "stdout.log");
  const stderrPath = join(synthesisDir, "stderr.log");

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
    if (parsed.schemaVersion === 1 && ["ok", "error"].includes(String(parsed.status)) && Array.isArray(parsed.findings)) {
      const report: VerifyReport = {
        schemaVersion: 1,
        // A synthesized findings report should not be able to terminate the loop
        // just because the LLM labeled ordinary defects as top-level "error".
        // If synthesis produced structured findings, treat that as a usable
        // verify result and let threshold handling decide whether to continue.
        status: "ok",
        findings: synthesizeFallback([
          {
            skill: "synthesis",
            exitCode: stepResult.exitCode,
            durationMs: stepResult.durationMs,
            findings: validateRawFindings(parsed.findings as unknown[], "synthesis"),
            status: "completed",
            artifactDir: synthesisDir,
          },
        ]).findings,
      };
      await writeJsonFile(join(synthesisDir, "output.json"), report);
      return report;
    }
  } catch {
    // fall through
  }

  const fallback = synthesizeFallback(allResults);
  await writeJsonFile(join(synthesisDir, "output.json"), fallback);
  return fallback;
}

function metaFinding(source: string, description: string): VerifyFinding {
  return {
    title: `${source} verification step failed`,
    severity: 8,
    description,
    sources: [source],
  };
}

function frameworkThrownStep(stepName: string, description: string): SkillResult {
  return {
    skill: stepName,
    exitCode: 1,
    durationMs: 0,
    findings: [metaFinding(stepName, description)],
    status: "error",
  };
}
