import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export function getGlobalConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome ?? join(homedir(), ".config");
  return join(configHome, "adversary", "config.json");
}

const gitRootCache = new Map<string, string>();

export function clearGitRootCache(): void {
  gitRootCache.clear();
}

export function resolveGitRoot(cwd: string): string {
  const cached = gitRootCache.get(cwd);
  if (cached !== undefined) return cached;

  let result: string;
  try {
    const spawnResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    result = spawnResult.status === 0 && spawnResult.stdout ? spawnResult.stdout.trim() : cwd;
  } catch {
    result = cwd;
  }

  gitRootCache.set(cwd, result);
  return result;
}

export function getStateDir(cwd: string): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  const stateHome = xdgStateHome ?? join(homedir(), ".local", "state");
  const repoRoot = resolveGitRoot(cwd);
  const name = basename(repoRoot) || "root";
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
  return join(stateHome, "adversary", `${name}-${hash}`);
}
