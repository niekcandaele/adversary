# adversary

Bun CLI that runs an adversarial implement→verify loop on top of `pi`.

## Overview

`adversary` takes a plan file, creates a feature branch, and runs a loop where:

1. An **implementer** agent implements (or improves) the code
2. A **verifier** agent reviews the result and emits structured JSON findings
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
  --config <path>               Path to config file (default: .pi-adversary.json)
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

Create `.pi-adversary.json` in the repo root:

```json
{
  "baseBranch": "main",
  "implementCommandTemplate": "pi -p @{promptFile}",
  "verifyCommandTemplate": "pi -p \"/skill:verify --mode=report-only --format=json --output={verifyOutputFile}\"",
  "summarizerCommandTemplate": "pi -p @{promptFile}",
  "implementTimeoutMs": 2700000,
  "verifyTimeoutMs": 5400000,
  "prTimeoutMs": 300000,
  "summarizerTimeoutMs": 300000
}
```

All fields are optional — unset fields use the defaults above.

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
| `{verifyOutputFile}` | Expected verify JSON output path |
| `{threshold}` | Severity threshold |
| `{turn}` | Current turn number |
| `{maxTurns}` | Maximum turns |
| `{branch}` | Feature branch name |
| `{baseBranch}` | Base branch name |

## Verify JSON Contract

The verify command must write a JSON file to `{verifyOutputFile}` with this schema:

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

All run artifacts are stored under `.pi-adversary/runs/<timestamp>-<plan-slug>/`.

> **Warning:** Run artifacts contain full-fidelity logs including all prompts and agent outputs. These can be large and may contain sensitive information. Consider adding `.pi-adversary/` to your `.gitignore`.

Structure:

```
.pi-adversary/
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
        verify-command.txt
        verify.stdout.log
        verify.stderr.log
        verify.json
        turn-summary.json
        current-findings.md
        run-history.md
      turn-2/
        ...
```

## Timeouts

| Timeout | Default | Config key |
|---------|---------|-----------|
| Implement step | 45 minutes | `implementTimeoutMs` |
| Verify step | 90 minutes | `verifyTimeoutMs` |
| PR creation | 5 minutes | `prTimeoutMs` |
| Summarizer step | 5 minutes | `summarizerTimeoutMs` |

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
