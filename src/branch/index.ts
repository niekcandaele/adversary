import {
  detectBaseBranch,
  checkoutBranch,
  createAndCheckoutBranch,
  autoSuffixBranchName,
} from "../git/index.js";
import { slugify, timestampCompact } from "../utils/slugify.js";

export interface BranchSetupResult {
  baseBranch: string;
  featureBranch: string;
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
