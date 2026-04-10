import type { VerifyFinding, TurnResult } from "../types/index.js";
import { formatDuration } from "../utils/slugify.js";
import { writeText } from "../utils/fs.js";
import { join } from "node:path";

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
