import { join } from "node:path";
import type {
  AdversaryConfig,
  SkillResult,
  ToolchainDiscovery,
  VerifyFinding,
} from "../types/index.js";
import { runStep } from "../runner/index.js";
import { ensureDir, writeText, writeJsonFile } from "../utils/fs.js";
import { interpolate } from "../utils/slugify.js";
import { loadSkillTemplate } from "../prompts/skills/loader.js";
import { validateRawFindings } from "./findings.js";
import { extractJson } from "../utils/json.js";

interface CommandSpec {
  label: string;
  command: string;
  commandType: string;
  timeoutMs: number;
}

/**
 * Build the list of deterministic command specs from discovery.
 * Null/empty commands are skipped.
 */
export function buildCommandSpecs(
  discovery: ToolchainDiscovery,
  config: AdversaryConfig
): CommandSpec[] {
  const specs: CommandSpec[] = [];

  if (discovery.testCommand) {
    specs.push({
      label: "det-test",
      command: discovery.testCommand,
      commandType: "test",
      timeoutMs: config.testTimeoutMs,
    });
  }

  if (discovery.buildCommand) {
    specs.push({
      label: "det-build",
      command: discovery.buildCommand,
      commandType: "build",
      timeoutMs: config.verifyTimeoutMs,
    });
  }

  for (let i = 0; i < discovery.lintCommands.length; i++) {
    const cmd = discovery.lintCommands[i];
    if (!cmd) continue;
    const label = discovery.lintCommands.length === 1 ? "det-lint" : `det-lint-${i}`;
    specs.push({
      label,
      command: cmd,
      commandType: "lint",
      timeoutMs: config.verifyTimeoutMs,
    });
  }

  for (let i = 0; i < discovery.typeCheckCommands.length; i++) {
    const cmd = discovery.typeCheckCommands[i];
    if (!cmd) continue;
    const label = discovery.typeCheckCommands.length === 1 ? "det-typecheck" : `det-typecheck-${i}`;
    specs.push({
      label,
      command: cmd,
      commandType: "typecheck",
      timeoutMs: config.verifyTimeoutMs,
    });
  }

  return specs;
}

/**
 * Run all deterministic commands (test, build, lint, typecheck) in parallel.
 * Each command is spawned via sh -c to handle shell operators.
 * Returns one SkillResult per command.
 */
export async function runDeterministicCommands(options: {
  discovery: ToolchainDiscovery;
  cwd: string;
  skillsDir: string;
  config: AdversaryConfig;
  scopedFiles: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillResult[]> {
  const { discovery, cwd, skillsDir, config, scopedFiles, env } = options;

  const specs = buildCommandSpecs(discovery, config);

  if (specs.length === 0) {
    return [];
  }

  const promises = specs.map((spec) =>
    runSingleDeterministicCommand({ spec, cwd, skillsDir, config, scopedFiles, env })
  );

  const settled = await Promise.allSettled(promises);

  return settled.map((r, i) => {
    const spec = specs[i]!;
    if (r.status === "fulfilled") {
      return r.value;
    } else {
      process.stderr.write(`  Warning: deterministic command "${spec.label}" threw: ${r.reason}\n`);
      return {
        skill: spec.label,
        exitCode: 1,
        durationMs: 0,
        findings: [],
        status: "error" as const,
      };
    }
  });
}

async function runSingleDeterministicCommand(options: {
  spec: CommandSpec;
  cwd: string;
  skillsDir: string;
  config: AdversaryConfig;
  scopedFiles: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillResult> {
  const { spec, cwd, skillsDir, config, scopedFiles, env } = options;

  await ensureDir(skillsDir);

  const stdoutPath = join(skillsDir, `${spec.label}.stdout.log`);
  const stderrPath = join(skillsDir, `${spec.label}.stderr.log`);

  // Spawn via ["sh", "-c", command] to correctly handle shell operators (&&, |, ;, etc.).
  // Using rawArgv bypasses parseCommand entirely, which would misparse quoted strings
  // embedded in the command or split compound commands incorrectly.
  const stepResult = await runStep({
    command: spec.command,
    rawArgv: ["sh", "-c", spec.command],
    cwd,
    stdoutPath,
    stderrPath,
    timeoutMs: spec.timeoutMs,
    label: spec.label,
    env,
  });

  if (stepResult.timedOut) {
    const finding: VerifyFinding = {
      title: `${spec.commandType} command timed out`,
      severity: 8,
      description: `The ${spec.commandType} command timed out after ${Math.round(spec.timeoutMs / 1000)}s: \`${spec.command}\``,
      sources: [spec.label],
    };
    await writeJsonFile(join(skillsDir, `${spec.label}.output.json`), {
      skill: spec.label,
      status: "timeout",
      findings: [finding],
    });
    process.stdout.write(
      `  [verify] ${spec.label} TIMED OUT (1 finding)\n`
    );
    return {
      skill: spec.label,
      exitCode: stepResult.exitCode,
      durationMs: stepResult.durationMs,
      findings: [finding],
      status: "timeout",
    };
  }

  if (stepResult.exitCode === 0) {
    await writeJsonFile(join(skillsDir, `${spec.label}.output.json`), {
      skill: spec.label,
      status: "completed",
      findings: [],
    });
    process.stdout.write(
      `  [verify] ${spec.label} completed (${Math.round(stepResult.durationMs / 1000)}s, 0 findings, status: completed)\n`
    );
    return {
      skill: spec.label,
      exitCode: 0,
      durationMs: stepResult.durationMs,
      findings: [],
      status: "completed",
    };
  }

  // Non-zero exit — analyze with LLM
  const stdoutText = await Bun.file(stdoutPath).text();
  const stderrText = await Bun.file(stderrPath).text();
  const combined = stdoutText + stderrText;

  const findings = await analyzeFailure({
    commandType: spec.commandType,
    command: spec.command,
    output: combined,
    scopedFiles,
    skillsDir,
    label: spec.label,
    config,
    cwd,
    env,
  });

  await writeJsonFile(join(skillsDir, `${spec.label}.output.json`), {
    skill: spec.label,
    status: "completed",
    findings,
  });

  const durationSecs = Math.round(stepResult.durationMs / 1000);
  process.stdout.write(
    `  [verify] ${spec.label} completed (${durationSecs}s, ${findings.length} finding${findings.length !== 1 ? "s" : ""}, status: completed)\n`
  );

  return {
    skill: spec.label,
    exitCode: stepResult.exitCode,
    durationMs: stepResult.durationMs,
    findings,
    status: "completed",
  };
}

const OUTPUT_TAIL_LINES = 500;

/**
 * Analyze a failed command's output via the command-analyzer LLM skill.
 */
async function analyzeFailure(options: {
  commandType: string;
  command: string;
  output: string;
  scopedFiles: string;
  skillsDir: string;
  label: string;
  config: AdversaryConfig;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifyFinding[]> {
  const { commandType, command, output, scopedFiles, skillsDir, label, config, cwd, env } = options;

  // Truncate output to tail lines
  const lines = output.split("\n");
  const tail = lines.slice(-OUTPUT_TAIL_LINES).join("\n");

  let template: string;
  try {
    template = await loadSkillTemplate("command-analyzer");
  } catch (e) {
    process.stderr.write(`  Warning: failed to load command-analyzer template: ${e}\n`);
    return fallbackFinding(commandType, command, label);
  }

  // Interpolate template variables
  let prompt = template;
  const vars: Record<string, string> = {
    commandType,
    command,
    output: tail,
    scopedFiles,
  };
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), () => value);
  }

  const promptPath = join(skillsDir, `${label}.analyzer.prompt.md`);
  await writeText(promptPath, prompt);

  const analyzerVars: Record<string, string> = { promptFile: promptPath };
  const analyzerCommand = interpolate(config.verifyCommandTemplate, analyzerVars);
  const analyzerStdoutPath = join(skillsDir, `${label}.analyzer.stdout.log`);
  const analyzerStderrPath = join(skillsDir, `${label}.analyzer.stderr.log`);

  let analyzerResult;
  try {
    analyzerResult = await runStep({
      command: analyzerCommand,
      cwd,
      stdoutPath: analyzerStdoutPath,
      stderrPath: analyzerStderrPath,
      timeoutMs: config.verifyTimeoutMs,
      label: `${label}-analyzer`,
      env,
    });
  } catch (e) {
    process.stderr.write(`  Warning: command-analyzer step threw for "${label}": ${e}\n`);
    return fallbackFinding(commandType, command, label);
  }

  if (!analyzerResult.success && !analyzerResult.timedOut) {
    process.stderr.write(
      `  Warning: command-analyzer exited non-zero (${analyzerResult.exitCode}) for "${label}" — using fallback finding\n`
    );
    return fallbackFinding(commandType, command, label);
  }

  const analyzerStdout = await Bun.file(analyzerStdoutPath).text();

  try {
    const parsed = extractJson(analyzerStdout) as Record<string, unknown>;
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = validateRawFindings(rawFindings, label);
    if (findings.length > 0) {
      return findings;
    }
    // Analyzer returned no findings despite non-zero exit — use fallback
    return fallbackFinding(commandType, command, label);
  } catch {
    process.stderr.write(
      `  Warning: could not parse command-analyzer output for "${label}" — using fallback finding\n`
    );
    return fallbackFinding(commandType, command, label);
  }
}

function fallbackFinding(commandType: string, command: string, label: string): VerifyFinding[] {
  return [
    {
      title: `${commandType} command failed`,
      severity: commandType === "test" || commandType === "build" ? 8 : 6,
      description: `The ${commandType} command exited with a non-zero exit code: \`${command}\``,
      sources: [label],
    },
  ];
}
