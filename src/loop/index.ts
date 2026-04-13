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
import { hasChanges, commitAll, GitError } from "../git/index.js";
import {
  generateFirstTurnPrompt,
  generateLaterTurnPrompt,
  generateFindingsFile,
  generateHistoryFile,
} from "../prompts/index.js";
import { generateCommitMessage } from "../summarizer/index.js";
import { writeText, writeJsonFile, ensureDir } from "../utils/fs.js";
import { interpolate } from "../utils/slugify.js";
import { formatFindingsTable } from "../ui/findingsTable.js";
import { detectScope } from "../scope/index.js";
import { runDiscovery, getCachedProjectSkills } from "../discovery/index.js";
import { checkBrowserAutomation } from "../preflight/index.js";
import { runVerification } from "../verify/index.js";

// Re-export for backward compatibility
export { VerifyParseError } from "../verify/parse.js";
export { parseVerifyOutput } from "../verify/parse.js";

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
        commitError: lastTurn?.commitError,
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
    const implResult = await runStep({
      command: implementCommand,
      cwd,
      stdoutPath: join(turnDir, "implement.stdout.log"),
      stderrPath: join(turnDir, "implement.stderr.log"),
      timeoutMs: config.implementTimeoutMs,
      label: "implement",
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
        verifyStatus: "skipped",
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
    let turnSummary: string | undefined;
    const repoChanged = await hasChanges(cwd);
    if (repoChanged) {
      try {
        const summarizerResult = await generateCommitMessage({
          config,
          turnDir,
          branch: state.branch,
          planTitle: state.planTitle,
          turn,
          cwd,
          env: options.env,
        });
        commitMessage = summarizerResult.commitMessage;
        turnSummary = summarizerResult.turnSummary;
      } catch (e) {
        process.stderr.write(`  Commit message generation failed: ${e}\n`);
        process.stderr.write(
          `  NOTE: Implement step made changes that remain uncommitted. Inspect the working tree before retrying.\n`
        );
        const turnResult: TurnResult = {
          turn,
          implementCommand,
          verifyCommand: "",
          implementDurationMs: implResult.durationMs,
          verifyDurationMs: 0,
          repoChanged: true,
          verifyStatus: "skipped",
          thresholdFindings: [],
          belowThresholdFindings: [],
          outcome: "summarizer-failure",
        };
        state.turns.push(turnResult);
        await writeTurnSummary(turnDir, turnResult);
        state.outcome = "summarizer-failure";
        return state;
      }

      try {
        commitSha = await commitAll(commitMessage, cwd);
      } catch (e) {
        if (e instanceof GitError) {
          const errorMsg = e.message;
          process.stderr.write(`\n  Error: Commit failed (pre-commit hook?): ${errorMsg.slice(0, 500)}\n`);
          process.stderr.write(`  Changes remain in working tree — next turn will address the issue.\n`);
          const turnResult: TurnResult = {
            turn,
            implementCommand,
            verifyCommand: "",
            implementDurationMs: implResult.durationMs,
            verifyDurationMs: 0,
            repoChanged: true,
            commitError: errorMsg,
            verifyStatus: "skipped",
            thresholdFindings: [],
            belowThresholdFindings: [],
            outcome: "commit-failure",
          };
          state.turns.push(turnResult);
          await writeTurnSummary(turnDir, turnResult);
          continue;
        }
        throw e;
      }
      process.stdout.write(`  Committed: ${commitSha.slice(0, 8)}\n`);

      if (turnSummary) {
        process.stdout.write(`\n  Summary: ${turnSummary}\n`);
      }
    } else {
      process.stdout.write(`\n  No repo changes after implement — skipping commit.\n`);
    }

    // 5. Scope detection (deterministic)
    const verifyCommand = "multi-skill: 4 parallel + deterministic commands + exerciser + synthesis";
    await writeText(join(turnDir, "verify-command.txt"), verifyCommand);

    process.stdout.write("\n");

    let report: VerifyReport;
    const verifyStart = Date.now();
    try {
      // 5a. Detect scope
      const scope = await detectScope(cwd, state.baseBranch);

      // 5b. Discovery (cached after turn 1)
      const discovery = await runDiscovery({
        cwd,
        scope,
        config,
        runDir: state.runDir,
        turnDir,
        env: options.env,
      });

      // 5c. Browser automation check (turn 1 only)
      if (turn === 1) {
        await checkBrowserAutomation(config.browserAutomation, discovery);
      }

      // 5d. Read cached project skills (populated by runDiscovery on turn 1,
      //     avoids redundant find commands on every subsequent turn)
      const projectSkills = await getCachedProjectSkills(state.runDir);

      // 5e. Run verification pipeline
      report = await runVerification({
        cwd,
        turnDir,
        scope,
        discovery,
        planContent,
        config,
        projectSkills,
        env: options.env,
      });
    } catch (e) {
      process.stderr.write(`  Error: verification pipeline failed: ${e}\n`);
      const turnResult: TurnResult = {
        turn,
        implementCommand,
        verifyCommand,
        implementDurationMs: implResult.durationMs,
        verifyDurationMs: Date.now() - verifyStart,
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

    const verifyDurationMs = Date.now() - verifyStart;

    // 6. Handle error status
    if (report.status === "error") {
      process.stderr.write(`\n[Turn ${turn}] Verify returned status=error. Stopping.\n`);
      const { thresholdFindings, belowThresholdFindings } = filterFindings(report.findings, threshold);
      const turnResult: TurnResult = {
        turn,
        implementCommand,
        verifyCommand,
        implementDurationMs: implResult.durationMs,
        verifyDurationMs,
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

    // 8. Split findings by threshold
    const { thresholdFindings, belowThresholdFindings } = filterFindings(report.findings, threshold);

    // 9. Display findings
    if (thresholdFindings.length > 0) {
      process.stdout.write("\n" + formatFindingsTable(thresholdFindings) + "\n");
    } else {
      process.stdout.write(`\n  ✓ No findings at or above severity threshold ${threshold}\n`);
    }

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
      verifyDurationMs,
      repoChanged,
      commitSha,
      commitMessage,
      turnSummary,
      verifyStatus: report.status,
      thresholdFindings,
      belowThresholdFindings,
      outcome,
    };
    state.turns.push(turnResult);
    await writeTurnSummary(turnDir, turnResult);

    if (outcome === "clean") {
      state.outcome = "clean";
      return state;
    }

    if (outcome === "capped") {
      const totalFindings = thresholdFindings.length + belowThresholdFindings.length;
      process.stdout.write(`\n  ${totalFindings} findings, ${thresholdFindings.length} at/above threshold — max turns reached\n`);
      state.outcome = "capped";
      return state;
    }

    const totalFindings = thresholdFindings.length + belowThresholdFindings.length;
    process.stdout.write(`\n  ${totalFindings} findings, ${thresholdFindings.length} at/above threshold — continuing to turn ${turn + 1}\n`);
  }

  // Loop exhausted — check if last turn was a commit failure
  const lastTurn = state.turns[state.turns.length - 1];
  state.outcome = lastTurn?.outcome === "commit-failure" ? "commit-failure" : "capped";
  return state;
}

async function writeTurnSummary(turnDir: string, result: TurnResult): Promise<void> {
  await writeJsonFile(join(turnDir, "turn-summary.json"), result);
}
