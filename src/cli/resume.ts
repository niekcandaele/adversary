import { join } from "node:path";
import { readSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { ResumeOptions, AdversaryConfig, SavedRunConfig } from "../types/index.js";
import { getOutcomeLabels } from "../types/index.js";
import { runPreflight } from "../preflight/index.js";
import { reattachBranch } from "../branch/index.js";
import { loadConfig, diffConfigs, parseConfigLayer } from "../config/index.js";
import { getStateDir } from "../config/paths.js";
import { getCurrentBranch } from "../git/index.js";
import {
  readDoneFlag,
  writeDoneFlag,
  runIdFromRunDir,
  findLatestIncompleteRun,
} from "../artifacts/index.js";
import { readJsonFile, fileExists } from "../utils/fs.js";
import { runLoop } from "../loop/index.js";
import { reconstructStateFromArtifacts, computeResumePoint, HeadDriftError } from "../loop/resume.js";
import { getStatusShort, resetHard, cleanForce } from "../git/index.js";
import { runPostLoopPhases, PushFailureError } from "./run.js";


function humanizeOutcome(outcome: string): string {
  // Use the shared labels from types if this is a known RunOutcome
  try {
    return getOutcomeLabels(outcome as import("../types/index.js").RunOutcome).humanizedSentence;
  } catch {
    return outcome;
  }
}

/**
 * Dependencies for promptConfirmSync — injectable for testing.
 */
export interface PromptConfirmDeps {
  isTTY: boolean;
  readLine: () => string;
}

/**
 * Default stdin reader: reads synchronously from fd 0.
 */
function defaultReadLine(): string {
  const buf = Buffer.alloc(256);
  const n = readSync(0, buf, 0, buf.length, null);
  return buf.slice(0, n).toString().trim().toLowerCase();
}

/**
 * Prompt user with a yes/no question. Returns true if confirmed.
 * Reads synchronously from stdin (fd 0) by default.
 * Accepts an injectable deps object for testing.
 */
export function promptConfirmSync(
  question: string,
  deps: PromptConfirmDeps = { isTTY: process.stdin.isTTY, readLine: defaultReadLine }
): boolean {
  process.stderr.write(`${question} [y/N] `);
  const line = deps.readLine();
  return line === "y" || line === "yes";
}

/**
 * Injectable deps for dirty-tree prompt functions — for testing.
 */
export interface PromptDirtyTreeDeps {
  readLine: () => string;
}

/**
 * Prompt user with three options: clear, keep, abort.
 * Returns the chosen action.
 */
export function promptDirtyTreeSync(statusOutput: string, deps?: PromptDirtyTreeDeps): "clear" | "keep" | "abort" {
  process.stderr.write(`\n[Resume] Working tree has uncommitted changes:\n`);
  process.stderr.write(statusOutput + "\n");
  process.stderr.write(`\nChoose how to proceed (--yes flag does not bypass this; resolve manually):\n`);
  process.stderr.write(`  [c] clear  — discard ALL uncommitted changes, including untracked files (cannot be undone)\n`);
  process.stderr.write(`  [k] keep   — leave changes, re-run implement (resume note prepended to prompt)\n`);
  process.stderr.write(`  [a] abort  — exit without doing anything\n`);
  process.stderr.write(`\nChoice [c/k/a]: `);

  let choice: string;
  if (deps) {
    choice = deps.readLine().trim().toLowerCase();
  } else {
    const buf = Buffer.alloc(256);
    const n = readSync(0, buf, 0, buf.length, null);
    choice = buf.slice(0, n).toString().trim().toLowerCase();
  }
  if (choice === "c" || choice === "clear") return "clear";
  if (choice === "k" || choice === "keep") return "keep";
  return "abort";
}

/**
 * Prompt user with two options when skipImplement=true: clear or abort.
 * "keep" is not offered because the implementer won't re-run in this path (VI-6).
 */
export function promptDirtyTreeSyncSkipImplement(statusOutput: string, deps?: PromptDirtyTreeDeps): "clear" | "abort" {
  process.stderr.write(`\n[Resume] Working tree has uncommitted changes:\n`);
  process.stderr.write(statusOutput + "\n");
  process.stderr.write(`\nThe implementer will not re-run at this resume point, so "keep" is not available.\n`);
  process.stderr.write(`Choose how to proceed:\n`);
  process.stderr.write(`  [c] clear  — discard ALL uncommitted changes, including untracked files (cannot be undone)\n`);
  process.stderr.write(`  [a] abort  — exit without doing anything\n`);
  process.stderr.write(`\nChoice [c/a]: `);

  let choice: string;
  if (deps) {
    choice = deps.readLine().trim().toLowerCase();
  } else {
    const buf = Buffer.alloc(256);
    const n = readSync(0, buf, 0, buf.length, null);
    choice = buf.slice(0, n).toString().trim().toLowerCase();
  }
  if (choice === "c" || choice === "clear") return "clear";
  return "abort";
}

export async function resumeCommand(options: ResumeOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const spawnEnv = options.env ?? process.env;

  // Check stdin TTY before any interactive prompts
  if (!process.stdin.isTTY && !options.runId) {
    process.stderr.write(`Error: stdin is not a TTY — aborting.\n`);
    if (options.yes) {
      process.stderr.write(`Pass --run-id <id> alongside --yes to resume non-interactively.\n`);
    } else {
      process.stderr.write(`Pass an explicit --run-id <id> to resume non-interactively.\n`);
    }
    process.exit(1);
  }

  // Install a single SIGINT handler with a message that updates once we know the run ID.
  // Using a shared context object avoids duplicate listeners.
  const sigintContext = { message: `\nAborted.\n` };
  const sigintHandler = () => {
    process.stderr.write(sigintContext.message);
    process.exit(130);
  };
  process.once("SIGINT", sigintHandler);

  // Find run dir
  let runDir: string;
  if (options.runId) {
    runDir = join(getStateDir(cwd), "runs", options.runId);
    if (!fileExists(runDir)) {
      process.removeListener("SIGINT", sigintHandler);
      process.stderr.write(`Error: run directory not found: ${runDir}\n`);
      process.exit(1);
    }
  } else {
    const runInfo = findLatestIncompleteRun(cwd);
    if (!runInfo) {
      process.removeListener("SIGINT", sigintHandler);
      process.stderr.write(`Error: no incomplete run found for this repository.\n`);
      process.stderr.write(`Use 'adversary resume <run-id>' to resume a specific run.\n`);
      process.stderr.write(`Start a fresh run with: adversary run --plan <plan>\n`);
      process.exit(1);
    }
    runDir = runInfo.runDir;
  }

  // Update SIGINT message now that we know runDir
  const runId = runIdFromRunDir(runDir);
  sigintContext.message = `\nRun interrupted. Resume with: adversary resume ${runId}\n`;

  process.stdout.write(`\nAdversary Resume\n`);
  process.stdout.write(`  Run: ${runId}\n`);
  process.stdout.write(`  Run dir: ${runDir}\n`);

  // Read saved run config
  const configPath = join(runDir, "run-config.json");
  if (!fileExists(configPath)) {
    process.stderr.write(`Error: run-config.json not found in ${runDir}\n`);
    process.exit(1);
  }
  const saved = await readJsonFile<SavedRunConfig>(configPath);

  // Runtime-validate required fields so we fail fast with a clear message
  if (typeof saved.threshold !== "number") {
    process.stderr.write(`Error: run-config.json is missing or has invalid 'threshold' field.\n`);
    process.exit(1);
  }
  if (typeof saved.turns !== "number") {
    process.stderr.write(`Error: run-config.json is missing or has invalid 'turns' field.\n`);
    process.exit(1);
  }
  if (typeof saved.branch !== "string" || !saved.branch) {
    process.stderr.write(`Error: run-config.json is missing or has invalid 'branch' field.\n`);
    process.exit(1);
  }
  if (typeof saved.baseBranch !== "string" || !saved.baseBranch) {
    process.stderr.write(`Error: run-config.json is missing or has invalid 'baseBranch' field.\n`);
    process.exit(1);
  }

  // Check done flag
  const doneFlag = await readDoneFlag(runDir);
  if (doneFlag) {
    const terminalComplete = doneFlag.outcome === "clean" || doneFlag.outcome === "capped";
    if (terminalComplete) {
      process.stderr.write(
        `Error: this run already completed (${humanizeOutcome(doneFlag.outcome)}) on ${doneFlag.completedAt}.\n`
      );
      process.stderr.write(`Completed runs cannot be resumed.\n`);
      process.exit(1);
    } else {
      // Terminal failure — warn and require confirmation
      process.stderr.write(
        `\nWarning: this run previously ended with a terminal failure: ${humanizeOutcome(doneFlag.outcome)} (at ${doneFlag.completedAt}).\n`
      );
      process.stderr.write(`Resuming will re-run from the failed point.\n`);
      if (options.yes) {
        // --yes flag bypasses the confirmation prompt for terminal-failure runs
        process.stderr.write(`  --yes flag set — proceeding without confirmation.\n`);
      } else {
        const isTTY = options.confirmDeps ? options.confirmDeps.isTTY : process.stdin.isTTY;
        if (!isTTY) {
          process.stderr.write(
            `Error: stdin is not a TTY — cannot prompt for confirmation. ` +
              `Pass --yes to confirm non-interactively, or use 'adversary resume --run-id <id>' ` +
              `in a TTY context.\n`
          );
          process.exit(1);
        }
        const confirmed = promptConfirmSync(`Continue with resume?`, options.confirmDeps);
        if (!confirmed) {
          process.stderr.write(`Aborted.\n`);
          process.exit(1);
        }
      }
    }
  }

  // Re-load live config; pin baseBranch + severityThreshold from saved
  const liveConfig = await loadConfig(cwd, options.configFile);
  // Re-validate the saved config snapshot through parseConfigLayer so we fail fast
  // on any schema violations rather than silently using invalid values.
  let validatedSavedConfig: ReturnType<typeof parseConfigLayer>;
  try {
    validatedSavedConfig = saved.config
      ? parseConfigLayer(saved.config as unknown as Record<string, unknown>)
      : {};
  } catch (e) {
    process.stderr.write(
      `Error: saved run-config.json has an invalid config value: ${e instanceof Error ? e.message : String(e)}\n`
    );
    process.exit(1);
    return; // unreachable but satisfies TypeScript flow
  }
  const configDiffs = diffConfigs(validatedSavedConfig, liveConfig);
  if (configDiffs.length > 0) {
    process.stdout.write(`\n[Resume] Config changed since run started:\n`);
    for (const d of configDiffs) {
      // Skip carve-outs — those are always pinned from saved
      if (d.key === "baseBranch") continue;
      process.stdout.write(`  ${d.key}: ${JSON.stringify(d.saved)} → ${JSON.stringify(d.live)}\n`);
    }
    process.stdout.write(`  (pinned from saved: baseBranch="${saved.baseBranch}", turns=${saved.turns}, severityThreshold=${saved.threshold})\n`);
  }

  // Build final config with carve-outs pinned from saved
  const config: AdversaryConfig = { ...liveConfig, baseBranch: saved.baseBranch };
  const threshold = saved.threshold;
  const maxTurns = saved.turns;
  const branch = saved.branch;

  // Print auto-pick info immediately after Adversary Resume header, before Branch/MaxTurns (VI-12)
  if (!options.runId) {
    const ageMs = saved.startedAt ? Date.now() - new Date(saved.startedAt).getTime() : 0;
    let ageStr: string;
    if (ageMs < 60000) {
      ageStr = "less than a minute ago";
    } else if (ageMs < 3600000) {
      const ageMins = Math.round(ageMs / 60000);
      ageStr = `${ageMins} minute${ageMins === 1 ? "" : "s"} ago`;
    } else if (ageMs < 86400000) {
      const ageHours = Math.round(ageMs / 3600000);
      ageStr = `${ageHours} hour${ageHours === 1 ? "" : "s"} ago`;
    } else {
      const ageDays = Math.round(ageMs / 86400000);
      ageStr = `${ageDays} day${ageDays === 1 ? "" : "s"} ago`;
    }
    process.stdout.write(`\n[Resume] Auto-selected run: ${runId}\n`);
    process.stdout.write(`  Plan: ${saved.planTitle}\n`);
    process.stdout.write(`  Started: ${saved.startedAt} (${ageStr})\n`);
    process.stdout.write(`  To start fresh instead: adversary run --plan <plan>\n`);
  }

  process.stdout.write(`  Branch: ${branch}\n`);
  process.stdout.write(`  Max turns: ${maxTurns}\n`);
  process.stdout.write(`  Severity threshold: ${threshold}\n`);

  // Before preflight: detect cross-branch dirty tree early — cheap check before any external calls.
  // If on a different branch with uncommitted changes, we cannot safely checkout.
  const currentBranch = await getCurrentBranch(cwd);
  const needsBranchSwitch = currentBranch !== branch;
  if (needsBranchSwitch) {
    // Use --untracked-files=no because `git checkout` tolerates untracked files;
    // only actual modifications (tracked file changes, staged changes) prevent the switch.
    const preSwitchStatus = await getStatusShort(cwd, { ignoreUntracked: true });
    if (preSwitchStatus.trim()) {
      process.stderr.write(
        `\n[Resume pre-check] Error: You have uncommitted changes on branch '${currentBranch}', ` +
          `but this run was on branch '${branch}'.\n`
      );
      process.stderr.write(
        `Commit or stash your changes before resuming:\n` +
          `  git stash\n` +
          `  adversary resume ${runIdFromRunDir(runDir)}\n`
      );
      process.exit(1);
    }
  }

  // Read plan
  const planPath = join(runDir, "plan.txt");
  if (!fileExists(planPath)) {
    process.stderr.write(`Error: plan.txt not found in ${runDir}\n`);
    process.exit(1);
  }
  const planContent = await Bun.file(planPath).text();

  // Preflight (skip clean-tree check)
  process.stdout.write(`\n[Preflight] Running checks (resume mode)...\n`);
  const preflight = await runPreflight(cwd, planPath, config, spawnEnv, { resumeMode: true });
  process.stdout.write(`  Platform: ${preflight.platform}\n`);
  process.stdout.write(`  PR CLI: ${preflight.prCli}\n`);
  process.stdout.write(`  Preflight OK\n`);

  // Reattach branch
  process.stdout.write(`\n[Branch] Reattaching to branch ${branch}...\n`);
  try {
    await reattachBranch(cwd, branch);
  } catch (e) {
    const originalMessage = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `\n[Branch] Error: Failed to checkout branch '${branch}'.\n` +
        `  ${originalMessage}\n` +
        `  If you have untracked files causing a conflict, stash them first:\n` +
        `    git stash -u\n` +
        `    adversary resume ${runIdFromRunDir(runDir)}\n`
    );
    process.exit(1);
  }
  process.stdout.write(`  On branch: ${branch}\n`);

  // Reconstruct state from artifacts
  process.stdout.write(`\n[Resume] Reconstructing run state from artifacts...\n`);
  const state = await reconstructStateFromArtifacts(runDir, {
    planFile: saved.planFile,
    planTitle: saved.planTitle,
    branch: saved.branch,
    baseBranch: saved.baseBranch,
    startedAt: saved.startedAt,
  });
  process.stdout.write(`  Completed turns found: ${state.turns.length}\n`);

  // Compute resume point — HeadDriftError is caught and printed as a clean error (VI-4)
  let resumePoint;
  try {
    resumePoint = await computeResumePoint(state, runDir, branch, cwd);
  } catch (e) {
    if (e instanceof HeadDriftError) {
      process.stderr.write(`\n[Resume pre-check] Error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const phaseDesc = resumePoint.skipImplement
    ? (resumePoint.skipVerify ? "post-verify" : "verify")
    : "implement";
  process.stdout.write(
    `  Resume at turn ${resumePoint.turn}, phase: ${phaseDesc}\n`
  );

  // VI-6: When extendForResume is set, bump maxTurns by 1 so the loop can re-verify
  // extra commits added after the last completed turn.
  let effectiveMaxTurns = maxTurns;
  if (resumePoint.extendForResume) {
    effectiveMaxTurns = maxTurns + 1;
    process.stdout.write(
      `  [Resume] Extra commits detected — extending maxTurns to ${effectiveMaxTurns} for re-verification\n`
    );
  }

  // Handle dirty working tree (needed any time we interact with the working tree,
  // i.e. whenever we're not skipping the loop entirely)
  if (!resumePoint.skipLoop) {
    const statusOutput = await getStatusShort(cwd);
    if (statusOutput.trim()) {
      if (!process.stdin.isTTY) {
        process.stderr.write(`Error: stdin is not a TTY — cannot prompt for dirty tree resolution. Aborting.\n`);
        process.exit(1);
      }

      // VI-6: When skipImplement=true, the implementer won't re-run, so "keep" is incoherent.
      // Only offer [c]lear and [a]bort.
      if (resumePoint.skipImplement) {
        const choice = promptDirtyTreeSyncSkipImplement(statusOutput, options.dirtyTreeDeps);
        if (choice === "abort") {
          process.stderr.write(`Aborted.\n`);
          process.exit(1);
        }
        // clear
        process.stdout.write(`\n[Resume] Resetting working tree...\n`);
        await resetHard("HEAD", cwd);
        await cleanForce(cwd);
        process.stdout.write(`  Working tree clean\n`);
      } else {
        const choice = promptDirtyTreeSync(statusOutput, options.dirtyTreeDeps);
        if (choice === "abort") {
          process.stderr.write(`Aborted.\n`);
          process.exit(1);
        } else if (choice === "clear") {
          process.stdout.write(`\n[Resume] Resetting working tree...\n`);
          await resetHard("HEAD", cwd);
          await cleanForce(cwd);
          process.stdout.write(`  Working tree clean\n`);
        } else {
          // keep — set resume note flag; also force skipVerify=false so we re-verify
          // the kept changes (VI-1: never push unverified code after keep)
          resumePoint = { ...resumePoint, resumeNote: true, skipVerify: false };
          process.stdout.write(
            `\n[Resume] Keeping existing changes — resume note will be prepended to implement prompt\n`
          );
        }
      }
    }
  }

  // VI-1: Pop stale failed-turn entry when re-entering the same turn from scratch.
  // reconstructStateFromArtifacts loads every turn-summary.json it finds, including
  // the one written for a failed turn (e.g. implement-failure). When computeResumePoint
  // returns turn === highestN (re-entering the same turn), that failed entry is still the
  // last entry in state.turns. Pop it so:
  //   (a) generateLaterTurnPrompt reads the correct prior turn's thresholdFindings, and
  //   (b) the loop doesn't create a duplicate turn-N entry in the final state.
  //
  // Only pop when resumePoint.turn matches the last entry's turn number AND that entry
  // has a non-continue outcome (i.e. it was a failed/terminal turn, not a "continue" turn
  // that was already accounted for by advancing to highestN+1). We never pop a skipLoop
  // resume point because those don't re-run the loop at all.
  if (!resumePoint.skipLoop) {
    const lastEntry = state.turns[state.turns.length - 1];
    if (
      lastEntry !== undefined &&
      lastEntry.turn === resumePoint.turn &&
      lastEntry.outcome !== "continue"
    ) {
      state.turns.pop();
      process.stdout.write(
        `  [Resume] Popped stale turn-${lastEntry.turn} entry (outcome: ${lastEntry.outcome}) from state — will re-run\n`
      );
    }
  }

  // Track turn count before runLoop so we can detect whether new turns were added this session
  const turnsBeforeLoop = state.turns.length;

  // Run loop from resume point (use effectiveMaxTurns which may be bumped for extendForResume)
  await runLoop({
    cwd,
    state,
    planContent,
    maxTurns: effectiveMaxTurns,
    threshold,
    config,
    env: spawnEnv,
    resumePoint,
  });

  // VI-2: If any turns ran during this resume session, delete stale PR artifacts so
  // runPostLoopPhases regenerates the PR description with the updated turn history.
  const turnsRanThisSession = state.turns.length > turnsBeforeLoop;
  if (turnsRanThisSession) {
    const prBodyPath = join(runDir, "pr-body.md");
    const prTitlePath = join(runDir, "pr-title.txt");
    await unlink(prBodyPath).catch(() => {/* file may not exist */});
    await unlink(prTitlePath).catch(() => {/* file may not exist */});
    process.stdout.write(
      `  [Resume] Deleted stale pr-body.md / pr-title.txt — PR description will be regenerated\n`
    );
  }

  // Post-loop phases
  try {
    await runPostLoopPhases(state, {
      severityThreshold: threshold,
      config,
      platform: preflight.platform,
      prCli: preflight.prCli,
      cwd,
      env: spawnEnv,
    });
  } catch (e) {
    if (e instanceof PushFailureError) {
      // push-failure: state.outcome and final-summary already set in runPostLoopPhases
      if (!state.outcome) state.outcome = "push-failure";
      await writeDoneFlag(runDir, {
        outcome: state.outcome,
        completedAt: new Date().toISOString(),
        prUrl: state.prUrl,
      });
      process.exit(1);
    }
    throw e;
  }

  // Write done flag
  if (!state.outcome) {
    throw new Error(
      `Run completed but state.outcome is not set — this is a bug. ` +
        `Cannot write done.flag without a valid outcome.`
    );
  }
  await writeDoneFlag(runDir, {
    outcome: state.outcome,
    completedAt: new Date().toISOString(),
    prUrl: state.prUrl,
  });

  process.stdout.write(`\n[Done] Resume complete.\n`);
  process.stdout.write(`  Outcome: ${state.outcome}\n`);
  process.stdout.write(`  Artifacts: ${runDir}\n`);
  if (state.prUrl) {
    process.stdout.write(`  PR/MR: ${state.prUrl}\n`);
  }
}
