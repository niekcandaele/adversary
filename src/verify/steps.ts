import { join } from "node:path";
import type { ToolchainDiscovery, VerifyScope } from "../types/index.js";
import { ensureDir, writeText } from "../utils/fs.js";

const TRUNCATED_HEAD_LINES = 120;
const TRUNCATED_TAIL_LINES = 120;

export async function ensureStepDir(verifyDir: string, stepName: string): Promise<string> {
  const stepDir = join(verifyDir, "steps", stepName);
  await ensureDir(stepDir);
  return stepDir;
}

export async function writeBranchContextFile(options: {
  verifyDir: string;
  planFile: string;
  scope: VerifyScope;
  discovery: ToolchainDiscovery;
  repoGuidance?: string;
}): Promise<string> {
  const { verifyDir, planFile, scope, discovery, repoGuidance = "" } = options;
  const contextPath = join(verifyDir, "branch-context.txt");
  const changedFiles = scope.files.length > 0
    ? scope.files.map((file) => `- ${file.status}: ${file.path}`).join("\n")
    : "- No changed files detected";

  const repoGuidanceSection = repoGuidance.trim().length > 0
    ? [
        "",
        "## Repo guidance",
        "",
        repoGuidance,
      ]
    : [];

  const content = [
    "# Branch Verification Context",
    "",
    "Verification is branch-wide. Changed-files metadata below is supporting context only.",
    "",
    `Plan file: ${planFile}`,
    `Base branch: ${scope.baseBranch}`,
    `Merge base: ${scope.mergeBase}`,
    `Diff command: ${scope.diffCommand}`,
    "",
    "## Diff stat",
    "",
    scope.diffStat || "(no diff stat available)",
    "",
    "## Changed files (informational only)",
    "",
    changedFiles,
    "",
    "## Discovery metadata",
    "",
    JSON.stringify(discovery, null, 2),
    ...repoGuidanceSection,
  ].join("\n");

  await writeText(contextPath, content);
  return contextPath;
}

export async function writeStepContextFile(options: {
  stepDir: string;
  branchContextFile: string;
  planFile: string;
  planContent: string;
  extraSections?: Array<{ title: string; body: string }>;
}): Promise<string> {
  const { stepDir, branchContextFile, planFile, planContent, extraSections = [] } = options;
  const contextPath = join(stepDir, "context.txt");
  const sections = [
    "# Step Context",
    "",
    `Branch context file: ${branchContextFile}`,
    `Plan file: ${planFile}`,
    "",
    "## Plan content",
    "",
    planContent,
    ...extraSections.flatMap((section) => ["", `## ${section.title}`, "", section.body]),
  ];
  await writeText(contextPath, sections.join("\n"));
  return contextPath;
}

export async function writeTruncatedHelperArtifacts(options: {
  stepDir: string;
  stdoutText: string;
  stderrText: string;
}): Promise<{ stdoutTruncatedPath: string; stderrTruncatedPath: string }> {
  const { stepDir, stdoutText, stderrText } = options;
  const stdoutTruncatedPath = join(stepDir, "stdout.truncated.log");
  const stderrTruncatedPath = join(stepDir, "stderr.truncated.log");
  await writeText(stdoutTruncatedPath, truncateForHelperArtifact(stdoutText));
  await writeText(stderrTruncatedPath, truncateForHelperArtifact(stderrText));
  return { stdoutTruncatedPath, stderrTruncatedPath };
}

function truncateForHelperArtifact(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= TRUNCATED_HEAD_LINES + TRUNCATED_TAIL_LINES) {
    return text;
  }

  const head = lines.slice(0, TRUNCATED_HEAD_LINES).join("\n");
  const tail = lines.slice(-TRUNCATED_TAIL_LINES).join("\n");
  const omittedCount = lines.length - TRUNCATED_HEAD_LINES - TRUNCATED_TAIL_LINES;
  return [
    head,
    "",
    `... truncated ${omittedCount} line(s) ...`,
    "",
    tail,
  ].join("\n");
}
