import { join } from "node:path";
import type {
  AdversaryConfig,
  VerifyFinding,
  VerifyReport,
  TurnResult,
  RunState,
  TemplateVars,
} from "../types/index.js";
import { runStep } from "../runner/index.js";
import { hasChanges, commitAll } from "../git/index.js";
import {
  generateFirstTurnPrompt,
  generateLaterTurnPrompt,
  generateFindingsFile,
  generateHistoryFile,
} from "../prompts/index.js";
import { generateCommitMessage } from "../summarizer/index.js";
import { writeText, writeJsonFile, readJsonFile, ensureDir } from "../utils/fs.js";
import { interpolate } from "../utils/slugify.js";

export class VerifyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyParseError";
  }
}

/**
 * Split a list of findings into threshold (>= threshold) and below-threshold (< threshold) groups.
 */
export function filterFindings(
  findings: VerifyFinding[],
  threshold: number
): { thresholdFindings: VerifyFinding[]; belowThresholdFindings: VerifyFinding[] } {
  return {
    thresholdFindings: findings.filter((f) => f.severity >= threshold),
    belowThresholdFindings: findings.filter((f) => f.severity < threshold),
  };
}

function buildTemplateVars(
  cwd: string,
  turnDir: string,
  state: RunState,
  turn: number,
  maxTurns: number,
  threshold: number
): TemplateVars {
  return {
    cwd,
    planFile: join(state.runDir, "plan.txt"),
    promptFile: join(turnDir, "implement-input.md"),
    findingsFile: join(turnDir, "current-findings.md"),
    historyFile: join(turnDir, "run-history.md"),
    verifyOutputFile: join(turnDir, "verify.json"),
    threshold: String(threshold),
    turn: String(turn),
    maxTurns: String(maxTurns),
    branch: state.branch,
    baseBranch: state.baseBranch,
  };
}

export async function parseVerifyOutput(verifyJsonPath: string): Promise<VerifyReport> {
  let raw: unknown;
  try {
    raw = await readJsonFile(verifyJsonPath);
  } catch (e) {
    throw new VerifyParseError(`Cannot read verify output at ${verifyJsonPath}: ${e}`);
  }

  const report = raw as Record<string, unknown>;
  if (typeof report !== "object" || report === null) {
    throw new VerifyParseError("Verify output is not a JSON object");
  }
  if (report.schemaVersion !== 1) {
    throw new VerifyParseError(`Unexpected schemaVersion: ${report.schemaVersion}`);
  }
  if (!["ok", "blocked", "error"].includes(report.status as string)) {
    throw new VerifyParseError(`Invalid status: ${report.status}`);
  }
  if (!Array.isArray(report.findings)) {
    throw new VerifyParseError("findings must be an array");
  }

  // Validate each individual finding shape
  for (let i = 0; i < report.findings.length; i++) {
    const f = report.findings[i] as Record<string, unknown>;
    if (typeof f !== "object" || f === null) {
      throw new VerifyParseError(`findings[${i}] is not an object`);
    }
    if (typeof f.title !== "string") {
      throw new VerifyParseError(`findings[${i}].title must be a string`);
    }
    if (typeof f.severity !== "number") {
      throw new VerifyParseError(`findings[${i}].severity must be a number`);
    }
    // Warn if severity is outside the expected 1..10 range (don't reject — external tools may use
    // different ranges; the orchestrator still filters by threshold correctly).
    const sev = f.severity as number;
    if (sev < 1 || sev > 10) {
      process.stderr.write(
        `  Warning: findings[${i}].severity=${sev} is outside expected range 1..10 — proceeding anyway.\n`
      );
    }
    if (typeof f.description !== "string") {
      throw new VerifyParseError(`findings[${i}].description must be a string`);
    }
    if (!Array.isArray(f.sources)) {
      throw new VerifyParseError(`findings[${i}].sources must be an array`);
    }
  }

  return raw as VerifyReport;
}

export async function runLoop(options: {
  cwd: string;
  state: RunState;
  planContent: string;
  maxTurns: number;
  threshold: number;
  config: AdversaryConfig;
  /** Optional env override for spawned subprocesses. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}): Promise<RunState> {
  const { cwd, state, planContent, maxTurns, threshold, config } = options;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const turnDir = join(state.runDir, `turn-${turn}`);
    await ensureDir(turnDir);

    process.stdout.write(`\n${"=".repeat(60)}\n`);
    process.stdout.write(`  Turn ${turn} of ${maxTurns}\n`);
    process.stdout.write(`${"=".repeat(60)}\n`);

    const vars = buildTemplateVars(cwd, turnDir, state, turn, maxTurns, threshold);

    // 1. Generate prompt files
    const priorTurns = state.turns;
    const historyPath = vars.historyFile;
    await generateHistoryFile(priorTurns, historyPath);

    const promptPath = vars.promptFile;
    if (turn === 1) {
      await generateFirstTurnPrompt({
        planContent,
        threshold,
        turn,
        maxTurns,
        branch: state.branch,
        outputPath: promptPath,
      });
    } else {
      const lastTurn = priorTurns[priorTurns.length - 1];
      const thresholdFindings = lastTurn?.thresholdFindings ?? [];
      const historyContent = await Bun.file(historyPath).text();
      await generateLaterTurnPrompt({
        planContent,
        threshold,
        turn,
        maxTurns,
        branch: state.branch,
        thresholdFindings,
        historyContent,
        outputPath: promptPath,
      });
    }

    // Also generate findings file for reference
    const lastPriorTurn = priorTurns.length > 0 ? priorTurns[priorTurns.length - 1] : undefined;
    const priorThreshold = lastPriorTurn?.thresholdFindings ?? [];
    await generateFindingsFile(priorThreshold, threshold, vars.findingsFile);

    // 2. Build implement command
    const implementCommand = interpolate(config.implementCommandTemplate, vars);
    await writeText(join(turnDir, "implement-command.txt"), implementCommand);

    // 3. Run implement
    process.stdout.write(`\n[Turn ${turn}] Running implementer...\n`);
    const implResult = await runStep({
      command: implementCommand,
      cwd,
      stdoutPath: join(turnDir, "implement.stdout.log"),
      stderrPath: join(turnDir, "implement.stderr.log"),
      timeoutMs: config.implementTimeoutMs,
      label: `implement-${turn}`,
      env: options.env,
    });

    if (!implResult.success) {
      const turnResult: TurnResult = {
        turn,
        implementCommand,
        verifyCommand: "",
        implementDurationMs: implResult.durationMs,
        verifyDurationMs: 0,
        repoChanged: false,
        verifyStatus: "error",
        thresholdFindings: [],
        belowThresholdFindings: [],
        outcome: "implement-failure",
      };
      state.turns.push(turnResult);
      await writeTurnSummary(turnDir, turnResult);
      state.outcome = "implement-failure";
      return state;
    }

    // 4. Commit if repo changed
    let commitSha: string | undefined;
    let commitMessage: string | undefined;
    const repoChanged = await hasChanges(cwd);
    if (repoChanged) {
      process.stdout.write(`\n[Turn ${turn}] Generating commit message...\n`);
      try {
        commitMessage = await generateCommitMessage({
          config,
          turnDir,
          branch: state.branch,
          planTitle: state.planTitle,
          turn,
          cwd,
          env: options.env,
        });
      } catch (e) {
        process.stderr.write(`\n[Turn ${turn}] Commit message generation failed: ${e}\n`);
        process.stderr.write(
          `[Turn ${turn}] NOTE: Implement step made changes that remain uncommitted. Inspect the working tree before retrying.\n`
        );
        const turnResult: TurnResult = {
          turn,
          implementCommand,
          verifyCommand: "",
          implementDurationMs: implResult.durationMs,
          verifyDurationMs: 0,
          repoChanged: true,
          // verifyStatus "error" here means verify was never reached, not that it ran and errored.
          // We reuse the existing value since there is no "not-run" variant in VerifyStatus.
          verifyStatus: "error",
          thresholdFindings: [],
          belowThresholdFindings: [],
          outcome: "summarizer-failure",
        };
        state.turns.push(turnResult);
        await writeTurnSummary(turnDir, turnResult);
        state.outcome = "summarizer-failure";
        return state;
      }

      process.stdout.write(`  Committing changes...\n`);
      commitSha = await commitAll(commitMessage, cwd);
      process.stdout.write(`  Committed: ${commitSha.slice(0, 8)}\n`);
    } else {
      process.stdout.write(`\n[Turn ${turn}] No repo changes after implement — skipping commit.\n`);
    }

    // 5. Build verify command
    const verifyCommand = interpolate(config.verifyCommandTemplate, vars);
    await writeText(join(turnDir, "verify-command.txt"), verifyCommand);

    // 6. Run verify
    process.stdout.write(`\n[Turn ${turn}] Running verifier...\n`);
    const verifyResult = await runStep({
      command: verifyCommand,
      cwd,
      stdoutPath: join(turnDir, "verify.stdout.log"),
      stderrPath: join(turnDir, "verify.stderr.log"),
      timeoutMs: config.verifyTimeoutMs,
      label: `verify-${turn}`,
      env: options.env,
    });

    // 7. Parse verify JSON
    const verifyJsonPath = vars.verifyOutputFile;
    let report: VerifyReport;

    if (!verifyResult.success) {
      // Check if verify output was written anyway (it might exit non-zero with blocked status)
      try {
        report = await parseVerifyOutput(verifyJsonPath);
      } catch {
        const turnResult: TurnResult = {
          turn,
          implementCommand,
          verifyCommand,
          implementDurationMs: implResult.durationMs,
          verifyDurationMs: verifyResult.durationMs,
          repoChanged,
          commitSha,
          verifyStatus: "error",
          thresholdFindings: [],
          belowThresholdFindings: [],
          outcome: "verify-failure",
        };
        state.turns.push(turnResult);
        await writeTurnSummary(turnDir, turnResult);
        state.outcome = "verify-failure";
        return state;
      }
    } else {
      try {
        report = await parseVerifyOutput(verifyJsonPath);
      } catch (e) {
        process.stderr.write(`  Warning: verify output parse error: ${e}\n`);
        const turnResult: TurnResult = {
          turn,
          implementCommand,
          verifyCommand,
          implementDurationMs: implResult.durationMs,
          verifyDurationMs: verifyResult.durationMs,
          repoChanged,
          commitSha,
          verifyStatus: "error",
          thresholdFindings: [],
          belowThresholdFindings: [],
          outcome: "verify-failure",
        };
        state.turns.push(turnResult);
        await writeTurnSummary(turnDir, turnResult);
        state.outcome = "verify-failure";
        return state;
      }
    }

    // 8. Handle blocked
    if (report.status === "blocked") {
      process.stderr.write(`\n[Turn ${turn}] Verify returned status=blocked. Stopping.\n`);
      const { thresholdFindings, belowThresholdFindings } = filterFindings(report.findings, threshold);
      const turnResult: TurnResult = {
        turn,
        implementCommand,
        verifyCommand,
        implementDurationMs: implResult.durationMs,
        verifyDurationMs: verifyResult.durationMs,
        repoChanged,
        commitSha,
        verifyStatus: "blocked",
        thresholdFindings,
        belowThresholdFindings,
        outcome: "verify-blocked",
      };
      state.turns.push(turnResult);
      await writeTurnSummary(turnDir, turnResult);
      state.outcome = "verify-blocked";
      return state;
    }

    // 8b. Handle error status — terminal like blocked
    if (report.status === "error") {
      process.stderr.write(`\n[Turn ${turn}] Verify returned status=error. Stopping.\n`);
      const { thresholdFindings, belowThresholdFindings } = filterFindings(report.findings, threshold);
      const turnResult: TurnResult = {
        turn,
        implementCommand,
        verifyCommand,
        implementDurationMs: implResult.durationMs,
        verifyDurationMs: verifyResult.durationMs,
        repoChanged,
        commitSha,
        verifyStatus: "error",
        thresholdFindings,
        belowThresholdFindings,
        outcome: "verify-error",
      };
      state.turns.push(turnResult);
      await writeTurnSummary(turnDir, turnResult);
      state.outcome = "verify-error";
      return state;
    }

    // 9. Split findings by threshold
    const { thresholdFindings, belowThresholdFindings } = filterFindings(report.findings, threshold);

    process.stdout.write(`\n[Turn ${turn}] Verify results: ${report.findings.length} total findings, ${thresholdFindings.length} at/above threshold ${threshold}\n`);

    // 10. Determine outcome
    let outcome: TurnResult["outcome"];
    if (thresholdFindings.length === 0) {
      outcome = "clean";
    } else if (turn >= maxTurns) {
      outcome = "capped";
    } else {
      outcome = "continue";
    }

    const turnResult: TurnResult = {
      turn,
      implementCommand,
      verifyCommand,
      implementDurationMs: implResult.durationMs,
      verifyDurationMs: verifyResult.durationMs,
      repoChanged,
      commitSha,
      commitMessage,
      verifyStatus: report.status,
      thresholdFindings,
      belowThresholdFindings,
      outcome,
    };
    state.turns.push(turnResult);
    await writeTurnSummary(turnDir, turnResult);

    if (outcome === "clean") {
      process.stdout.write(`\n[Turn ${turn}] Clean! Zero threshold findings. Stopping loop.\n`);
      state.outcome = "clean";
      return state;
    }

    if (outcome === "capped") {
      process.stdout.write(`\n[Turn ${turn}] Max turns reached with ${thresholdFindings.length} threshold findings remaining.\n`);
      state.outcome = "capped";
      return state;
    }

    process.stdout.write(`\n[Turn ${turn}] ${thresholdFindings.length} threshold finding(s) remain. Continuing...\n`);
  }

  // Should not reach here
  state.outcome = "capped";
  return state;
}

async function writeTurnSummary(turnDir: string, result: TurnResult): Promise<void> {
  await writeJsonFile(join(turnDir, "turn-summary.json"), result);
}
