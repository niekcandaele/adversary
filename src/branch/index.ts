import {
  detectBaseBranch,
  checkoutBranch,
  createAndCheckoutBranch,
  autoSuffixBranchName,
  branchExists,
} from "../git/index.js";
import { slugify, timestampCompact } from "../utils/slugify.js";

export interface BranchSetupResult {
  baseBranch: string;
  featureBranch: string;
}

export async function reattachBranch(cwd: string, branch: string): Promise<void> {
  if (!(await branchExists(branch, cwd))) {
    throw new Error(`Branch '${branch}' does not exist locally. Cannot resume — the feature branch is missing.`);
  }
  await checkoutBranch(branch, cwd);
}

export async function setupBranch(
  cwd: string,
  planSlug: string,
  overrideBase?: string
): Promise<BranchSetupResult> {
  // Resolve base branch
  const baseBranch = overrideBase ?? (await detectBaseBranch(cwd));

  // Checkout base branch
  await checkoutBranch(baseBranch, cwd);

  // Generate feature branch name
  const ts = timestampCompact();
  const rawName = `adversary/${ts}-${slugify(planSlug)}`;
  const featureBranch = await autoSuffixBranchName(rawName, cwd);

  // Create and checkout
  await createAndCheckoutBranch(featureBranch, cwd);

  return { baseBranch, featureBranch };
}
