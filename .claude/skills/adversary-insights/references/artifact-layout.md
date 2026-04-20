# Adversary artifact layout

Map of what the adversary CLI persists on disk per run, plus guidance on what's worth reading and what's noise. Derived from the live shape of `~/.local/state/adversary/` and the type definitions at `src/types/index.ts` in the adversary repo.

## Top level

```
~/.local/state/adversary/
├── <repo-name>-<8-char-hash>/      # one per repo adversary has been run against
│   └── runs/
│       ├── 20260416-085435-clickhouse-analytics-rewrite/
│       ├── 20260417-101522-fix-auth-middleware/
│       └── ...
├── adversary-run-int-*/             # integration test fixtures — IGNORE these
│                                    # they're created by the test suite, not real runs
└── insights/                        # this skill's own state (created on first run)
    ├── facets/
    │   └── <repo-name>-<8-char-hash>/
    │       └── <run-id>.json
    └── report.html
```

The repo dir name is computed as `<basename(git-root)>-<sha256(git-root)[:8]>` — so the same repo always maps to the same directory across users with the same path. Different paths to the same repo produce different state dirs (this is intentional — adversary treats them as logically separate).

**Skip integration-test fixtures.** Their names match `adversary-run-int-*`. They were never real adversary invocations and including them in the report is misleading.

## Per-run directory contents

Inside `<state>/<repo>-<hash>/runs/<run-id>/`:

### Run-level artifacts (read these)

| File | Worth reading | Notes |
|---|---|---|
| `run-config.json` | **YES** | `SavedRunConfig` shape — `planFile`, `planTitle`, `branch`, `baseBranch`, `startedAt`, `turns`, `threshold`, `config` (full `AdversaryConfig` snapshot). Source of truth for "what was this run trying to do." |
| `done.flag` | **YES** | `DoneFlag` shape — `outcome`, `completedAt`, `prUrl`. Presence = run is complete. Use the outcome enum to classify. |
| `plan.txt` | **YES** | Snapshotted plan content. Read this to judge plan quality (clarity, scope, verification criteria). |
| `discovery.json` | **YES** | `ToolchainDiscovery` shape — `testCommand`, `buildCommand`, `lintCommands`, `typeCheckCommands`, `startCommand`, `stopCommand`, `browserDeps`. Tells you what adversary detected about the repo's instrumentation. Empty `testCommand` etc. = poor instrumentation. |
| `final-summary.json` | **YES** | Rich human-readable summary of the entire run. Useful for evidence quotes when narrating. Schema can vary across adversary versions — read defensively. |
| `final-summary.md` | OPTIONAL | Markdown rendering of the same. |
| `pr-body.md` | OPTIONAL | Generated PR description. Read only if you need quotes about how adversary chose to frame the PR. |
| `repoGuidance.txt`, `projectSkills.txt` | OPTIONAL | Repo-derived guidance the agent loaded. Useful only if you suspect repo-instrumentation friction. |
| `pr-summarizer.std{out,err}.log` | NO | Raw subprocess output. Noise. |
| `pr-summary-prompt.md` | NO | Internal prompt scaffolding. Noise. |

### Per-turn directories (`turn-1/`, `turn-2/`, …)

```
turn-N/
├── turn-summary.json          # READ — TurnResult shape
├── verify.json                # READ — VerifyReport shape (the consolidated output)
├── implement-input.md         # OPTIONAL — the prompt the agent received this turn
├── current-findings.md        # OPTIONAL — findings carried into this turn
├── run-history.md             # OPTIONAL — prior turn summaries shown to the agent
├── implement-command.txt      # NO — just the resolved command line
├── verify-command.txt         # NO — same
├── implement.std{out,err}.log # NO — huge transcripts, mostly noise
├── commit-msg-prompt.md       # NO — internal scaffolding
├── commit-msg-summarizer.std{out,err}.log  # NO
└── verify/                    # READ selectively — see below
```

#### `turn-summary.json` (most important per-turn file)

`TurnResult` shape (from `src/types/index.ts`):

```ts
{
  turn: number,
  implementCommand: string,
  verifyCommand: string,
  implementDurationMs: number,
  verifyDurationMs: number,
  repoChanged: boolean,
  commitSha?: string,
  commitMessage?: string,        // human-written commit message — great evidence quote
  commitError?: string,          // populated when commit fails (pre-commit hook etc.)
  turnSummary?: string,          // narrative summary of what this turn did — great evidence
  verifyStatus: "ok" | "error" | "skipped",
  thresholdFindings: VerifyFinding[],     // findings AT or ABOVE the severity threshold
  belowThresholdFindings: VerifyFinding[], // findings below threshold
  outcome: "continue" | "clean" | "capped" | "commit-failure" | "implement-failure" | "summarizer-failure" | "verify-failure" | "verify-error" | "services-start-failure"
}
```

Per-turn `outcome === "continue"` means the loop went to the next turn. The *run-level* outcome is in `done.flag`. The last turn's outcome typically matches the run outcome.

#### `verify.json` (per-turn)

`VerifyReport` shape:

```ts
{
  schemaVersion: 1,
  status: "ok" | "error" | "skipped",
  findings: VerifyFinding[],
  commitSha?: string
}
```

Where `VerifyFinding`:

```ts
{
  title: string,
  severity: number,             // 1..10
  location?: { path, line?, column? },
  description: string,
  sources: string[]             // which skill(s) flagged this — e.g., ["reviewer", "qa"]
}
```

The `sources` array is gold for verify-pipeline-health analysis: it tells you which skills are producing which findings. Built-in skill names: `reviewer`, `qa`, `ux-reviewer`, `exerciser`, `plan-completeness`. Anything else is a deterministic step (e.g., `eslint`, `tsc-all`, `prettier-check`, `build-all`, `unit-tests`) or a user-defined custom verification step.

#### `verify/` subdirectory (selective)

```
verify/
├── scope.json                 # READ — VerifyScope shape: files touched, diffStat
├── branch-context.txt         # OPTIONAL — full plan + scope dump given to verify
├── plan.txt                   # NO — duplicate of run-level plan.txt
├── discovery.json             # NO — duplicate of run-level discovery.json
├── discovery.{prompt.md, std{out,err}.log} # NO — internal
├── steps/<skill-name>/        # OPTIONAL — per-skill artifacts (only read if drilling into a flaky skill)
│   ├── context.txt
│   ├── synthesizer.prompt.md
│   ├── step.std{out,err}.log
│   └── ...
└── synthesis/                 # OPTIONAL — only read if findings look weird and you want to see the merge step
    ├── synthesis.prompt.md
    ├── synthesis.std{out,err}.log
    └── ...
```

**`scope.json`** is the second per-turn file you actually want, after `turn-summary.json`. `VerifyScope` shape:

```ts
{
  baseBranch: string,
  mergeBase: string,
  files: Array<{ path: string, status: "added" | "modified" | "deleted" | "renamed" }>,
  diffCommand: string,
  diffStat: string              // free-form git diff --stat output
}
```

Use `files[].path` across multiple turns to detect thrashing — if `auth.ts` appears in turns 1, 2, 3, 4, that's a strong "agent kept rewriting the same file" signal even without reading diffs.

The `verify/steps/` subdirectories exist when adversary's multi-skill verifier ran. Each subdir is named after a built-in skill, deterministic step (`build-all`, `tsc-all`, `prettier-check`, `eslint`, `unit-tests`), or a user-defined custom step. You generally **don't** need to read these — `turn-summary.json` and `verify.json` already aggregate the results. Only read step-level artifacts if you suspect a specific skill is producing flaky or weird output and you want concrete evidence.

The `verify/synthesis/` directory exists when the synthesis LLM step ran (or fell back). Reading the `synthesis.std{err}.log` is useful if you suspect synthesis-pipeline failures contributed to friction (look for "fallback" mentions or non-zero exit codes from the merge step).

## Quick `jq` recipes for the agent

If you have `jq` available (you should), these queries are common:

```bash
# All run dirs, grouped by repo
ls -d ~/.local/state/adversary/*/runs/*/

# Just completed runs
for d in ~/.local/state/adversary/*/runs/*/; do
  [[ -f "$d/done.flag" ]] && echo "$d"
done | grep -v "adversary-run-int"

# Outcome of every completed run
for d in ~/.local/state/adversary/*/runs/*/; do
  [[ -f "$d/done.flag" ]] && jq -r '.outcome' "$d/done.flag" 2>/dev/null
done | sort | uniq -c | sort -rn

# Turn count per run
ls -d <run-dir>/turn-*/ | wc -l

# Pull threshold findings from one turn
jq '.thresholdFindings[] | {title, severity, sources}' <run-dir>/turn-1/turn-summary.json

# Files touched in a turn
jq '.files[].path' <run-dir>/turn-1/verify/scope.json
```

## Things that change

This is the layout as of `adversary` ~v0.X (April 2026). Watch for:

- **Older runs may have a flatter `turn-N/verify.json`** with no `verify/` subdirectory — that's fine, `verify.json` and `turn-summary.json` are still present.
- **`done.flag` outcome enum may add new variants** (the type's `RunOutcome` is a closed set; check `src/types/index.ts` if you see an unfamiliar value).
- **The verify pipeline schema is versioned** (`schemaVersion: 1`); if you see a different version, bump this skill's reference docs.
