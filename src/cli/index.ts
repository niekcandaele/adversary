import { runCommand } from "./run.js";
import { configCommand } from "./config.js";
import type { RunOptions } from "../types/index.js";
import { VERSION } from "../generated/version.js";

const KNOWN_FLAGS = new Set([
  "plan",
  "turns",
  "severity-threshold",
  "base-branch",
  "config",
  "help",
  "h",
  "version",
  "v",
]);

function printHelp(): void {
  process.stdout.write(`
adversary — adversarial implement→verify loop orchestrator

Usage:
  adversary run --plan <path> [options]

Commands:
  run      Run the adversarial loop
  config   Print resolved configuration as JSON

Options for 'run':
  --plan <path>                 Path to the plan file (required)
  --turns <n>                   Maximum number of turns (default: 5)
  --severity-threshold <n>      Severity threshold 1..10 (default: 7)
  --base-branch <branch>        Override base branch (overrides config)
  --config <path>               Path to per-project config file (default: .adversary.json)
                                  See "Config files" section below for merge precedence.

Options for 'config':
  --config <path>               Path to per-project config file (default: .adversary.json)

Global options:
  --help, -h                    Show this help
  --version, -v                 Show version

Config files (merged in order: defaults < global < per-project < CLI flags):
  Global:      ~/.config/adversary/config.json  (or $XDG_CONFIG_HOME/adversary/config.json)
  Per-project: .adversary.json  (in repo root, or --config path)

Config file fields:
  Note: "@{promptFile}" uses the pi CLI's file-injection syntax (@ prefix). This is pi-specific
  syntax, not adversary template syntax. Adversary template variables use plain {variable} form.

  {
    "baseBranch": "main",
    "implementCommandTemplate": "pi -p @{promptFile}",
    "verifyCommandTemplate": "pi -p @{promptFile}",
    "summarizerCommandTemplate": "pi -p @{promptFile}",
    "implementTimeoutMs": 10800000,
    "verifyTimeoutMs": 900000,
    "testTimeoutMs": 1800000,
    "prTimeoutMs": 300000,
    "summarizerTimeoutMs": 300000,
    "browserAutomation": "warn",
    "customVerificationSteps": [],
    "skillOverrides": {}
  }

  browserAutomation: "warn" | "require" | "skip"
    Controls behavior when no browser automation deps (Playwright/Puppeteer/Cypress) are found.
    "warn" (default): print warning and continue without browser automation
    "require": fail preflight if browser automation not available
    "skip": silently skip browser automation checks

  customVerificationSteps: array of custom verification steps
    parallel-review step:
      { "name": "codex-review", "commandTemplate": "codex exec --full-auto < {contextFile}", "phase": "parallel-review", "timeoutMs": 300000 }
    deterministic step:
      { "name": "repo-tests", "commandTemplate": "bun test", "phase": "deterministic", "kind": "test", "timeoutMs": 600000 }

  skillOverrides: per-skill prompt overrides
    { "reviewer": { "extraContext": "extra context..." } }
    { "reviewer": { "promptFile": "/path/to/custom-prompt.md" } }

Run artifacts:
  Stored in ~/.local/state/adversary/<repo>-<hash>/runs/ (or $XDG_STATE_HOME/adversary/...)
  Verification artifacts live under turn-N/verify/steps/<step-name>/ and turn-N/verify/synthesis/
  <repo>  = basename of the repo directory
  <hash>  = first 8 characters of the SHA-256 hash of the absolute repo path

Template variables:
  {cwd}              Working directory
  {planFile}         Snapshotted plan file path
  {promptFile}       Implement prompt file path
  {findingsFile}     Current findings markdown path
  {historyFile}      Run history markdown path
  {verifyOutputFile} Expected verify JSON output path
  {threshold}        Severity threshold
  {turn}             Current turn number
  {maxTurns}         Maximum turns
  {branch}           Feature branch name
  {baseBranch}       Base branch name

Timeouts (set via config file — defaults):
  implementTimeoutMs:  10800000 (3 hours)
  verifyTimeoutMs:     900000  (15 minutes, per-skill)
  testTimeoutMs:       1800000 (30 minutes, for deterministic test command)
  prTimeoutMs:         300000  (5 minutes)
  summarizerTimeoutMs: 300000  (5 minutes)

Examples:
  adversary run --plan /path/to/plan.md --turns 6 --severity-threshold 7
  adversary run --plan plan.md --base-branch main --turns 3 --severity-threshold 5
  adversary config
  adversary config --config custom.json

Exit codes:
  0   Workflow completed end-to-end (even if threshold findings remain)
  1   Operational failure (preflight, branch, implement, verify, push, PR)
`);
}

export function parseArgs(argv: string[]): {
  command: string | null;
  options: Record<string, string | boolean>;
  unknownFlags: string[];
} {
  const args = argv.slice(2);
  let command: string | null = null;
  const options: Record<string, string | boolean> = {};
  const unknownFlags: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--help" || arg === "-h") {
      options["help"] = true;
      i++;
    } else if (arg === "--version" || arg === "-v") {
      options["version"] = true;
      i++;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[key] = next;
        i += 2;
      } else {
        options[key] = true;
        i++;
      }
      if (!KNOWN_FLAGS.has(key)) {
        unknownFlags.push(arg);
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      // single-char flag not handled above
      const key = arg.slice(1);
      options[key] = true;
      i++;
      if (!KNOWN_FLAGS.has(key)) {
        unknownFlags.push(arg);
      }
    } else if (!command) {
      command = arg;
      i++;
    } else {
      i++;
    }
  }

  return { command, options, unknownFlags };
}

async function main(): Promise<void> {
  const { command, options, unknownFlags } = parseArgs(process.argv);

  if (options["version"]) {
    process.stdout.write(`adversary ${VERSION}\n`);
    process.exit(0);
  }

  if (options["help"] || !command) {
    printHelp();
    process.exit(0);
  }

  if (unknownFlags.length > 0) {
    process.stderr.write(`Warning: unknown flag(s): ${unknownFlags.join(", ")}\n`);
    process.stderr.write(`Run 'adversary --help' for usage.\n`);
  }

  if (command === "run") {
    if (!options["plan"] || options["plan"] === true) {
      process.stderr.write("Error: --plan is required\n");
      process.exit(1);
    }

    const turnsRaw = options["turns"] ? parseInt(options["turns"] as string, 10) : 5;
    const thresholdRaw = options["severity-threshold"]
      ? parseInt(options["severity-threshold"] as string, 10)
      : 7;

    if (isNaN(turnsRaw) || turnsRaw < 1) {
      process.stderr.write("Error: --turns must be a positive integer\n");
      process.exit(1);
    }

    if (isNaN(thresholdRaw) || thresholdRaw < 1 || thresholdRaw > 10) {
      process.stderr.write("Error: --severity-threshold must be between 1 and 10\n");
      process.exit(1);
    }

    const runOptions: RunOptions = {
      plan: options["plan"] as string,
      turns: turnsRaw,
      severityThreshold: thresholdRaw,
      baseBranch: options["base-branch"] ? (options["base-branch"] as string) : undefined,
      configFile: options["config"] ? (options["config"] as string) : undefined,
    };

    try {
      await runCommand(runOptions);
    } catch (e) {
      process.stderr.write(`\nError: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  } else if (command === "config") {
    try {
      await configCommand({
        configFile: options["config"] ? (options["config"] as string) : undefined,
      });
    } catch (e) {
      process.stderr.write(`\nError: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
  }
}

// Only run when executed directly, not when imported by tests
if (import.meta.main) {
  main();
}
