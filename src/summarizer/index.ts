import { join } from "node:path";
import type { AdversaryConfig, SummarizerOutput, PrSummaryOutput } from "../types/index.js";
import { runStep } from "../runner/index.js";
import { generateCommitMessagePrompt, generatePrBodyPrompt } from "../prompts/index.js";
import { interpolate } from "../utils/slugify.js";

/**
 * Extract the first valid JSON object found in a string.
 * Handles cases where the agent outputs preamble text before/after the JSON,
 * including preamble that contains literal '{' characters.
 * Also handles escaped quotes inside JSON strings.
 */
export function extractJson(stdout: string): unknown {
  // Try each '{' position in the string until we find one that parses as valid JSON.
  let searchFrom = 0;

  while (true) {
    const start = stdout.indexOf("{", searchFrom);
    if (start === -1) {
      throw new Error("No JSON object found in output");
    }

    // Walk from 'start', balancing braces while respecting strings and escape sequences.
    let depth = 0;
    let inString = false;
    let escape = false;

    let foundClose = false;
    for (let i = start; i < stdout.length; i++) {
      const ch = stdout[i];

      if (escape) {
        // Any character after a backslash is consumed (the escape target), regardless of type.
        escape = false;
        continue;
      }

      if (inString) {
        if (ch === "\\") {
          // Next character is escaped — set flag so we skip it in the next iteration.
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      // Outside a string
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const jsonStr = stdout.slice(start, i + 1);
          try {
            return JSON.parse(jsonStr);
          } catch {
            // This candidate didn't parse — try the next '{' position.
            searchFrom = start + 1;
            foundClose = true;
            break;
          }
        }
      }
    }

    // If we exited the loop without closing the brace (unbalanced or parse failed),
    // advance past this '{' and try the next candidate.
    if (!foundClose) {
      searchFrom = start + 1;
    }
  }
}

export async function generateCommitMessage(options: {
  config: AdversaryConfig;
  turnDir: string;
  branch: string;
  planTitle: string;
  turn: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SummarizerOutput> {
  const { config, turnDir, branch, planTitle, turn, cwd, env } = options;

  const promptPath = join(turnDir, "commit-msg-prompt.md");
  await generateCommitMessagePrompt({ branch, planTitle, turn, outputPath: promptPath });

  const vars: Record<string, string> = {
    promptFile: promptPath,
    branch,
    baseBranch: "",
    cwd,
    turn: String(turn),
  };

  const command = interpolate(config.summarizerCommandTemplate, vars);

  const result = await runStep({
    command,
    cwd,
    stdoutPath: join(turnDir, "commit-msg-summarizer.stdout.log"),
    stderrPath: join(turnDir, "commit-msg-summarizer.stderr.log"),
    timeoutMs: config.summarizerTimeoutMs,
    label: `commit`,
    env,
  });

  if (!result.success) {
    throw new Error(
      `Summarizer command failed (exit ${result.exitCode}). See ${join(turnDir, "commit-msg-summarizer.stdout.log")} for details.`
    );
  }

  const stdoutText = await Bun.file(join(turnDir, "commit-msg-summarizer.stdout.log")).text();
  const parsed = extractJson(stdoutText) as Record<string, unknown>;

  if (typeof parsed.commitMessage !== "string" || parsed.commitMessage.trim() === "") {
    throw new Error(`Summarizer returned invalid commitMessage: ${JSON.stringify(parsed)}`);
  }

  const turnSummary = typeof parsed.turnSummary === "string" ? parsed.turnSummary : "";

  return { commitMessage: parsed.commitMessage as string, turnSummary };
}

export async function generatePrSummary(options: {
  config: AdversaryConfig;
  runDir: string;
  branch: string;
  baseBranch: string;
  planTitle: string;
  planContent: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PrSummaryOutput> {
  const { config, runDir, branch, baseBranch, planTitle, planContent, cwd, env } = options;

  const promptPath = join(runDir, "pr-summary-prompt.md");
  await generatePrBodyPrompt({ branch, baseBranch, planTitle, planContent, outputPath: promptPath });

  const vars: Record<string, string> = {
    promptFile: promptPath,
    branch,
    baseBranch,
    cwd,
  };

  const command = interpolate(config.summarizerCommandTemplate, vars);

  const result = await runStep({
    command,
    cwd,
    stdoutPath: join(runDir, "pr-summarizer.stdout.log"),
    stderrPath: join(runDir, "pr-summarizer.stderr.log"),
    timeoutMs: config.summarizerTimeoutMs,
    label: "pr-summary",
    env,
  });

  if (!result.success) {
    throw new Error(
      `PR summarizer command failed (exit ${result.exitCode}). See ${join(runDir, "pr-summarizer.stdout.log")} for details.`
    );
  }

  const stdoutText = await Bun.file(join(runDir, "pr-summarizer.stdout.log")).text();
  const parsed = extractJson(stdoutText) as Record<string, unknown>;

  if (typeof parsed.title !== "string") {
    throw new Error(`PR summarizer returned invalid title: ${JSON.stringify(parsed)}`);
  }
  if (typeof parsed.summary !== "string") {
    throw new Error(`PR summarizer returned invalid summary: ${JSON.stringify(parsed)}`);
  }
  if (typeof parsed.reviewerGuide !== "string") {
    throw new Error(`PR summarizer returned invalid reviewerGuide: ${JSON.stringify(parsed)}`);
  }
  if (typeof parsed.testPlan !== "string") {
    throw new Error(`PR summarizer returned invalid testPlan: ${JSON.stringify(parsed)}`);
  }
  if (parsed.issueNumber !== null && typeof parsed.issueNumber !== "number") {
    throw new Error(`PR summarizer returned invalid issueNumber: ${JSON.stringify(parsed)}`);
  }

  return parsed as unknown as PrSummaryOutput;
}
