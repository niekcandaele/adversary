import { join } from "node:path";
import type {
  AdversaryConfig,
  VerifyFinding,
  VerifyReport,
  TurnResult,
  RunState,
  RunOutcome,
  TemplateVars,
  ResumePoint,
} from "../types/index.js";
import { runStep } from "../runner/index.js";
import { hasChanges, commitAll, GitError, computeTouchedFilesByTurn } from "../git/index.js";
import {
  generateFirstTurnPrompt,
  generateLaterTurnPrompt,
  generateFindingsFile,
  generateHistoryFile,
} from "../prompts/index.js";
import { generateCommitMessage } from "../summarizer/index.js";
import { writeText, writeJsonFile, ensureDir, readJsonFile } from "../utils/fs.js";
import { interpolate } from "../utils/slugify.js";
import { formatFindingsTable } from "../ui/findingsTable.js";
import { detectScope } from "../scope/index.js";
import { cacheRepoGuidance, getCachedRepoGuidance, runDiscovery } from "../discovery/index.js";
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
  /** Optional resume point — used when resuming an interrupted run. */
  resumePoint?: ResumePoint;
}): Promise<RunState> {
  const { cwd, state, planContent, maxTurns, threshold, config } = options;

  const startTurn = options.resumePoint?.turn ?? 1;
  // effectiveMaxTurns is passed in from the caller (resumeCommand bumps it for extendForResume).
  // runLoop does NOT bump again — only ONE place should bump to avoid double-counting.
  const effectiveMaxTurns = maxTurns;

  // If skipLoop is set, the run already reached a terminal outcome — skip the loop
  if (options.resumePoint?.skipLoop) {
    process.stdout.write(`\n[Resume] Highest turn already completed with a terminal outcome — skipping loop\n`);
    // Copy the terminal outcome from the last completed turn so post-loop phases and
    // done.flag writing work correctly. skipLoop is only set when the last turn had
    // "clean" or "capped" outcome, both of which are valid RunOutcome values.
    if (!state.outcome) {
      const lastTurn = state.turns[state.turns.length - 1];
      if (!lastTurn) {
        throw new Error("skipLoop is set but no completed turns found in state — cannot determine outcome");
      }
      if (lastTurn.outcome === "continue") {
        throw new Error(`skipLoop is set but last turn outcome is "continue" — this is a bug in computeResumePoint`);
      }
      state.outcome = lastTurn.outcome as RunOutcome;
    }
    return state;
  }

  // VI-13: Detect startTurn > maxTurns. This would be a logic error — either the resume
  // point is wrong or maxTurns was decreased (caller already bumps for extendForResume).
  if (startTurn > effectiveMaxTurns) {
    throw new Error(
      `Resume error: startTurn (${startTurn}) exceeds maxTurns (${maxTurns}). ` +
        `Cannot resume — the run has no more turns available. ` +
        `The saved run config may have been modified. Start a fresh run with: adversary run --plan <plan>`
    );
  }

  for (let turn = startTurn; turn <= effectiveMaxTurns; turn++) {
    const turnDir = join(state.runDir, `turn-${turn}`);
    await ensureDir(turnDir);

    process.stdout.write(`\n${"=".repeat(60)}\n`);
    process.stdout.write(`  Turn ${turn} of ${maxTurns}\n`);
    process.stdout.write(`${"=".repeat(60)}\n`);

    const vars = buildTemplateVars(cwd, turnDir, state, turn, maxTurns, threshold);

    // Make repo guidance available before prompt generation so turn 1 gets
    // the same repo-specific context that verify already sees.
    const { repoGuidance } = await cacheRepoGuidance(cwd, state.runDir);
    if (turn === 1 && !repoGuidance.trim()) {
      process.stderr.write("  Warning: no repo guidance discovered; continuing with generic prompts\n");
    }

    // Determine if this is the resume turn and whether to skip phases
    const isResumeTurn = turn === startTurn && options.resumePoint !== undefined;
    const skipImplement = isResumeTurn && (options.resumePoint?.skipImplement ?? false);
    const skipVerify = isResumeTurn && (options.resumePoint?.skipVerify ?? false);
    // Only prepend the resume note when the user chose the dirty-tree "keep" path
    const resumeNote = isResumeTurn && (options.resumePoint?.resumeNote ?? false);

    // 1. Generate prompt files (skip if resuming with an existing commit)
    const priorTurns = state.turns;
    const historyPath = vars.historyFile;
    await generateHistoryFile(priorTurns, historyPath);

    const promptPath = vars.promptFile;
    if (!skipImplement) {
      if (turn === 1) {
        await generateFirstTurnPrompt({
          planContent,
          threshold,
          turn,
          maxTurns,
          branch: state.branch,
          repoGuidance,
          outputPath: promptPath,
          resumeNote,
        });
      } else {
        const lastTurn = priorTurns[priorTurns.length - 1];
        const thresholdFindings = lastTurn?.thresholdFindings ?? [];
        const { fileToTurns, commitFailureTurns } = await computeTouchedFilesByTurn(priorTurns, cwd);
        await generateLaterTurnPrompt({
          planContent,
          threshold,
          turn,
          maxTurns,
          branch: state.branch,
          thresholdFindings,
          commitError: lastTurn?.commitError,
          repoGuidance,
          outputPath: promptPath,
          resumeNote,
          touchedFilesByTurn: fileToTurns,
          commitFailureTurns,
        });
      }
    }

    // Also generate findings file for reference
    const lastPriorTurn = priorTurns.length > 0 ? priorTurns[priorTurns.length - 1] : undefined;
    const priorThreshold = lastPriorTurn?.thresholdFindings ?? [];
    await generateFindingsFile(priorThreshold, threshold, vars.findingsFile);

    // 2. Build implement command
    const implementCommand = interpolate(config.implementCommandTemplate, vars);
    await writeText(join(turnDir, "implement-command.txt"), implementCommand);

    // Variables to track implement phase result
    let implDurationMs = 0;
    let resumedCommitSha: string | undefined = options.resumePoint?.knownCommitSha;

    if (skipImplement) {
      process.stdout.write(`  [Resume] Skipping implement — commit already exists (${resumedCommitSha?.slice(0, 8) ?? "unknown"})\n`);
    } else {
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

      implDurationMs = implResult.durationMs;

      if (!implResult.success) {
        const turnResult: TurnResult = {
          turn,
          implementCommand,
          verifyCommand: "",
          implementDurationMs: implDurationMs,
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
    }

    // 4. Commit if repo changed (skip if resuming with existing commit)
    let commitSha: string | undefined = skipImplement ? resumedCommitSha : undefined;
    let commitMessage: string | undefined;
    let turnSummary: string | undefined;
    let repoChanged: boolean;

    if (skipImplement) {
      // Implement was already done, commit already exists — treat as changed
      repoChanged = true;
    } else {
      repoChanged = await hasChanges(cwd);
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
            implementDurationMs: implDurationMs,
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
              implementDurationMs: implDurationMs,
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
    }

    // 5. Scope detection (deterministic)
    const verifyCommand = "multi-skill: 4 parallel + deterministic commands + exerciser + synthesis";
    await writeText(join(turnDir, "verify-command.txt"), verifyCommand);

    process.stdout.write("\n");

    let report: VerifyReport;
    const verifyStart = Date.now();

    if (skipVerify) {
      process.stdout.write(`  [Resume] Skipping verify — verify.json already exists for this turn\n`);
      // Read the cached verify.json result; if unreadable, fall through to re-run
      let cachedReport: VerifyReport | null = null;
      try {
        cachedReport = await readJsonFile<VerifyReport>(join(turnDir, "verify.json"));
      } catch (e) {
        process.stdout.write(`  [Resume] verify.json not readable (${String(e)}), re-running verify\n`);
      }
      if (cachedReport) {
        report = cachedReport;
      } else {
        // Fall through to run verify normally
        try {
          const scope = await detectScope(cwd, state.baseBranch);
          const discovery = await runDiscovery({ cwd, scope, config, runDir: state.runDir, turnDir, env: options.env });
          if (turn === 1) await checkBrowserAutomation(config.browserAutomation, discovery);
          const guidance = await getCachedRepoGuidance(state.runDir);
          report = await runVerification({ cwd, turnDir, scope, discovery, planContent, config, repoGuidance: guidance, env: options.env });
        } catch (e) {
          process.stderr.write(`  Error: verification pipeline failed: ${e}\n`);
          const turnResult: TurnResult = {
            turn, implementCommand, verifyCommand,
            implementDurationMs: implDurationMs, verifyDurationMs: Date.now() - verifyStart,
            repoChanged, commitSha, verifyStatus: "error",
            thresholdFindings: [], belowThresholdFindings: [], outcome: "verify-failure",
          };
          state.turns.push(turnResult);
          await writeTurnSummary(turnDir, turnResult);
          state.outcome = "verify-failure";
          return state;
        }
      }
    } else {
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

        // 5d. Read cached repo guidance
        const repoGuidance = await getCachedRepoGuidance(state.runDir);
        // 5e. Run verification pipeline
        report = await runVerification({
          cwd,
          turnDir,
          scope,
          discovery,
          planContent,
          config,
          repoGuidance,
          env: options.env,
        });
      } catch (e) {
        process.stderr.write(`  Error: verification pipeline failed: ${e}\n`);
        const turnResult: TurnResult = {
          turn,
          implementCommand,
          verifyCommand,
          implementDurationMs: implDurationMs,
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
        implementDurationMs: implDurationMs,
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
      implementDurationMs: implDurationMs,
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
