// ── Skill types ──────────────────────────────────────────────────────────────

export type BuiltinSkillName =
  | "reviewer"
  | "qa"
  | "ux-reviewer"
  | "exerciser"
  | "plan-completeness";

export type BrowserAutomationMode = "warn" | "require" | "skip";

export type VerificationStepPhase = "parallel-review" | "deterministic";
export type DeterministicStepKind = "test" | "build" | "lint" | "typecheck";

export interface CustomVerificationStep {
  name: string;
  commandTemplate: string;
  phase: VerificationStepPhase;
  timeoutMs?: number;
  kind?: DeterministicStepKind;
}

export interface SkillOverride {
  extraContext?: string; // append to vendored prompt
  promptFile?: string; // full replacement
  // mutually exclusive — error if both present
}

export interface SkillResult {
  skill: string;
  exitCode: number;
  durationMs: number;
  findings: VerifyFinding[];
  status: "completed" | "error" | "timeout";
  artifactDir?: string;
}

export interface VerifyScope {
  baseBranch: string;
  mergeBase: string;
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
  }>;
  diffCommand: string;
  diffStat: string;
}

export interface ToolchainDiscovery {
  testCommand: string | null;
  buildCommand: string | null;
  lintCommands: string[];
  typeCheckCommands: string[];
  startCommand: string | null;
  stopCommand: string | null;
  browserDeps: string[];
}

// ── Verify JSON contract ─────────────────────────────────────────────────────

/**
 * Status of a verify run.
 * - "ok": verification completed and produced a usable findings report
 * - "error": the verification framework itself failed to produce a reliable report
 * - "skipped": verification did not run (implement/summarizer/commit failure before verify step)
 */
export type VerifyStatus = "ok" | "error" | "skipped";

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
  /**
   * The HEAD commit SHA at the time this verify report was produced.
   * Used on resume to detect if the commit has been amended or replaced
   * since verification ran, in which case we must re-verify.
   */
  commitSha?: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface AdversaryConfig {
  baseBranch?: string;
  implementCommandTemplate: string;
  verifyCommandTemplate: string;
  summarizerCommandTemplate: string;
  implementTimeoutMs: number;
  verifyTimeoutMs: number;
  testTimeoutMs: number;
  prTimeoutMs: number;
  summarizerTimeoutMs: number;
  /**
   * Timeout for startCommand and stopCommand (service lifecycle commands).
   * Defaults to 300000ms (5 minutes). Even if a user provides a bad command,
   * it fails fast rather than hanging for the full verifyTimeoutMs.
   */
  servicesTimeoutMs: number;
  browserAutomation: BrowserAutomationMode;
  customVerificationSteps: CustomVerificationStep[];
  skillOverrides: Record<string, SkillOverride>;
}

export const DEFAULT_CONFIG: AdversaryConfig = {
  implementCommandTemplate: "pi -p @{promptFile}",
  verifyCommandTemplate: "pi -p @{promptFile}",
  summarizerCommandTemplate: "pi -p @{promptFile}",
  implementTimeoutMs: 10800000,
  verifyTimeoutMs: 900000,
  testTimeoutMs: 3600000,
  prTimeoutMs: 300000,
  summarizerTimeoutMs: 300000,
  servicesTimeoutMs: 300000,
  browserAutomation: "warn",
  customVerificationSteps: [],
  skillOverrides: {},
};

// ── Summarizer output types ───────────────────────────────────────────────────

export interface SummarizerOutput {
  commitMessage: string;
  turnSummary: string;
}

export interface PrSummaryOutput {
  title: string;
  summary: string;
  reviewerGuide: string;
  testPlan: string;
  issueNumber: number | null;
}

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
  | "commit-failure"
  | "implement-failure"
  | "summarizer-failure"
  | "verify-failure"
  | "verify-error"
  | "push-failure"
  | "services-start-failure";

/**
 * Returns human-readable labels for a RunOutcome.
 * Single source of truth shared across CLI and summary modules.
 *
 * The `kind` field drives `isFailureOutcome` — adding a new RunOutcome forces
 * a new entry here (enforced by `satisfies`), so completeness is compile-checked.
 */
export function getOutcomeLabels(outcome: RunOutcome): { humanizedSentence: string; summaryLabel: string; kind: "success" | "failure" | "incomplete" } {
  const labels = {
    "clean":                   { humanizedSentence: "all findings resolved",                   summaryLabel: "✓ Clean — zero threshold findings",                        kind: "success"    as const },
    "capped":                  { humanizedSentence: "maximum turns reached with findings remaining", summaryLabel: "⚠ Capped — max turns reached with findings remaining", kind: "incomplete" as const },
    "implement-failure":       { humanizedSentence: "the implementer subprocess failed",        summaryLabel: "✗ Stopped — implementer step failed",                      kind: "failure"    as const },
    "summarizer-failure":      { humanizedSentence: "the commit-message summarizer failed",     summaryLabel: "✗ Stopped — summarizer step failed",                       kind: "failure"    as const },
    "verify-failure":          { humanizedSentence: "the verification pipeline failed",         summaryLabel: "✗ Stopped — verifier step failed",                         kind: "failure"    as const },
    "verify-error":            { humanizedSentence: "the verification pipeline returned an error status", summaryLabel: "✗ Stopped — verifier returned error status",     kind: "failure"    as const },
    "commit-failure":          { humanizedSentence: "a pre-commit hook or git commit operation failed", summaryLabel: "✗ Stopped — commit step failed",                  kind: "failure"    as const },
    "push-failure":            { humanizedSentence: "push to remote failed",                    summaryLabel: "✗ Stopped — push to remote failed",                        kind: "failure"    as const },
    "services-start-failure":  { humanizedSentence: "the services start command failed",        summaryLabel: "✗ Stopped — services start step failed",                   kind: "failure"    as const },
  } satisfies Record<RunOutcome, { humanizedSentence: string; summaryLabel: string; kind: "success" | "failure" | "incomplete" }>;
  return labels[outcome];
}

export interface TurnResult {
  turn: number;
  implementCommand: string;
  verifyCommand: string;
  implementDurationMs: number;
  verifyDurationMs: number;
  repoChanged: boolean;
  commitSha?: string;
  commitMessage?: string;
  commitError?: string;
  turnSummary?: string;
  verifyStatus: VerifyStatus;
  thresholdFindings: VerifyFinding[];
  belowThresholdFindings: VerifyFinding[];
  /**
   * Per-turn outcome for this specific turn's iteration.
   * This is distinct from RunOutcome (RunState.outcome), which represents the final
   * outcome of the entire run. TurnResult.outcome includes "continue" (meaning the loop
   * will proceed to the next turn), whereas RunOutcome only covers terminal states.
   * When the loop ends, RunState.outcome is set from the last TurnResult.outcome that
   * maps to a terminal state (e.g. "clean", "capped", etc.).
   */
  outcome: "continue" | "clean" | "capped" | "commit-failure" | "implement-failure" | "summarizer-failure" | "verify-failure" | "verify-error" | "services-start-failure";
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

// ── Resume types ─────────────────────────────────────────────────────────────

export interface ResumePoint {
  turn: number;
  skipImplement: boolean;
  skipVerify: boolean;
  knownCommitSha?: string;
  /** True when user chose "keep" dirty tree on resume — triggers resume note in prompt */
  resumeNote?: boolean;
  /** True when the highest turn already reached a terminal outcome (clean/capped) — skip the loop entirely */
  skipLoop?: boolean;
  /**
   * True when resume needs to extend maxTurns by 1 to re-verify extra commits added
   * after the last completed turn (VI-6). The loop will allow startTurn === maxTurns + 1.
   */
  extendForResume?: boolean;
}

export interface DoneFlag {
  outcome: RunOutcome;
  completedAt: string;
  prUrl?: string;
}

export interface RunInfo {
  runId: string;
  runDir: string;
  startedAt: string;
  completed: boolean;
  outcome?: RunOutcome;
}

export interface ResumeOptions {
  runId?: string;
  configFile?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * When true, skip the terminal-failure confirmation prompt (like --yes / -y flag).
   * Does NOT bypass the dirty-tree prompt (that requires user judgement).
   */
  yes?: boolean;
  /**
   * Injectable deps for promptConfirmSync — for testing.
   * If provided, bypasses the real stdin reader.
   */
  confirmDeps?: { isTTY: boolean; readLine: () => string };
  /**
   * Injectable deps for dirty-tree prompts (promptDirtyTreeSync / promptDirtyTreeSyncSkipImplement).
   * If provided, bypasses the real stdin reader in those prompts.
   */
  dirtyTreeDeps?: { readLine: () => string };
}

export interface SavedRunConfig {
  planFile: string;
  planTitle: string;
  branch: string;
  baseBranch: string;
  startedAt: string;
  turns: number;
  threshold: number;
  config: AdversaryConfig;
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
  /**
   * @deprecated The verification pipeline now writes verify.json internally via
   * runVerification(). This variable is retained in TemplateVars for backward
   * compatibility with custom verifyCommandTemplate setups that reference it, but
   * it is NOT used by the built-in multi-skill verification orchestrator.
   * Custom setups that invoke a single verify command via verifyCommandTemplate can
   * still use {verifyOutputFile} to know where to write their output.
   */
  verifyOutputFile: string;
  threshold: string;
  turn: string;
  maxTurns: string;
  branch: string;
  [key: string]: string;
}
