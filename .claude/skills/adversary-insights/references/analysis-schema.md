# `analysis.json` schema (renderer contract)

This is the single artifact the HTML renderer consumes. Produce one `analysis.json` per insights invocation by aggregating across all per-run facets and reaching back into raw artifacts for evidence quotes.

The contract is deliberately split: **structural fields are strictly typed** (the renderer reads them directly to build charts, the report card grid, sortable tables); **qualitative fields are `narrative_md` + `evidence`** (you author short markdown, the renderer sanitizes and inlines; click-to-expand reveals the evidence).

## Top-level shape

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-04-19T13:00:00Z",
  "window": {
    "since": "2026-03-20",       // ISO date, inclusive
    "until": "2026-04-19",       // ISO date, inclusive
    "label": "Last 30 days"      // human-readable, e.g., "Last 30 days", "All time", "Last 90 days in takaro"
  },

  "totals": { /* see § Totals */ },
  "per_repo_report_card": [ /* see § Per-repo report card */ ],

  "convergence": { /* see § Convergence */ },
  "friction_attribution": { /* see § Friction Attribution */ },
  "plan_quality": { /* see § Plan Quality */ },
  "repo_instrumentation": { /* see § Repo Instrumentation */ },
  "verify_pipeline_health": { /* see § Verify Pipeline Health */ },
  "suggested_tweaks": [ /* see § Suggested Tweaks */ ],
  "at_a_glance": { /* see § At a Glance */ },

  "notable_observations": [ /* see § Notable Observations — escape hatch */ ]
}
```

Every section is required EXCEPT `notable_observations`, which can be `[]` or omitted.

## § Totals (strictly typed)

```jsonc
{
  "runs": 31,
  "by_outcome": {
    "clean": 19,
    "capped": 7,
    "implement-failure": 2,
    "verify-failure": 1,
    "verify-error": 1,
    "commit-failure": 1,
    "summarizer-failure": 0,
    "push-failure": 0,
    "services-start-failure": 0
  },
  "repos": 4,
  "total_turns": 142,
  "total_commits": 119,
  "total_implement_hours": 27.4,
  "total_verify_hours": 18.1,
  "first_run_at": "2026-03-21T08:00:00Z",
  "last_run_at": "2026-04-18T22:14:00Z"
}
```

The `by_outcome` object MUST contain all RunOutcome values from `src/types/index.ts`, even if zero. The renderer iterates the keys in a fixed order. Do not omit.

## § Per-repo report card (strictly typed)

```jsonc
[
  {
    "repo": "takaro-8278904c",
    "repo_display_name": "takaro",            // basename of the dir, with hash stripped, for display
    "runs": 14,
    "convergence_rate": 0.71,                 // (clean count) / (total runs) — float 0..1
    "instrumentation_score": 5,               // 0..5 — see scoring guidance below
    "verify_health_score": 4,                 // 0..5
    "last_run_at": "2026-04-18T22:14:00Z",
    "summary_one_line": "Mostly converging well; one capped multi-phase rewrite drove most of the friction."
  },
  {
    "repo": "ai-module-writer-a2a53894",
    "repo_display_name": "ai-module-writer",
    "runs": 8,
    "convergence_rate": 0.50,
    "instrumentation_score": 2,
    "verify_health_score": 5,
    "last_run_at": "2026-04-15T10:00:00Z",
    "summary_one_line": "Half of runs cap out — repo lacks tests and lint, leaving the agent without verify signal."
  }
]
```

Rows are rendered in DESCENDING order of `runs` by default (you sort before emitting). The HTML lets the user re-sort by clicking column headers.

### Scoring guidance

- `instrumentation_score` (0–5):
  - +1 testCommand present and ran (in any of this repo's runs)
  - +1 buildCommand present
  - +1 lintCommands non-empty
  - +1 typeCheckCommands non-empty
  - +1 startCommand AND stopCommand both present (services lifecycle wired)
- `verify_health_score` (0–5): start at 5, subtract:
  - −1 if any run had `verify_pipeline_signal: "flaky"`
  - −2 if any run had `verify_pipeline_signal: "misconfigured"`
  - −1 if synthesis fallback fired in any run
  - −1 if any custom verify step timed out (>50% of the time it ran)
  - Floor at 0

These scores are heuristic; the qualitative analysis in the relevant sections is what readers should trust for nuance.

## § Convergence

```jsonc
{
  "turn_distribution": [
    {"turns": 1, "count": 4},
    {"turns": 2, "count": 7},
    {"turns": 3, "count": 8},
    {"turns": 4, "count": 5},
    {"turns": 5, "count": 3},
    {"turns": 8, "count": 2},
    {"turns": 25, "count": 2}
  ],
  "outcome_distribution": {
    "clean": 19, "capped": 7, "implement-failure": 2, "verify-failure": 1,
    "verify-error": 1, "commit-failure": 1, "summarizer-failure": 0,
    "push-failure": 0, "services-start-failure": 0
  },
  "convergence_pattern_distribution": {
    "clean": 19, "gradual": 4, "thrashing": 5, "stalled": 2, "regression": 1
  },
  "narrative_md": "Most runs converge in 1–3 turns (61%). Two outliers — both ClickHouse-rewrite runs against `takaro` — spent the full 25-turn budget thrashing across the same files, never closing plan-completeness gaps.\n\nWhen runs cap, they almost always show a *thrashing* pattern (5 of 7 capped runs). No 'stalled' or 'regression' patterns observed in clean runs.",
  "evidence": [
    {
      "run_id": "20260416-085435-clickhouse-analytics-rewrite",
      "repo": "takaro-8278904c",
      "quote": "Same files (web-main/src/routes/_auth/_global/analytics/*.tsx) modified across turns 3, 7, 11, 15, 18, 22.",
      "artifact_path": "~/.local/state/adversary/insights/facets/takaro-8278904c/20260416-085435-clickhouse-analytics-rewrite.json"
    }
  ]
}
```

## § Friction Attribution (the audience-killer section)

```jsonc
{
  "split": {
    "plan": 0.43,
    "repo_instrumentation": 0.20,
    "adversary_pipeline": 0.10,
    "external": 0.07,
    "unclear": 0.20
  },
  "categories": [
    {
      "source": "plan",
      "narrative_md": "Most friction traces back to plan over-scoping. The two 25-turn capped runs both attempted multi-phase rewrites that would have been more successful as discrete plans. Vague success criteria (no acceptance criteria specified in plan.txt) account for another cluster of friction.",
      "evidence": [
        {
          "run_id": "20260416-085435-clickhouse-analytics-rewrite",
          "repo": "takaro-8278904c",
          "quote": "Plan describes a 3-phase rewrite touching 60+ files; the agent had to repeatedly defer phases, leading to 'capped' outcome.",
          "artifact_path": "<facet path>"
        }
      ]
    },
    {
      "source": "adversary_pipeline",
      "narrative_md": "...",
      "evidence": [...]
    }
    // ... one entry per source that has friction. Skip sources with zero attribution.
  ]
}
```

`split` percentages should sum to ~1.0 (allow ±0.05 for rounding). Compute by counting `dominant_friction_source` across runs that had friction (i.e., `outcome != "clean"`); skip clean runs from the denominator.

`categories` should appear in DESCENDING order of `split` value, so the largest friction source is read first.

## § Plan Quality

```jsonc
{
  "clarity_distribution": {
    "vague": 4,
    "scoped": 18,
    "over-scoped": 6,
    "clear": 3
  },
  "narrative_md": "Plan clarity correlates strongly with turn count: scoped/clear plans average 2.1 turns; over-scoped plans average 14.3. Two clean runs were rescued from vague plans (mark these as success-despite-the-plan).",
  "evidence": [
    {
      "run_id": "20260411-103000-add-search",
      "repo": "ai-module-writer-a2a53894",
      "quote": "Plan reads like 'improve search'; agent made multiple guesses about which search subsystem before settling on the right one.",
      "artifact_path": "<facet path>"
    }
  ]
}
```

## § Repo Instrumentation

```jsonc
{
  "narrative_md": "Three of four repos are well-instrumented. `ai-module-writer-*` repos lack tests and lint commands, which leaves verify with only design/qa/ux signals — agent has no deterministic floor to fix to.",
  "per_repo_notes": [
    {
      "repo": "ai-module-writer-a2a53894",
      "repo_display_name": "ai-module-writer",
      "issues": [
        "No testCommand detected by discovery",
        "No lintCommands detected by discovery"
      ],
      "evidence": [
        {
          "run_id": "20260415-100000-add-feature-x",
          "repo": "ai-module-writer-a2a53894",
          "quote": "{\"testCommand\":null,\"buildCommand\":null,\"lintCommands\":[],\"typeCheckCommands\":[],...}",
          "artifact_path": "<run-dir>/discovery.json"
        }
      ]
    }
  ]
}
```

## § Verify Pipeline Health

```jsonc
{
  "synthesis_fallback_rate": 0.06,             // share of runs where synthesis fell back
  "skill_finding_counts": [
    {"skill": "reviewer", "findings": 87},
    {"skill": "qa", "findings": 54},
    {"skill": "plan-completeness", "findings": 41},
    {"skill": "ux-reviewer", "findings": 38},
    {"skill": "exerciser", "findings": 12},
    {"skill": "build-all", "findings": 9},
    {"skill": "tsc-all", "findings": 7},
    {"skill": "prettier-check", "findings": 5},
    {"skill": "eslint", "findings": 4},
    {"skill": "unit-tests", "findings": 3}
  ],
  "narrative_md": "Verify pipeline is largely healthy. Synthesis fallback fired in 2 of 31 runs (6%) — both on very long verify outputs (>1MB combined skill artifacts), suggesting a token-budget issue worth tracking. Skill-level finding counts are well-distributed; no skill is producing zero findings, which would suggest misconfiguration.",
  "evidence": [...]
}
```

## § Suggested Tweaks

```jsonc
[
  {
    "kind": "claude_md_addition",
    "text": "When working on the takaro repo, scope plans to a single phase. Multi-phase rewrites consistently cap out — split them into discrete plans per phase.",
    "reason": "Both 25-turn capped runs were multi-phase plans; both share dominant_friction_source: 'plan'.",
    "occurrences": 2
  },
  {
    "kind": "verify_step_change",
    "text": "Add a `tests` deterministic verify step to ai-module-writer repos. Currently the agent has no test signal there, leaving verify with only qualitative skills.",
    "reason": "ai-module-writer-* runs all lack testCommand; convergence rate is 50% vs 71% for repos with tests."
  },
  {
    "kind": "config_change",
    "text": "Consider setting severityThreshold to 7 for the takaro repo — the noise from severity-6 findings appears to slow convergence.",
    "reason": "Runs at threshold 5 produce 2× the threshold-finding count of runs at threshold 7, but final-turn outcomes don't differ meaningfully."
  }
]
```

`kind` is one of: `claude_md_addition`, `verify_step_change`, `config_change`, `plan_practice`, `repo_instrumentation`. The `occurrences` field is optional (only meaningful when the suggestion is derived from a repeated pattern).

## § At a Glance

```jsonc
{
  "working_md": "Most runs (61%) converge in 1–3 turns. Verify pipeline behaves well — fallback rate is just 6%. Three of four repos are well-instrumented.",
  "hindering_md": "Two multi-phase rewrites against `takaro` consumed 50 turns combined and never closed. Plan over-scoping is the largest single friction source.",
  "quick_wins_md": "Split multi-phase plans into discrete per-phase plans before invoking adversary. Add testCommand to ai-module-writer repos.",
  "structural_md": "Synthesis fallback consistently fires on >1MB verify outputs — worth tracking as adversary pipeline scales. The `exerciser` skill rarely produces findings (only 12 across 31 runs); consider whether it's pulling its weight."
}
```

## § Notable Observations (escape hatch)

```jsonc
[
  {
    "title": "All runs against takaro happen on Wednesdays",
    "narrative_md": "Probably means nothing, but worth noting — could indicate a weekly review pattern.",
    "evidence": [...]
  }
]
```

Use sparingly. If you find yourself emitting more than 2–3 entries here, your real sections are missing structure.

## Evidence object shape

Every `evidence` entry across the schema has the same shape:

```jsonc
{
  "run_id": "20260416-085435-clickhouse-analytics-rewrite",
  "repo": "takaro-8278904c",
  "quote": "verbatim string from a real artifact — do not paraphrase",
  "artifact_path": "absolute or ~-relative path to the source file"
}
```

`run_id` and `repo` let the HTML renderer link evidence back to facet/run pages. `quote` is rendered in a `<pre>` block. `artifact_path` is rendered as a `<code>` link (not clickable, since browsers can't open arbitrary local paths from HTML, but copy-pasteable for manual inspection).

## Validation checklist before writing the file

- All required sections present.
- `totals.by_outcome` includes all `RunOutcome` keys (even if 0).
- `friction_attribution.split` sums to ~1.0.
- `friction_attribution.categories` sorted desc by split.
- Every `narrative_md` field has at least one `evidence` entry (notable_observations and at_a_glance excepted).
- Every `evidence.quote` is verbatim — no paraphrasing.
- `per_repo_report_card` rows sorted desc by `runs`.
- `convergence.turn_distribution` is sorted asc by `turns`.
