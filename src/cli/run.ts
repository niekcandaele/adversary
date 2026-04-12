import { resolve, basename, join } from "node:path";
import type { RunOptions, RunState } from "../types/index.js";
import { runPreflight } from "../preflight/index.js";
import { setupBranch } from "../branch/index.js";
import { loadConfig } from "../config/index.js";
import { buildRunDir, initRunDir, saveRunConfig, snapshotPlan } from "../artifacts/index.js";
import { runLoop } from "../loop/index.js";
import { generateFinalSummary, assemblePrBody } from "../summary/index.js";
import { generatePrSummary } from "../summarizer/index.js";
import { pushBranch } from "../git/index.js";
import { createPr, PrError } from "../pr/index.js";
import { extractPlanTitle, slugify } from "../utils/slugify.js";
import { writeText } from "../utils/fs.js";

export function validateRunOptions(options: RunOptions): void {
  if (options.turns < 1) {
    throw new Error("--turns must be >= 1");
  }
  if (options.severityThreshold < 1 || options.severityThreshold > 10) {
    throw new Error("--severity-threshold must be between 1 and 10");
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
  const preflight = await runPreflight(cwd, planFile, spawnEnv);

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
  await saveRunConfig(runDir, {
    planFile,
    planTitle,
    branch: featureBranch,
    baseBranch,
    turns: options.turns,
    threshold: options.severityThreshold,
    config,
    startedAt: new Date().toISOString(),
  });

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

  // 10. Final summary
  process.stdout.write(`\n[Summary] Generating final summary...\n`);
  await generateFinalSummary(state, options.severityThreshold);

  process.stdout.write(`\n[Result] Outcome: ${state.outcome}\n`);
  process.stdout.write(`  Turns completed: ${state.turns.length}\n`);

  // 11. Push branch and create PR only on successful or capped outcomes
  const isFailureOutcome =
    state.outcome === "commit-failure" ||
    state.outcome === "implement-failure" ||
    state.outcome === "summarizer-failure" ||
    state.outcome === "verify-failure" ||
    state.outcome === "verify-blocked" ||
    state.outcome === "verify-error";

  if (isFailureOutcome) {
    process.stdout.write(
      `\n[Push] Skipping push/PR — run ended with failure outcome: ${state.outcome}\n`
    );
  } else {
    // 12. Generate LLM PR summary BEFORE pushing — so we don't leave an orphaned
    //     remote branch if the summarizer fails.
    process.stdout.write(`\n[PR] Generating PR description...\n`);
    let prTitle: string;
    let prBody: string;
    try {
      const prSummary = await generatePrSummary({
        config,
        runDir,
        branch: featureBranch,
        baseBranch,
        planTitle,
        planContent,
        cwd,
        env: spawnEnv,
      });

      // Apply fallback if LLM title is empty or unreasonably long (>200 chars)
      const rawTitle = prSummary.title;
      if (!rawTitle || rawTitle.trim() === "" || rawTitle.length > 200) {
        prTitle = planTitle.slice(0, 72);
      } else {
        prTitle = rawTitle;
      }

      prBody = assemblePrBody(state, options.severityThreshold, prSummary, cwd);
      await writeText(join(state.runDir, "pr-body.md"), prBody);
    } catch (e) {
      state.prError = `PR summary generation failed: ${e}`;
      await generateFinalSummary(state, options.severityThreshold);
      process.stderr.write(`\n[PR] PR description generation failed: ${e}\n`);
      throw e;
    }

    // 13. Push branch (after summary is ready — avoids orphaned remote branch)
    process.stdout.write(`\n[Push] Pushing branch ${featureBranch}...\n`);
    await pushBranch(featureBranch, "origin", cwd);
    process.stdout.write(`  Pushed OK\n`);

    // 14. Create PR/MR
    process.stdout.write(`\n[PR] Creating draft PR/MR...\n`);
    try {
      const prUrl = await createPr({
        state,
        platform: preflight.platform,
        prCli: preflight.prCli,
        prBody,
        prTitle,
        cwd,
        timeoutMs: config.prTimeoutMs,
        env: spawnEnv,
      });
      state.prUrl = prUrl;
      // Regenerate summary with PR URL
      await generateFinalSummary(state, options.severityThreshold);
    } catch (e) {
      if (e instanceof PrError) {
        state.prError = e.message;
        await generateFinalSummary(state, options.severityThreshold);
        // Note: PR/MR creation failure always causes non-zero exit,
        // even when the run outcome was 'clean' or 'capped'.
        process.stderr.write(`\n[PR] PR/MR creation failed — exiting with error despite run outcome: ${state.outcome}\n`);
        throw e; // PR failure = non-zero exit
      }
      throw e;
    }
  }

  process.stdout.write(`\n[Done] Run complete.\n`);
  process.stdout.write(`  Outcome: ${state.outcome}\n`);
  process.stdout.write(`  Artifacts: ${runDir}\n`);
  if (state.prUrl) {
    process.stdout.write(`  PR/MR: ${state.prUrl}\n`);
  }
}
