import type { VerifyFinding, TurnResult } from "../types/index.js";
import { formatDuration } from "../utils/slugify.js";
import { writeText } from "../utils/fs.js";
import { join } from "node:path";

export async function generateCommitMessagePrompt(options: {
  branch: string;
  planTitle: string;
  turn: number;
  outputPath: string;
}): Promise<string> {
  const { branch, planTitle, turn, outputPath } = options;

  const content = `# Commit Message Generator

## Task
Generate a concise, meaningful git commit message for the changes made on this branch.

## Context
- Branch: \`${branch}\`
- Plan title: ${planTitle}
- Turn number: ${turn}

## Instructions
1. Explore the pending working-tree changes (these are about to be committed):
   - Run \`git status --short\` to see which files have pending changes
   - Run \`git diff HEAD --stat\` to see what files changed
   - Run \`git diff HEAD\` to see the actual diff (summarize, don't read all of it if large)
2. Write a commit message:
   - Subject line: max 72 characters, imperative mood (e.g. "Add", "Fix", "Refactor")
   - Optional body: explain why, not what (wrap at 72 chars)
   - Do NOT include metadata like "adversary: turn N" — write a genuine description of the work
3. Return ONLY a JSON object (no other text):
   \`\`\`json
   { "commitMessage": "Subject line\\n\\nOptional body paragraph." }
   \`\`\`

Return only the JSON object.
`;

  await writeText(outputPath, content);
  return content;
}

export async function generatePrBodyPrompt(options: {
  branch: string;
  baseBranch: string;
  planTitle: string;
  planContent: string;
  outputPath: string;
}): Promise<string> {
  const { branch, baseBranch, planTitle, planContent, outputPath } = options;

  const content = `# PR Description Generator

## Task
Generate a rich, reviewer-friendly pull request title and description for the changes on this branch.

## Context
- Branch: \`${branch}\`
- Base branch: \`${baseBranch}\`
- Plan title: ${planTitle}

## Instructions
1. Explore all changes on this branch vs the base branch:
   - Run \`git log ${baseBranch}..HEAD --oneline\` to see all commits
   - Run \`git diff ${baseBranch}...HEAD --stat\` to see what files changed
   - Run \`git diff ${baseBranch}...HEAD\` to understand the actual changes (sample if large)
2. Read the plan content below for context on "why" this work was done
3. Generate the PR description with these sections:
   - **title**: A short, freeform PR title (NOT "adversary: ...") — describes what was done
   - **summary**: 2-5 bullet points covering what changed and why
   - **reviewerGuide**: Where to start reviewing, what patterns to look for, gotchas
   - **testPlan**: What tests exist, how to run them, what to manually verify
   - **issueNumber**: Any GitHub/GitLab issue number referenced in the plan (null if none)
4. Return ONLY a JSON object (no other text):
   \`\`\`json
   {
     "title": "Brief, descriptive PR title",
     "summary": "- Bullet 1\\n- Bullet 2\\n- Bullet 3",
     "reviewerGuide": "Start by reading X, then look at Y...",
     "testPlan": "Run \`bun test\`. New tests in tests/foo.test.ts cover...",
     "issueNumber": 42
   }
   \`\`\`

## Plan Content

${planContent}

Return only the JSON object.
`;

  await writeText(outputPath, content);
  return content;
}

export async function generateFirstTurnPrompt(options: {
  planContent: string;
  threshold: number;
  turn: number;
  maxTurns: number;
  branch: string;
  outputPath: string;
}): Promise<string> {
  const { planContent, threshold, turn, maxTurns, branch, outputPath } = options;

  const content = `# Adversarial Implementation Loop — Turn ${turn} of ${maxTurns}

## Your Role
You are the **implementer** in an adversarial implement→verify loop.
Your job is to implement the plan below so that a subsequent verification step finds **zero findings with severity >= ${threshold}**.

## Instructions
- Implement the plan proactively and thoroughly.
- Anticipate what the verifier will check: correctness, tests, edge cases, error handling, documentation.
- **Do NOT manage git yourself.** The orchestrator handles all git operations.
- **Do NOT run the verify skill.** A separate verify step will run after you finish.
- Focus on making the implementation complete and production-quality.

## Branch
You are on branch: \`${branch}\`

## Severity Threshold
Threshold: **${threshold}** (findings with severity >= ${threshold} will block the loop)

---

## Plan

${planContent}
`;

  await writeText(outputPath, content);
  return content;
}

export async function generateLaterTurnPrompt(options: {
  planContent: string;
  threshold: number;
  turn: number;
  maxTurns: number;
  branch: string;
  thresholdFindings: VerifyFinding[];
  historyContent: string;
  outputPath: string;
}): Promise<string> {
  const { planContent, threshold, turn, maxTurns, branch, thresholdFindings, historyContent, outputPath } = options;

  const findingsMd = thresholdFindings.length > 0
    ? thresholdFindings
        .map((f, i) => {
          const loc = f.location
            ? `\n  **Location:** \`${f.location.path}\`${f.location.line ? `:${f.location.line}` : ""}${f.location.column ? `:${f.location.column}` : ""}`
            : "";
          const sources = f.sources.length > 0 ? `\n  **Sources:** ${f.sources.join(", ")}` : "";
          return `### Finding ${i + 1}: ${f.title} (severity ${f.severity})${loc}${sources}\n\n${f.description}`;
        })
        .join("\n\n---\n\n")
    : "_No threshold findings._";

  const content = `# Adversarial Implementation Loop — Turn ${turn} of ${maxTurns}

## Your Role
You are the **implementer** in an adversarial implement→verify loop.
Your job is to address the verification findings below so that a subsequent verification step finds **zero findings with severity >= ${threshold}**.

## Instructions
- Focus exclusively on fixing the findings listed below that meet the threshold.
- Refer to the original plan to ensure your fixes remain consistent with the intended design.
- **Do NOT manage git yourself.** The orchestrator handles all git operations.
- **Do NOT run the verify skill.** A separate verify step will run after you finish.
- Do not break existing passing tests while fixing findings.

## Branch
You are on branch: \`${branch}\`

## Severity Threshold
Threshold: **${threshold}** (you must fix findings with severity >= ${threshold})

---

## Current Findings to Fix (severity >= ${threshold})

${findingsMd}

---

## Run History

${historyContent}

---

## Original Plan

${planContent}
`;

  await writeText(outputPath, content);
  return content;
}

export async function generateFindingsFile(
  findings: VerifyFinding[],
  threshold: number,
  outputPath: string
): Promise<void> {
  if (findings.length === 0) {
    await writeText(outputPath, `_No findings with severity >= ${threshold}._\n`);
    return;
  }

  const lines = findings.map((f, i) => {
    const loc = f.location
      ? `\n  - Location: \`${f.location.path}\`${f.location.line ? `:${f.location.line}` : ""}`
      : "";
    const sources = f.sources.length > 0 ? `\n  - Sources: ${f.sources.join(", ")}` : "";
    return `${i + 1}. **${f.title}** (severity ${f.severity})${loc}${sources}\n   ${f.description}`;
  });

  await writeText(outputPath, `# Findings (severity >= ${threshold})\n\n${lines.join("\n\n")}\n`);
}

export async function generateHistoryFile(
  turns: TurnResult[],
  outputPath: string
): Promise<void> {
  if (turns.length === 0) {
    await writeText(outputPath, "_No previous turns._\n");
    return;
  }

  const sections = turns.map((t) => {
    const thresholdSummary =
      t.thresholdFindings.length === 0
        ? "✓ Zero threshold findings"
        : `${t.thresholdFindings.length} threshold finding(s): ${t.thresholdFindings.map((f) => `${f.title} (sev ${f.severity})`).join(", ")}`;

    const belowSummary =
      t.belowThresholdFindings.length === 0
        ? "None"
        : t.belowThresholdFindings.map((f) => `${f.title} (sev ${f.severity})`).join(", ");

    return `## Turn ${t.turn}
- Implement duration: ${formatDuration(t.implementDurationMs)}
- Verify duration: ${formatDuration(t.verifyDurationMs)}
- Repo changed: ${t.repoChanged ? "yes" : "no"}${t.commitSha ? ` (commit: ${t.commitSha.slice(0, 8)})` : ""}
- Verify status: ${t.verifyStatus}
- Threshold findings: ${thresholdSummary}
- Below-threshold findings: ${belowSummary}
- Outcome: ${t.outcome}`;
  });

  await writeText(outputPath, `# Run History\n\n${sections.join("\n\n")}\n`);
}
