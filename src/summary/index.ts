import { join, relative, basename } from "node:path";
import { homedir } from "node:os";
import type { RunState, VerifyFinding, RunOutcome, PrSummaryOutput } from "../types/index.js";
import { writeText, writeJsonFile } from "../utils/fs.js";
import { formatDuration } from "../utils/slugify.js";

/** Replace home directory prefix with `~` for display in PR body. */
function sanitizePath(p: string): string {
  const home = homedir();
  if (p.startsWith(home + "/") || p === home) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/** Make planFile relative to cwd for display; fall back to sanitized absolute. */
function displayPlanFile(planFile: string, cwd: string): string {
  try {
    const rel = relative(cwd, planFile);
    // Only use relative if it doesn't escape cwd at all
    if (!rel.startsWith("../")) {
      // Guard against empty string when planFile === cwd (directory-like path)
      return rel || basename(planFile);
    }
  } catch {
    // fall through
  }
  return sanitizePath(planFile);
}

function findingsMd(findings: VerifyFinding[], heading: string): string {
  if (findings.length === 0) return `### ${heading}\n\n_None._\n`;
  const items = findings.map((f, i) => {
    const loc = f.location
      ? `\n  - **Location:** \`${f.location.path}\`${f.location.line ? `:${f.location.line}` : ""}`
      : "";
    const sources = f.sources.length > 0 ? `\n  - **Sources:** ${f.sources.join(", ")}` : "";
    return `${i + 1}. **${f.title}** (severity ${f.severity})${loc}${sources}\n\n   ${f.description}`;
  });
  return `### ${heading}\n\n${items.join("\n\n---\n\n")}\n`;
}

function outcomeLabel(outcome: RunOutcome | undefined): string {
  switch (outcome) {
    case "clean": return "✓ Clean — zero threshold findings";
    case "capped": return "⚠ Capped — max turns reached with findings remaining";
    case "implement-failure": return "✗ Stopped — implementer step failed";
    case "summarizer-failure": return "✗ Stopped — summarizer step failed";
    case "verify-failure": return "✗ Stopped — verifier step failed";
    case "verify-blocked": return "✗ Stopped — verifier returned blocked status";
    case "verify-error": return "✗ Stopped — verifier returned error status";
    case "preflight-failure": return "✗ Stopped — preflight check failed";
    default: return "Unknown outcome";
  }
}

export async function generateFinalSummary(state: RunState, threshold: number): Promise<void> {
  const allThreshold: VerifyFinding[] = [];
  const allBelow: VerifyFinding[] = [];

  // Use findings from last turn
  const lastTurnEntry = state.turns.length > 0 ? state.turns[state.turns.length - 1] : undefined;
  if (lastTurnEntry) {
    allThreshold.push(...lastTurnEntry.thresholdFindings);
    allBelow.push(...lastTurnEntry.belowThresholdFindings);
  }

  const totalDurationMs = state.turns.reduce(
    (sum, t) => sum + t.implementDurationMs + t.verifyDurationMs,
    0
  );

  // planFile and runDir are embedded as-is below — unsanitized local artifacts, not public-facing
  const md = `# Adversary Run Summary

## Overview

| Field | Value |
|-------|-------|
| Plan | \`${state.planFile}\` |
| Plan Title | ${state.planTitle} |
| Branch | \`${state.branch}\` |
| Base Branch | \`${state.baseBranch}\` |
| Started | ${state.startedAt} |
| Turns Attempted | ${state.turns.length} |
| Severity Threshold | ${threshold} |
| Outcome | ${outcomeLabel(state.outcome)} |
| Total Duration | ${formatDuration(totalDurationMs)} |
${state.prUrl ? `| PR/MR | ${state.prUrl} |` : state.prError ? `| PR/MR Error | ${state.prError} |` : ""}

---

## Turn History

${state.turns.length === 0 ? "_No turns completed._" : state.turns.map((t) => `### Turn ${t.turn}

- Implement: ${formatDuration(t.implementDurationMs)} (exit: ${t.outcome === "implement-failure" ? "failed" : "ok"})
- Verify: ${formatDuration(t.verifyDurationMs)} | status: \`${t.verifyStatus}\`
- Repo changed: ${t.repoChanged ? "yes" : "no"}${t.commitSha ? ` (commit: \`${t.commitSha.slice(0, 8)}\`)` : ""}
- Threshold findings: ${t.thresholdFindings.length}
- Below-threshold findings: ${t.belowThresholdFindings.length}
- Outcome: \`${t.outcome}\``).join("\n\n")}

---

${findingsMd(allThreshold, `Threshold Findings (severity >= ${threshold})`)}

${findingsMd(allBelow, `Below-Threshold Findings (severity < ${threshold})`)}

---

## Artifacts

Run artifacts are stored at: \`${state.runDir}\`
`;

  await writeText(join(state.runDir, "final-summary.md"), md);

  const json = {
    schemaVersion: 1,
    planFile: state.planFile,
    planTitle: state.planTitle,
    branch: state.branch,
    baseBranch: state.baseBranch,
    startedAt: state.startedAt,
    turnsAttempted: state.turns.length,
    threshold,
    outcome: state.outcome,
    totalDurationMs,
    prUrl: state.prUrl,
    prError: state.prError,
    turns: state.turns,
    thresholdFindings: allThreshold,
    belowThresholdFindings: allBelow,
    runDir: state.runDir,
  };

  await writeJsonFile(join(state.runDir, "final-summary.json"), json);
}

/**
 * Assemble a rich PR body by stitching LLM-generated sections with deterministic metadata.
 */
export function assemblePrBody(state: RunState, threshold: number, llm: PrSummaryOutput, cwd: string = process.cwd()): string {
  const allThreshold: VerifyFinding[] = [];
  const allBelow: VerifyFinding[] = [];
  const lastTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1] : undefined;
  if (lastTurn) {
    allThreshold.push(...lastTurn.thresholdFindings);
    allBelow.push(...lastTurn.belowThresholdFindings);
  }

  const issueLink = llm.issueNumber != null ? `\nCloses #${llm.issueNumber}\n` : "";

  const thresholdSection =
    allThreshold.length === 0
      ? "_None._"
      : allThreshold
          .map((f) => `- **${f.title}** (severity ${f.severity}): ${f.description}`)
          .join("\n");

  const belowSection =
    allBelow.length === 0
      ? "_None._"
      : allBelow
          .map((f) => `- **${f.title}** (severity ${f.severity}): ${f.description}`)
          .join("\n");

  return `> ⚠️ This PR was created automatically by the adversary orchestrator. Do not merge without human review.

## Summary
${issueLink}
${llm.summary}

## Reviewer Guide

${llm.reviewerGuide}

## Test Plan

${llm.testPlan}

<details>
<summary>Orchestration metadata</summary>

| Field | Value |
|-------|-------|
| Plan | \`${displayPlanFile(state.planFile, cwd)}\` |
| Branch | \`${state.branch}\` |
| Base | \`${state.baseBranch}\` |
| Turns | ${state.turns.length} |
| Threshold | ${threshold} |
| Outcome | ${outcomeLabel(state.outcome)} |

### Threshold Findings (severity >= ${threshold})

${thresholdSection}

### Below-Threshold Findings (severity < ${threshold})

${belowSection}

Artifacts: \`${sanitizePath(state.runDir)}\`

</details>
`;
}

