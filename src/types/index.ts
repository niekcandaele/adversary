// ── Verify JSON contract ─────────────────────────────────────────────────────

export type VerifyStatus = "ok" | "blocked" | "error";

export interface VerifyLocation {
  path: string;
  line?: number;
  column?: number;
}

export interface VerifyFinding {
  title: string;
  severity: number; // 1..10
  location?: VerifyLocation;
  description: string;
  sources: string[];
}

export interface VerifyReport {
  schemaVersion: 1;
  status: VerifyStatus;
  findings: VerifyFinding[];
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface AdversaryConfig {
  baseBranch?: string;
  implementCommandTemplate: string;
  verifyCommandTemplate: string;
  implementTimeoutMs: number;
  verifyTimeoutMs: number;
  prTimeoutMs: number;
}

export const DEFAULT_CONFIG: AdversaryConfig = {
  implementCommandTemplate: "pi -p @{promptFile}",
  verifyCommandTemplate:
    'pi -p "/skill:verify --mode=report-only --format=json --output={verifyOutputFile}"',
  implementTimeoutMs: 2700000,
  verifyTimeoutMs: 5400000,
  prTimeoutMs: 300000,
};

// ── CLI options ──────────────────────────────────────────────────────────────

export interface RunOptions {
  plan: string;
  turns: number;
  severityThreshold: number;
  baseBranch?: string;
  configFile?: string;
  /**
   * Override the working directory. If omitted, process.cwd() is used.
   * Useful in tests to avoid calling process.chdir() which mutates global state.
   */
  cwd?: string;
  /**
   * Override process.env for spawned subprocesses (preflight command checks, etc.).
   * If omitted, process.env is inherited. Useful in tests to avoid mutating process.env.PATH.
   */
  env?: NodeJS.ProcessEnv;
}

// ── Runtime state ────────────────────────────────────────────────────────────

export type RunOutcome =
  | "clean"
  | "capped"
  | "implement-failure"
  | "verify-failure"
  | "verify-blocked"
  | "verify-error"
  | "preflight-failure";

export interface TurnResult {
  turn: number;
  implementCommand: string;
  verifyCommand: string;
  implementDurationMs: number;
  verifyDurationMs: number;
  repoChanged: boolean;
  commitSha?: string;
  verifyStatus: VerifyStatus;
  thresholdFindings: VerifyFinding[];
  belowThresholdFindings: VerifyFinding[];
  outcome: "continue" | "clean" | "capped" | "implement-failure" | "verify-failure" | "verify-blocked" | "verify-error";
}

export interface RunState {
  runDir: string;
  planFile: string;
  planTitle: string;
  branch: string;
  baseBranch: string;
  startedAt: string;
  turns: TurnResult[];
  outcome?: RunOutcome;
  prUrl?: string;
  prError?: string;
}

// ── Process runner ───────────────────────────────────────────────────────────

export interface StepResult {
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  success: boolean;
  timedOut: boolean;
}

// ── Template vars ────────────────────────────────────────────────────────────

export interface TemplateVars {
  cwd: string;
  planFile: string;
  promptFile: string;
  findingsFile: string;
  historyFile: string;
  verifyOutputFile: string;
  threshold: string;
  turn: string;
  maxTurns: string;
  branch: string;
  [key: string]: string;
}
