# adversary

Bun CLI that runs an adversarial implement→verify loop on top of `pi`.

## Overview

`adversary` takes a plan file, creates a feature branch, and runs a loop where:

1. An **implementer** agent implements (or improves) the code
2. A **branch-wide verification pipeline** reviews the result — running reviewer, QA, UX reviewer, plan-completeness, and any configured parallel-review tools first, then deterministic checks sequentially, then the exerciser, before synthesizing deduplicated findings
3. The loop continues until all findings above the severity threshold are resolved or max turns is reached
4. A draft PR/MR is created at the end

## Prerequisites

- [Bun](https://bun.sh) >= 1.2
- `pi` CLI available in PATH
- `git` available in PATH
- `gh` (GitHub CLI) or `glab` (GitLab CLI) depending on your remote

## Install / Run

```bash
# Clone and install
bun install

# Run directly
bun run src/cli/index.ts run --plan /path/to/PLAN.md --turns 6 --severity-threshold 7
```

Or install globally:

```bash
bun link
adversary run --plan /path/to/PLAN.md --turns 6 --severity-threshold 7
```

## Usage

```
adversary run --plan <path> [options]

Options:
  --plan <path>                 Path to the plan file (required)
  --turns <n>                   Maximum number of turns (default: 5)
  --severity-threshold <n>      Severity threshold 1..10 (default: 7)
  --base-branch <branch>        Override base branch (overrides config)
  --config <path>               Path to per-project config file (default: .adversary.json)
```

### GitHub example

```bash
adversary run --plan PLAN.md --turns 6 --severity-threshold 7
```

### GitLab example

Same command — platform is auto-detected from the remote URL.

```bash
adversary run --plan PLAN.md --turns 6 --severity-threshold 7
```

## Config File

Config is loaded from two sources and merged (later sources win):

1. **Global config**: `~/.config/adversary/config.json` (or `$XDG_CONFIG_HOME/adversary/config.json`)
2. **Per-project config**: `.adversary.json` in the repo root (or `--config <path>`)

Merge precedence: `defaults < global config < per-project config < CLI flags`

Create `.adversary.json` in the repo root (or a global config for shared settings):

```json
{
  "baseBranch": "main",
  "implementCommandTemplate": "pi -p @{promptFile}",
  "verifyCommandTemplate": "pi -p @{promptFile}",
  "summarizerCommandTemplate": "pi -p @{promptFile}",
  "implementTimeoutMs": 2700000,
  "verifyTimeoutMs": 900000,
  "prTimeoutMs": 300000,
  "summarizerTimeoutMs": 300000,
  "browserAutomation": "warn",
  "customVerificationSteps": [],
  "skillOverrides": {}
}
```

All fields are optional — unset fields use the defaults above.

> **Note:** The `@` prefix in `@{promptFile}` is `pi` CLI syntax (read from file), not adversary template syntax. Adversary template variables use plain `{variable}` form.

### `browserAutomation`

Controls behavior when no browser automation dependencies (Playwright/Puppeteer/Cypress) are detected:

| Value | Behavior |
|-------|----------|
| `"warn"` (default) | Print warning, prompt to continue (auto-continues in non-TTY) |
| `"require"` | Fail preflight if browser automation is not available |
| `"skip"` | Silently skip browser automation checks |

### `customVerificationSteps`

Add custom verification steps that run alongside the built-in skills:

```json
{
  "customVerificationSteps": [
    {
      "name": "codex-review",
      "commandTemplate": "codex exec --full-auto < {contextFile}",
      "phase": "parallel-review",
      "timeoutMs": 300000
    },
    {
      "name": "repo-tests",
      "commandTemplate": "bun test",
      "phase": "deterministic",
      "kind": "test",
      "timeoutMs": 600000
    }
  ]
}
```

- `phase: "parallel-review"` runs in the branch-wide parallel review phase
- `phase: "deterministic"` runs sequentially and requires `kind: "test" | "build" | "lint" | "typecheck"`
- `{contextFile}` points at a branch context package containing plan and branch metadata
- `{planFile}` and `{cwd}` are also available to custom steps
- `timeoutMs` is optional (defaults to `verifyTimeoutMs`, except discovered test fallback uses `testTimeoutMs`)

Parallel-review tools may emit plain text; adversary analyzes their output into normalized findings.

### `skillOverrides`

Override or extend the vendored prompts for built-in verification skills:

```json
{
  "skillOverrides": {
    "reviewer": { "extraContext": "Focus on SQL injection in the data layer" },
    "qa": { "promptFile": "/path/to/custom-qa-prompt.md" }
  }
}
```

- `extraContext`: appended to the vendored prompt as an "Additional Context" section
- `promptFile`: replaces the vendored prompt entirely
- These are mutually exclusive — setting both is an error

### `summarizerCommandTemplate`

The summarizer is an LLM agent called after each turn to generate a meaningful commit message, and once at the end to generate a rich PR description.

The agent is given a prompt file (via `{promptFile}`) and must output a JSON object — everything outside the JSON is ignored so preamble text is fine.

**Commit message prompt**: the agent receives the branch name, plan title, turn number, and instructions to inspect `git diff HEAD~1 HEAD`. It must return:

```json
{ "commitMessage": "Add meaningful description of what changed" }
```

**PR body prompt**: the agent receives the branch, base branch, plan title, plan content, and instructions to inspect the full branch diff. It must return:

```json
{
  "title": "Freeform PR title",
  "summary": "- Bullet point summary",
  "reviewerGuide": "Where to start reviewing...",
  "testPlan": "How to test the changes...",
  "issueNumber": 42
}
```

`issueNumber` should be `null` if no issue is referenced.

### Template Variables

Commands are templates with these substitution variables:

| Variable | Description |
|----------|-------------|
| `{cwd}` | Working directory |
| `{planFile}` | Snapshotted plan file path |
| `{promptFile}` | Prompt file path (implement prompt for implementer, summarizer prompt for summarizer) |
| `{findingsFile}` | Current findings markdown path |
| `{historyFile}` | Run history markdown path |
| `{verifyOutputFile}` | Verify JSON output path (deprecated — the built-in pipeline writes `verify.json` internally) |
| `{contextFile}` | Context file path (custom verification steps only — contains scope, plan, discovery data) |
| `{threshold}` | Severity threshold |
| `{turn}` | Current turn number |
| `{maxTurns}` | Maximum turns |
| `{branch}` | Feature branch name |
| `{baseBranch}` | Base branch name |

## Verification Pipeline

Each turn, adversary orchestrates a multi-phase verification pipeline in TypeScript. Each skill runs as a separate harness invocation (via `verifyCommandTemplate`) with its own fresh context window.

### Phases

```text
Phase 1 (parallel-review): reviewer, qa, ux-reviewer, plan-completeness
                           + any custom steps with phase: "parallel-review"
Phase 2 (deterministic):   configured deterministic steps first by kind (test, build, lint, typecheck)
                           + discovered fallback commands only for uncovered kinds
Phase 3 (sequential):      exerciser
Phase 4 (sequential):      synthesis — LLM deduplicates and merges findings into final JSON
                           (falls back deterministically if synthesis fails)
```

### Built-in skills

| Skill | Purpose |
|-------|---------|
| `reviewer` | Design, architecture, coherence, hardening, security |
| `qa` | Test coverage quality and adequacy |
| deterministic steps | Sequential test/build/lint/typecheck checks, from config or discovery fallback |
| `ux-reviewer` | CLI output, error messages, user-facing strings |
| `exerciser` | End-to-end smoke test — starts the app and exercises the feature |
| `plan-completeness` | Checks implementation against the plan |

### How it works

1. **Scope detection**: Deterministic git diff — `merge-base`, `--name-status`, `--stat`
2. **Toolchain discovery**: Single LLM invocation to find test/build/lint commands. Cached after turn 1.
3. **Browser automation preflight** (turn 1 only): Checks for Playwright/Puppeteer/Cypress based on `browserAutomation` config
4. **Skill execution**: Each skill's vendored prompt is interpolated with scope context, discovery results, and plan content, then run via `verifyCommandTemplate`
5. **Synthesis**: All skill findings are deduplicated and merged into a single `verify.json`

Skill prompts are vendored in `src/prompts/skills/*.md` and can be overridden per-skill via `skillOverrides` config.

## Verify JSON Contract

The built-in verification pipeline produces this JSON internally. For custom or external verify setups, the output must conform to this schema:

```json
{
  "schemaVersion": 1,
  "status": "ok|blocked|error",
  "findings": [
    {
      "title": "string",
      "severity": 7,
      "location": {
        "path": "src/file.ts",
        "line": 42,
        "column": 1
      },
      "description": "string",
      "sources": ["reviewer", "qa"]
    }
  ]
}
```

- `severity` is 1–10 (higher = more severe)
- `location` is optional
- `sources` is an array of strings identifying which verifier agents flagged the finding
- All findings are included in the output — the orchestrator filters by threshold

### Status semantics

| Status | Meaning |
|--------|---------|
| `ok` | Verify completed, findings (if any) are normal |
| `blocked` | Verify could not complete (e.g. build broken, can't run tests) |
| `error` | Verify step itself errored |

`blocked` and `error` stop the loop.

## Artifacts

All run artifacts are stored under `~/.local/state/adversary/<repo>-<hash>/runs/<timestamp>-<plan-slug>/` (or `$XDG_STATE_HOME/adversary/...`). `<repo>` is the basename of the repository directory and `<hash>` is the first 8 characters of the SHA-256 hash of the absolute repository path, ensuring uniqueness across repos with the same name.

Artifacts are stored outside the repository, so they never appear as untracked files and no `.gitignore` entry is needed.

> **Note:** Run artifacts contain full-fidelity logs including all prompts and agent outputs. These can be large and may contain sensitive information.

Structure:

```
~/.local/state/adversary/<repo-name>-<hash>/
  runs/
    20260410-123456-add-json-verify-output/
      run-config.json
      plan.txt
      final-summary.md
      final-summary.json
      pr-body.md
      pr-summary-prompt.md
      pr-summarizer.stdout.log
      pr-summarizer.stderr.log
      turn-1/
        implement-input.md
        implement-command.txt
        implement.stdout.log
        implement.stderr.log
        commit-msg-prompt.md
        commit-msg-summarizer.stdout.log
        commit-msg-summarizer.stderr.log
        verify.json
        turn-summary.json
        current-findings.md
        run-history.md
        verify/
          scope.json
          discovery.json
          steps/
            reviewer/
              prompt.md
              stdout.log
              stderr.log
              output.json
            qa/
              ...
            discovered-test/
              stdout.log
              stderr.log
              stdout.truncated.log
              stderr.truncated.log
              analysis.prompt.md
              analysis.stdout.log
              analysis.stderr.log
              output.json
            exerciser/
              ...
          synthesis/
            prompt.md
            stdout.log
            stderr.log
            output.json
      turn-2/
        ...
```

## Timeouts

| Timeout | Default | Config key |
|---------|---------|-----------|
| Implement step | 45 minutes | `implementTimeoutMs` |
| Verify step (per skill) | 15 minutes | `verifyTimeoutMs` |
| PR creation | 5 minutes | `prTimeoutMs` |
| Summarizer step | 5 minutes | `summarizerTimeoutMs` |

The verify timeout applies per-skill invocation. A full verification turn runs multiple skills in parallel, so wall-clock time is roughly one timeout (not multiplied).

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Workflow completed end-to-end (even if threshold findings remain) |
| `1` | Operational failure (preflight, branch, implement failure, verify failure, push failure, PR creation failure) |

A `capped` outcome (max turns reached with findings remaining) exits **0** — it completed the workflow, just didn't fully resolve all findings.

## Preconditions

Before running, the repository must be:

- Inside a git repo
- Completely clean (no staged changes, no unstaged changes, no untracked files)

Adversary will fail fast with a clear error if any precondition is not met.
