import { resolve, basename, join } from "node:path";
import type { RunOptions, RunState, SavedRunConfig, AdversaryConfig } from "../types/index.js";
import { runPreflight } from "../preflight/index.js";
import type { Platform } from "../preflight/index.js";
import { setupBranch } from "../branch/index.js";
import { loadConfig } from "../config/index.js";
import { buildRunDir, initRunDir, saveRunConfig, snapshotPlan, writeDoneFlag, runIdFromRunDir } from "../artifacts/index.js";
import { runLoop } from "../loop/index.js";
import { generateFinalSummary, assemblePrBody } from "../summary/index.js";
import { generatePrSummary } from "../summarizer/index.js";
import { pushBranch, getRemoteBranchSha, getHeadSha, isAncestor, GitError } from "../git/index.js";
import { createPr, findExistingPr, PrError } from "../pr/index.js";
import { extractPlanTitle, slugify } from "../utils/slugify.js";
import { writeText, fileExists } from "../utils/fs.js";

/**
 * Thrown when pushing the branch to remote fails.
 * Caught at the top level in runCommand and resumeCommand to write done.flag
 * and exit with code 1.
 */
export class PushFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushFailureError";
  }
}

export function validateRunOptions(options: RunOptions): void {
  if (options.turns < 1) {
    throw new Error("--turns must be >= 1");
  }
  if (options.severityThreshold < 1 || options.severityThreshold > 10) {
    throw new Error("--severity-threshold must be between 1 and 10");
  }
}

export function isFailureOutcome(outcome: string | undefined): boolean {
  return (
    outcome === "commit-failure" ||
    outcome === "implement-failure" ||
    outcome === "summarizer-failure" ||
    outcome === "verify-failure" ||
    outcome === "verify-error" ||
    outcome === "push-failure"
  );
}

/**
 * Run the post-loop phases: final summary, PR description, push, PR creation.
 * Skip phases whose artifacts already exist (idempotent for resume).
 */
export async function runPostLoopPhases(
  state: RunState,
  options: {
    severityThreshold: number;
    config: AdversaryConfig;
    platform: Platform;
    prCli: "gh" | "glab";
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
): Promise<void> {
  const { severityThreshold, config, platform, prCli, cwd, env } = options;

  // Final summary
  process.stdout.write(`\n[Summary] Generating final summary...\n`);
  await generateFinalSummary(state, severityThreshold);

  process.stdout.write(`\n[Result] Outcome: ${state.outcome}\n`);
  process.stdout.write(`  Turns completed: ${state.turns.length}\n`);

  if (isFailureOutcome(state.outcome)) {
    process.stdout.write(
      `\n[Push] Skipping push/PR — run ended with failure outcome: ${state.outcome}\n`
    );
    return;
  }

  // Generate PR body (skip if already exists)
  const prBodyPath = join(state.runDir, "pr-body.md");
  let prTitle: string;
  let prBody: string;

  const prTitlePath = join(state.runDir, "pr-title.txt");
  if (fileExists(prBodyPath)) {
    process.stdout.write(`\n[PR] Reusing existing PR description from ${prBodyPath}\n`);
    prBody = await Bun.file(prBodyPath).text();
    // Prefer the persisted title (written alongside pr-body.md), fall back to first line extraction
    if (fileExists(prTitlePath)) {
      prTitle = (await Bun.file(prTitlePath).text()).trim();
    } else {
      process.stdout.write(`\n[PR] pr-title.txt not found — using plan title fallback\n`);
      const firstLine = prBody.split("\n")[0] ?? "";
      prTitle = firstLine.startsWith("# ") ? firstLine.slice(2).trim() : state.planTitle.slice(0, 72);
    }
  } else {
    process.stdout.write(`\n[PR] Generating PR description...\n`);
    try {
      const prSummary = await generatePrSummary({
        config,
        runDir: state.runDir,
        branch: state.branch,
        baseBranch: state.baseBranch,
        planTitle: state.planTitle,
        planContent: await Bun.file(join(state.runDir, "plan.txt")).text(),
        cwd,
        env,
      });

      // Apply fallback if LLM title is empty or unreasonably long (>200 chars)
      const rawTitle = prSummary.title;
      if (!rawTitle || rawTitle.trim() === "" || rawTitle.length > 200) {
        prTitle = state.planTitle.slice(0, 72);
      } else {
        prTitle = rawTitle;
      }

      prBody = assemblePrBody(state, severityThreshold, prSummary, cwd);
      await writeText(prBodyPath, prBody);
      // Persist the title alongside the body so resume can recover it (VI-6)
      await writeText(prTitlePath, prTitle);
    } catch (e) {
      state.prError = `PR summary generation failed: ${e}`;
      await generateFinalSummary(state, severityThreshold);
      process.stderr.write(`\n[PR] PR description generation failed: ${e}\n`);
      throw e;
    }
  }

  // Push branch (skip only if remote is already up-to-date with local HEAD)
  const remoteSha = await getRemoteBranchSha(state.branch, "origin", cwd);
  if (remoteSha !== null) {
    const localSha = await getHeadSha(cwd);
    if (remoteSha === localSha) {
      process.stdout.write(`\n[Push] Branch ${state.branch} already up-to-date on remote — skipping push\n`);
    } else {
      // Check for divergent remote: remote SHA must be an ancestor of local HEAD (VI-8)
      const remoteIsAncestor = await isAncestor(remoteSha, localSha, cwd);
      if (!remoteIsAncestor) {
        const runId = runIdFromRunDir(state.runDir);
        const msg = `Remote branch has diverged from local — push refused. Reconcile manually (e.g. git pull --rebase).`;
        process.stderr.write(`\n[Push] Error: ${msg}\n`);
        process.stderr.write(`After resolving, retry with: adversary resume ${runId}\n`);
        state.outcome = "push-failure";
        await generateFinalSummary(state, severityThreshold);
        throw new PushFailureError(`${msg} After resolving, retry with: adversary resume ${runId}`);
      }
      // Local has new commits — push them
      process.stdout.write(`\n[Push] Branch ${state.branch} remote SHA differs from local HEAD — pushing...\n`);
      try {
        await pushBranch(state.branch, "origin", cwd);
        process.stdout.write(`  Pushed OK\n`);
      } catch (e) {
        if (e instanceof GitError) {
          const runId = runIdFromRunDir(state.runDir);
          process.stderr.write(`\n[Push] Error: push failed: ${e.message}\n`);
          process.stderr.write(`After resolving, retry with: adversary resume ${runId}\n`);
          state.outcome = "push-failure";
          await generateFinalSummary(state, severityThreshold);
          throw new PushFailureError(`push failed: ${e.message}. After resolving, retry with: adversary resume ${runId}`);
        }
        throw e;
      }
    }
  } else {
    process.stdout.write(`\n[Push] Pushing branch ${state.branch}...\n`);
    try {
      await pushBranch(state.branch, "origin", cwd);
      process.stdout.write(`  Pushed OK\n`);
    } catch (e) {
      if (e instanceof GitError) {
        const runId = runIdFromRunDir(state.runDir);
        process.stderr.write(`\n[Push] Error: push failed: ${e.message}\n`);
        process.stderr.write(`After resolving, retry with: adversary resume ${runId}\n`);
        state.outcome = "push-failure";
        await generateFinalSummary(state, severityThreshold);
        throw new PushFailureError(`push failed: ${e.message}. After resolving, retry with: adversary resume ${runId}`);
      }
      throw e;
    }
  }

  // Create PR/MR (skip if already exists)
  const existingPrUrl = await findExistingPr(platform, prCli, state.branch, cwd, env, config.prTimeoutMs);
  if (existingPrUrl) {
    process.stdout.write(`\n[PR] Found existing PR/MR: ${existingPrUrl}\n`);
    state.prUrl = existingPrUrl;
    await generateFinalSummary(state, severityThreshold);
  } else {
    process.stdout.write(`\n[PR] Creating draft PR/MR...\n`);
    try {
      const prUrl = await createPr({
        state,
        platform,
        prCli,
        prBody,
        prTitle,
        cwd,
        timeoutMs: config.prTimeoutMs,
        env,
      });
      state.prUrl = prUrl;
      await generateFinalSummary(state, severityThreshold);
    } catch (e) {
      if (e instanceof PrError) {
        state.prError = e.message;
        await generateFinalSummary(state, severityThreshold);
        process.stderr.write(`\n[PR] PR/MR creation failed — exiting with error despite run outcome: ${state.outcome}\n`);
        throw e;
      }
      throw e;
    }
  }
}

export async function runCommand(options: RunOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const spawnEnv = options.env ?? process.env;
  const planFile = resolve(cwd, options.plan);

  validateRunOptions(options);

  process.stdout.write(`\nAdversary Run\n`);
  process.stdout.write(`  Plan: ${planFile}\n`);
  process.stdout.write(`  Max turns: ${options.turns}\n`);
  process.stdout.write(`  Severity threshold: ${options.severityThreshold}\n`);

  // 1. Load config
  const config = await loadConfig(cwd, options.configFile);
  if (options.baseBranch) {
    config.baseBranch = options.baseBranch;
  }

  // 2. Preflight
  process.stdout.write(`\n[Preflight] Running checks...\n`);
  const preflight = await runPreflight(cwd, planFile, config, spawnEnv);

  process.stdout.write(`  Platform: ${preflight.platform}\n`);
  process.stdout.write(`  PR CLI: ${preflight.prCli}\n`);
  process.stdout.write(`  Remote: ${preflight.remoteUrl ?? "none"}\n`);
  process.stdout.write(`  Preflight OK\n`);

  // 3. Read plan
  const planContent = await Bun.file(planFile).text();
  const planTitle = extractPlanTitle(planContent) ?? basename(planFile, ".md");
  const planSlug = slugify(planTitle);

  process.stdout.write(`  Plan title: ${planTitle}\n`);

  // 4. Build run dir
  const runDir = buildRunDir(cwd, planSlug);
  await initRunDir(runDir);

  process.stdout.write(`  Run dir: ${runDir}\n`);

  // Install SIGINT handler now that we know runDir
  const runId = runIdFromRunDir(runDir);
  process.once("SIGINT", () => {
    process.stderr.write(`\nRun interrupted. Resume with: adversary resume ${runId}\n`);
    process.exit(130);
  });

  // 5. Snapshot plan
  await snapshotPlan(runDir, planContent);

  // 6. Branch setup
  process.stdout.write(`\n[Branch] Setting up branch...\n`);
  const { baseBranch, featureBranch } = await setupBranch(
    cwd,
    planSlug,
    config.baseBranch
  );
  process.stdout.write(`  Base: ${baseBranch}\n`);
  process.stdout.write(`  Feature: ${featureBranch}\n`);

  // 7. Save run config
  const savedRunConfig: SavedRunConfig = {
    planFile,
    planTitle,
    branch: featureBranch,
    baseBranch,
    turns: options.turns,
    threshold: options.severityThreshold,
    config,
    startedAt: new Date().toISOString(),
  };
  await saveRunConfig(runDir, savedRunConfig);

  // 8. Build initial run state
  const state: RunState = {
    runDir,
    planFile,
    planTitle,
    branch: featureBranch,
    baseBranch,
    startedAt: new Date().toISOString(),
    turns: [],
  };

  // 9. Run loop
  await runLoop({
    cwd,
    state,
    planContent,
    maxTurns: options.turns,
    threshold: options.severityThreshold,
    config,
    env: spawnEnv,
  });

  // 10. Post-loop phases
  try {
    await runPostLoopPhases(state, {
      severityThreshold: options.severityThreshold,
      config,
      platform: preflight.platform,
      prCli: preflight.prCli,
      cwd,
      env: spawnEnv,
    });
  } catch (e) {
    if (e instanceof PushFailureError) {
      // push-failure: done.flag already has outcome set; write it and exit non-zero
      await writeDoneFlag(runDir, {
        outcome: state.outcome!,
        completedAt: new Date().toISOString(),
        prUrl: state.prUrl,
      });
      process.exit(1);
    }
    throw e;
  }

  // 11. Write done flag
  await writeDoneFlag(runDir, {
    outcome: state.outcome!,
    completedAt: new Date().toISOString(),
    prUrl: state.prUrl,
  });

  process.stdout.write(`\n[Done] Run complete.\n`);
  process.stdout.write(`  Outcome: ${state.outcome}\n`);
  process.stdout.write(`  Artifacts: ${runDir}\n`);
  if (state.prUrl) {
    process.stdout.write(`  PR/MR: ${state.prUrl}\n`);
  }
}
