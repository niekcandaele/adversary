import type { VerifyScope } from "../types/index.js";

/**
 * Detect the verification scope deterministically using git commands.
 * No LLM involved — pure TypeScript.
 */
export async function detectScope(cwd: string, baseBranch: string): Promise<VerifyScope> {
  // Get merge base
  const mergeBaseProc = Bun.spawn(["git", "merge-base", baseBranch, "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const mergeBaseExit = await mergeBaseProc.exited;
  const mergeBase = (await new Response(mergeBaseProc.stdout).text()).trim();

  if (mergeBaseExit !== 0 || !mergeBase) {
    const stderr = (await new Response(mergeBaseProc.stderr).text()).trim();
    throw new Error(
      `git merge-base ${baseBranch} HEAD failed (exit ${mergeBaseExit}): ${stderr || "no output"}. ` +
      `Is the branch history valid and does "${baseBranch}" exist?`
    );
  }

  const diffCommand = `git diff --name-status ${mergeBase}...HEAD`;

  // Get changed files
  const nameStatusProc = Bun.spawn(
    ["git", "diff", "--name-status", `${mergeBase}...HEAD`],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const nameStatusExit = await nameStatusProc.exited;
  if (nameStatusExit !== 0) {
    const stderr = (await new Response(nameStatusProc.stderr).text()).trim();
    throw new Error(
      `git diff --name-status ${mergeBase}...HEAD failed (exit ${nameStatusExit}): ${stderr || "no output"}`
    );
  }
  const nameStatusOutput = (await new Response(nameStatusProc.stdout).text()).trim();

  const files = parseNameStatus(nameStatusOutput);

  // Get diff stat
  const diffStatProc = Bun.spawn(
    ["git", "diff", "--stat", `${mergeBase}...HEAD`],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const diffStatExit = await diffStatProc.exited;
  if (diffStatExit !== 0) {
    const stderr = (await new Response(diffStatProc.stderr).text()).trim();
    throw new Error(
      `git diff --stat ${mergeBase}...HEAD failed (exit ${diffStatExit}): ${stderr || "no output"}`
    );
  }
  const diffStat = (await new Response(diffStatProc.stdout).text()).trim();

  return {
    baseBranch,
    mergeBase,
    files,
    diffCommand,
    diffStat,
  };
}

function parseNameStatus(
  output: string
): Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed" }> {
  if (!output) return [];

  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split("\t");
      const statusCode = parts[0] ?? "";
      const filePath = parts[parts.length - 1] ?? "";

      let status: "added" | "modified" | "deleted" | "renamed";
      if (statusCode.startsWith("A")) {
        status = "added";
      } else if (statusCode.startsWith("M")) {
        status = "modified";
      } else if (statusCode.startsWith("D")) {
        status = "deleted";
      } else if (statusCode.startsWith("R")) {
        status = "renamed";
      } else {
        // Default for C (copy), T (type change), etc.
        status = "modified";
      }

      return { path: filePath, status };
    });
}

/**
 * Build a human-readable scope context string for injection into prompts.
 */
export function buildScopeContext(scope: VerifyScope): string {
  if (scope.files.length === 0) {
    return "No files changed in scope.";
  }

  const lines = [
    `Changed files (${scope.files.length} total):`,
    ...scope.files.map((f) => `  [${f.status.toUpperCase()}] ${f.path}`),
  ];

  return lines.join("\n");
}

/**
 * Build a machine-readable metadata block for injection into prompts.
 */
export function buildScopeMetadata(scope: VerifyScope): string {
  return [
    `Base branch: ${scope.baseBranch}`,
    `Merge base: ${scope.mergeBase}`,
    `Diff command: ${scope.diffCommand}`,
  ].join("\n");
}
