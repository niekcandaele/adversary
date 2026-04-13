import { join } from "node:path";
import type {
  AdversaryConfig,
  CustomVerificationStep,
  DeterministicStepKind,
  SkillResult,
  ToolchainDiscovery,
  VerifyFinding,
} from "../types/index.js";
import { runStep } from "../runner/index.js";
import { writeJsonFile, writeText } from "../utils/fs.js";
import { interpolate } from "../utils/slugify.js";
import { loadSkillTemplate } from "../prompts/skills/loader.js";
import { validateRawFindings } from "./findings.js";
import { extractJson } from "../utils/json.js";
import { ensureStepDir, writeStepContextFile, writeTruncatedHelperArtifacts } from "./steps.js";

interface PlannedDeterministicStep {
  name: string;
  label: string;
  kind: DeterministicStepKind;
  commandType: DeterministicStepKind;
  command: string;
  timeoutMs: number;
  source: "configured" | "discovered";
}

const DETERMINISTIC_KIND_ORDER: DeterministicStepKind[] = ["test", "build", "lint", "typecheck"];

export function buildCommandSpecs(
  discovery: ToolchainDiscovery,
  config: AdversaryConfig
): PlannedDeterministicStep[] {
  return buildDeterministicSteps(discovery, config);
}

export function buildDeterministicSteps(
  discovery: ToolchainDiscovery,
  config: AdversaryConfig
): PlannedDeterministicStep[] {
  const configuredByKind = new Map<DeterministicStepKind, CustomVerificationStep[]>();
  for (const kind of DETERMINISTIC_KIND_ORDER) {
    configuredByKind.set(kind, []);
  }

  for (const step of config.customVerificationSteps) {
    if (step.phase !== "deterministic" || !step.kind) continue;
    configuredByKind.get(step.kind)?.push(step);
  }

  const planned: PlannedDeterministicStep[] = [];
  for (const kind of DETERMINISTIC_KIND_ORDER) {
    const configured = configuredByKind.get(kind) ?? [];
    if (configured.length > 0) {
      planned.push(...configured.map((step) => ({
        name: step.name,
        label: step.name,
        kind,
        commandType: kind,
        command: step.commandTemplate,
        timeoutMs: step.timeoutMs ?? (kind === "test" ? config.testTimeoutMs : config.verifyTimeoutMs),
        source: "configured" as const,
      })));
      continue;
    }

    planned.push(...buildDiscoveredFallbackSteps(kind, discovery, config));
  }

  return planned;
}

function buildDiscoveredFallbackSteps(
  kind: DeterministicStepKind,
  discovery: ToolchainDiscovery,
  config: AdversaryConfig
): PlannedDeterministicStep[] {
  if (kind === "test") {
    return discovery.testCommand
      ? [{
          name: "discovered-test",
          label: "discovered-test",
          kind,
          commandType: kind,
          command: discovery.testCommand,
          timeoutMs: config.testTimeoutMs,
          source: "discovered",
        }]
      : [];
  }

  if (kind === "build") {
    return discovery.buildCommand
      ? [{
          name: "discovered-build",
          label: "discovered-build",
          kind,
          commandType: kind,
          command: discovery.buildCommand,
          timeoutMs: config.verifyTimeoutMs,
          source: "discovered",
        }]
      : [];
  }

  const commands = kind === "lint" ? discovery.lintCommands : discovery.typeCheckCommands;
  return commands
    .filter((command): command is string => Boolean(command))
    .map((command, index) => {
      const name = commands.filter(Boolean).length === 1
        ? `discovered-${kind}`
        : `discovered-${kind}-${index}`;
      return {
        name,
        label: name,
        kind,
        commandType: kind,
        command,
        timeoutMs: config.verifyTimeoutMs,
        source: "discovered" as const,
      };
    });
}

export async function runDeterministicCommands(options: {
  discovery: ToolchainDiscovery;
  cwd: string;
  verifyDir?: string;
  skillsDir?: string;
  config: AdversaryConfig;
  branchContextFile?: string;
  planFile?: string;
  planContent?: string;
  scopedFiles?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillResult[]> {
  const verifyDir = options.verifyDir ?? join(options.skillsDir ?? join(options.cwd, "verify"), "..");
  const branchContextFile = options.branchContextFile ?? join(verifyDir, "branch-context.txt");
  const planFile = options.planFile ?? join(verifyDir, "plan.txt");
  const planContent = options.planContent ?? "";
  const { discovery, cwd, config, env } = options;
  const steps = buildDeterministicSteps(discovery, config);
  const results: SkillResult[] = [];

  for (const step of steps) {
    results.push(await runSingleDeterministicStep({
      step,
      cwd,
      verifyDir,
      config,
      branchContextFile,
      planFile,
      planContent,
      env,
    }));
  }

  return results;
}

async function runSingleDeterministicStep(options: {
  step: PlannedDeterministicStep;
  cwd: string;
  verifyDir: string;
  config: AdversaryConfig;
  branchContextFile: string;
  planFile: string;
  planContent: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillResult> {
  const { step, cwd, verifyDir, config, branchContextFile, planFile, planContent, env } = options;
  const stepDir = await ensureStepDir(verifyDir, step.name);
  const contextFile = await writeStepContextFile({
    stepDir,
    branchContextFile,
    planFile,
    planContent,
    extraSections: [
      { title: "Deterministic step", body: `Name: ${step.name}\nKind: ${step.kind}\nSource: ${step.source}` },
      { title: "Command", body: step.command },
    ],
  });

  const command = step.source === "configured"
    ? interpolate(step.command, { cwd, contextFile, planFile })
    : step.command;

  const stdoutPath = join(stepDir, "stdout.log");
  const stderrPath = join(stepDir, "stderr.log");

  const stepResult = await runStep({
    command,
    rawArgv: ["sh", "-c", command],
    cwd,
    stdoutPath,
    stderrPath,
    timeoutMs: step.timeoutMs,
    label: step.name,
    env,
  });

  const stdoutText = await Bun.file(stdoutPath).text();
  const stderrText = await Bun.file(stderrPath).text();
  const helperArtifacts = await writeTruncatedHelperArtifacts({ stepDir, stdoutText, stderrText });

  let findings: VerifyFinding[] = [];
  let status: SkillResult["status"] = "completed";

  if (stepResult.timedOut) {
    findings = [metaFinding({
      title: `${step.kind} step timed out`,
      description: `Deterministic ${step.kind} step \`${step.name}\` timed out after ${Math.round(step.timeoutMs / 1000)}s while running \`${command}\`. See artifacts in ${stepDir}.`,
      source: step.name,
    })];
    status = "timeout";
  } else if (stepResult.exitCode !== 0) {
    findings = await analyzeDeterministicFailure({
      step,
      command,
      stepDir,
      helperArtifacts,
      stdoutPath,
      stderrPath,
      config,
      cwd,
      contextFile,
      env,
    });
  }

  const output = {
    skill: step.name,
    status,
    findings,
    step: {
      name: step.name,
      kind: step.kind,
      source: step.source,
      command,
      exitCode: stepResult.exitCode,
      timedOut: stepResult.timedOut,
      durationMs: stepResult.durationMs,
      artifactDir: stepDir,
    },
  };
  await writeJsonFile(join(stepDir, "output.json"), output);

  return {
    skill: step.name,
    exitCode: stepResult.exitCode,
    durationMs: stepResult.durationMs,
    findings,
    status,
    artifactDir: stepDir,
  };
}

async function analyzeDeterministicFailure(options: {
  step: PlannedDeterministicStep;
  command: string;
  stepDir: string;
  helperArtifacts: { stdoutTruncatedPath: string; stderrTruncatedPath: string };
  stdoutPath: string;
  stderrPath: string;
  config: AdversaryConfig;
  cwd: string;
  contextFile: string;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifyFinding[]> {
  const { step, command, stepDir, helperArtifacts, stdoutPath, stderrPath, config, cwd, contextFile, env } = options;

  let template: string;
  try {
    template = await loadSkillTemplate("command-analyzer");
  } catch {
    return [metaFinding({
      title: `${step.kind} step failed`,
      description: `Deterministic ${step.kind} step \`${step.name}\` failed and the command analyzer prompt could not be loaded. Command: \`${command}\`.`,
      source: step.name,
    })];
  }

  let prompt = template;
  for (const [key, value] of Object.entries({
    stepName: step.name,
    commandType: step.kind,
    command,
    contextFile,
    stdoutPath,
    stderrPath,
    stdoutSnippetPath: helperArtifacts.stdoutTruncatedPath,
    stderrSnippetPath: helperArtifacts.stderrTruncatedPath,
  })) {
    prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), () => value);
  }

  const promptPath = join(stepDir, "analysis.prompt.md");
  await writeText(promptPath, prompt);

  const analyzerCommand = interpolate(config.verifyCommandTemplate, { promptFile: promptPath });
  const analysisStdoutPath = join(stepDir, "analysis.stdout.log");
  const analysisStderrPath = join(stepDir, "analysis.stderr.log");

  try {
    const analyzerResult = await runStep({
      command: analyzerCommand,
      cwd,
      stdoutPath: analysisStdoutPath,
      stderrPath: analysisStderrPath,
      timeoutMs: config.verifyTimeoutMs,
      label: `${step.name}-analysis`,
      env,
    });

    if (analyzerResult.timedOut || analyzerResult.exitCode !== 0) {
      return [metaFinding({
        title: `${step.kind} step failed`,
        description: `Deterministic ${step.kind} step \`${step.name}\` failed and the command analyzer also failed. Command: \`${command}\`.`,
        source: step.name,
      })];
    }

    const analyzerStdout = await Bun.file(analysisStdoutPath).text();
    const parsed = extractJson(analyzerStdout) as Record<string, unknown>;
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = validateRawFindings(rawFindings, step.name).map((finding) => ({
      ...finding,
      severity: 8,
      sources: [step.name],
    }));

    return findings.length > 0
      ? findings
      : [metaFinding({
          title: `${step.kind} step failed`,
          description: `Deterministic ${step.kind} step \`${step.name}\` failed with command \`${command}\`. Analyzer returned no findings; inspect ${stepDir}.`,
          source: step.name,
        })];
  } catch {
    return [metaFinding({
      title: `${step.kind} step failed`,
      description: `Deterministic ${step.kind} step \`${step.name}\` failed and its analyzer output could not be processed. Command: \`${command}\`.`,
      source: step.name,
    })];
  }
}

function metaFinding(options: { title: string; description: string; source: string }): VerifyFinding {
  return {
    title: options.title,
    severity: 8,
    description: options.description,
    sources: [options.source],
  };
}
