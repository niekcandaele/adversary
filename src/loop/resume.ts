import { join } from "node:path";
import { readdirSync } from "node:fs";
import { readJsonFile, fileExists } from "../utils/fs.js";
import { isAncestor, commitsBetween, getHeadSha, getMergeBase } from "../git/index.js";
import type { RunState, TurnResult, ResumePoint, SavedRunConfig, VerifyReport } from "../types/index.js";


/**
 * Thrown when computeResumePoint detects HEAD has drifted (diverged from the
 * last recorded commit). Caught in resumeCommand for a clean error message.
 */
export class HeadDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadDriftError";
  }
}

/**
 * Walk state.turns backward to find the most recent turn with a non-empty commitSha.
 * Returns the SHA if found, or "" if no turn has a commitSha.
 *
 * This is needed because some turns may complete without making any repo changes
 * (e.g. the player found nothing to do). In those cases commitSha is undefined.
 * Using "" as the anchor would cause us to compare HEAD against the merge-base
 * of the branch, which is wrong if an earlier turn did record a SHA.
 */
export function findLastRecordedSha(state: RunState): string {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const sha = state.turns[i]!.commitSha;
    if (sha) return sha;
  }
  return "";
}

/**
 * Returns sorted turn directory entries as { n, dir } objects.
 */
function getTurnDirs(runDir: string): Array<{ n: number; dir: string }> {
  const entries = readdirSync(runDir);
  return entries
    .filter((e) => /^turn-\d+$/.test(e))
    .map((e) => ({ n: parseInt(e.replace("turn-", ""), 10), dir: e }))
    .sort((a, b) => a.n - b.n);
}

/**
 * Reconstruct RunState from artifacts on disk.
 */
export async function reconstructStateFromArtifacts(
  runDir: string,
  saved: Pick<SavedRunConfig, "planFile" | "planTitle" | "branch" | "baseBranch" | "startedAt">
): Promise<RunState> {
  const state: RunState = {
    runDir,
    planFile: saved.planFile,
    planTitle: saved.planTitle,
    branch: saved.branch,
    baseBranch: saved.baseBranch,
    startedAt: saved.startedAt,
    turns: [],
  };

  // Find all turn-N directories in order
  for (const { dir } of getTurnDirs(runDir)) {
    const summaryPath = join(runDir, dir, "turn-summary.json");
    if (fileExists(summaryPath)) {
      const summary = await readJsonFile<TurnResult>(summaryPath);
      state.turns.push(summary);
    }
  }

  return state;
}

/**
 * Compute the point in the run to resume from, based on artifact/git state.
 */
export async function computeResumePoint(
  state: RunState,
  runDir: string,
  branch: string,
  cwd: string
): Promise<ResumePoint> {
  // Find highest turn-N dir number
  const turnEntries = getTurnDirs(runDir);
  const highestN = turnEntries.length > 0 ? turnEntries[turnEntries.length - 1]!.n : 0;

  if (highestN === 0) {
    return { turn: 1, skipImplement: false, skipVerify: false };
  }

  const highestDir = join(runDir, `turn-${highestN}`);
  const summaryPath = join(highestDir, "turn-summary.json");

  if (fileExists(summaryPath)) {
    // Turn summary exists — this turn completed
    const summary = await readJsonFile<TurnResult>(summaryPath);

    // VI-3: Check HEAD ancestry against the summary's recorded commitSha.
    // If the branch was rebased/reset, the recorded turn history no longer describes
    // the current code — abort with HeadDriftError regardless of the outcome type.
    const headSha = await getHeadSha(cwd);
    const lastRecordedSha = summary.commitSha;
    if (lastRecordedSha) {
      const isAnc = await isAncestor(lastRecordedSha, headSha, cwd);
      if (!isAnc && headSha !== lastRecordedSha) {
        throw new HeadDriftError(
          `HEAD (${headSha.slice(0, 8)}) is not a descendant of the last recorded commit (${lastRecordedSha.slice(0, 8)}) from turn ${highestN}. ` +
            `The branch history appears to have been rewritten or diverged. ` +
            `To recover: save any uncommitted work first with \`git stash\`, ` +
            `then \`git reset --hard ${lastRecordedSha}\`, then retry resume. ` +
            `Or start a fresh run with \`adversary run --plan <plan>\`.`
        );
      }
    }

    if (summary.outcome === "continue") {
      // Turn completed with "continue" — resume at next turn
      return { turn: highestN + 1, skipImplement: false, skipVerify: false };
    } else {
      // Terminal outcome at this turn — check if the loop is already in a done state
      // (clean/capped) without a done.flag. If so, skip the loop entirely — but ONLY if
      // there are no extra commits beyond the last recorded SHA. Extra commits mean
      // unverified work; we must re-verify in that case.
      if (summary.outcome === "clean" || summary.outcome === "capped") {
        // VI-1: Walk backward through all turns to find the most recent recorded SHA.
        // The current turn's commitSha may be undefined (clean turn with no code changes),
        // but an earlier turn may have one. Using "" here would cause the guard below
        // to evaluate false and skip the loop even when external commits exist.
        const anchorSha = findLastRecordedSha(state);
        const referenceForCheck = anchorSha
          ? anchorSha
          : await getMergeBase(branch, state.baseBranch, cwd);

        if (headSha !== referenceForCheck) {
          // VI-2: Check that HEAD is a proper descendant of anchorSha.
          // If not, the branch was rewritten — abort rather than extend.
          if (referenceForCheck) {
            const isAnc = await isAncestor(referenceForCheck, headSha, cwd);
            if (!isAnc) {
              throw new HeadDriftError(
                `HEAD (${headSha.slice(0, 8)}) is not a descendant of the last verified commit (${referenceForCheck.slice(0, 8)}). ` +
                  `The branch history appears to have been rewritten or diverged. ` +
                  `To recover: save any uncommitted work first with \`git stash\`, ` +
                  `then \`git reset --hard ${referenceForCheck}\`, then retry resume. ` +
                  `Or start a fresh run with \`adversary run --plan <plan>\`.`
              );
            }
          }
          // Extra commits exist beyond the verified state — do NOT skip the loop; re-verify.
          // extendForResume=true allows the loop to run one turn past maxTurns.
          return { turn: highestN + 1, skipImplement: false, skipVerify: false, extendForResume: true };
        }
        // No extra commits — safe to skip the loop
        return { turn: highestN, skipImplement: false, skipVerify: false, skipLoop: true };
      }
      // Re-enter the same turn from scratch
      return { turn: highestN, skipImplement: false, skipVerify: false };
    }
  }

  // No turn-summary → mid-turn interrupt
  // Consistency check: the in-flight turn should be exactly one past the last completed turn
  if (highestN !== state.turns.length + 1) {
    throw new Error(
      `Run state is inconsistent: highest turn directory is turn-${highestN} but only ${state.turns.length} completed turn(s) were found. ` +
        `Expected turn-${state.turns.length + 1} to be the in-flight turn. The run artifacts may be corrupt.`
    );
  }

  // Determine where we left off by comparing HEAD to the last known commit.
  // VI-2: walk backward through all completed turns to find the most recent recorded SHA,
  // rather than only looking at the last turn. This handles the case where turn N-1 had
  // no commit (clean turn with no changes) but turn N-2 did.
  //
  // Three cases:
  //   A) No completed turns → use merge-base as anchor (can still detect single-commit implement)
  //   B) Completed turns exist, some have SHA → use that SHA as anchor
  //   C) Completed turns exist, NONE have SHA → cannot distinguish implement-commit vs external
  //      commit (even merge-base comparison is unreliable); re-run implement.
  const headSha = await getHeadSha(cwd);

  let lastRecordedSha: string;
  if (state.turns.length === 0) {
    // Case A: no completed turns — use merge base as anchor
    lastRecordedSha = await getMergeBase(branch, state.baseBranch, cwd);
  } else {
    const foundSha = findLastRecordedSha(state);
    if (foundSha) {
      // Case B: at least one completed turn has a SHA — use it as anchor
      lastRecordedSha = foundSha;
    } else {
      // Case C: completed turns exist but none have a SHA.
      // We cannot safely distinguish "implement committed" vs "external commit".
      // Safest: re-run implement for this turn.
      return { turn: highestN, skipImplement: false, skipVerify: false };
    }
  }

  if (headSha === lastRecordedSha) {
    // No commit happened in highestN yet; implement was killed (or never ran)
    return { turn: highestN, skipImplement: false, skipVerify: false };
  }

  const isAnc = await isAncestor(lastRecordedSha, headSha, cwd);
  if (!isAnc) {
    // HEAD has been rewritten or diverged — cannot safely resume
    // Note: drop "Cannot resume:" prefix here; the catch site in resumeCommand adds
    // "[Resume pre-check] Error:" context already (VI-11).
    throw new HeadDriftError(
      `HEAD (${headSha.slice(0, 8)}) is not a descendant of the last recorded commit (${lastRecordedSha.slice(0, 8)}). ` +
        `The branch history appears to have been rewritten or diverged. ` +
        `To recover: save any uncommitted work first with \`git stash\`, ` +
        `then \`git reset --hard ${lastRecordedSha}\`, then retry resume. ` +
        `Or start a fresh run with \`adversary run --plan <plan>\`.`
    );
  }

  const commits = await commitsBetween(lastRecordedSha, headSha, cwd);

  if (commits.length === 1) {
    // Exactly one new commit — implement+commit happened
    // Skip verify only if verify.json already exists (meaning verify completed too)
    // AND its recorded commitSha matches current HEAD (VI-1: amend detection).
    const verifyJsonPath = join(highestDir, "verify.json");
    let skipVerify = false;
    if (fileExists(verifyJsonPath)) {
      try {
        const verifyReport = await readJsonFile<VerifyReport>(verifyJsonPath);
        // If verify.json was written without a commitSha (older format), trust it.
        // If it has a commitSha, it must match current HEAD to be trusted.
        skipVerify = !verifyReport.commitSha || verifyReport.commitSha === headSha;
      } catch {
        // Corrupt verify.json — re-run verify
        skipVerify = false;
      }
    }
    return {
      turn: highestN,
      skipImplement: true,
      skipVerify,
      knownCommitSha: headSha,
    };
  } else {
    // Multiple new commits — too ambiguous to auto-resume; abort
    throw new Error(
      `Cannot resume: found ${commits.length} new commits since the last recorded commit (${lastRecordedSha.slice(0, 8)}). ` +
        `Only 0 or 1 new commits are safe to auto-resume. Reconcile manually.`
    );
  }
}
