# Per-run facet schema

A facet is a structured judgment-record produced once per completed adversary run. It captures the qualitative judgments that aren't directly readable from `turn-summary.json` or `verify.json` — things like "did this run thrash?" or "is this friction the plan's fault or the verify pipeline's fault?".

Facets are cached at `~/.local/state/adversary/insights/facets/<repo>-<hash>/<run-id>.json`. Once written, they're considered immutable until `schema_version` changes.

## Schema

```jsonc
{
  "schema_version": 1,
  "run_id": "20260416-085435-clickhouse-analytics-rewrite",
  "repo": "takaro-8278904c",
  "extracted_at": "2026-04-19T12:34:56Z",

  // ─── Structural rollup (deterministic — copy from turn-summary.json files) ───
  "totals": {
    "turns": 25,
    "outcome": "capped",                  // from done.flag
    "implement_duration_ms": 18743000,
    "verify_duration_ms": 23910000,
    "commits": 23,                        // count of turns where repoChanged=true
    "files_modified_unique": 47,          // unique files across all turns' scope.files
    "threshold_finding_count_total": 41,  // sum across all turns
    "threshold_finding_count_final_turn": 6
  },

  // ─── Qualitative judgments (you decide based on the artifacts) ───
  "convergence_pattern": "thrashing",     // see enum below
  "convergence_reasoning": "Same files (web-main/src/routes/_auth/_global/analytics/*.tsx) modified across turns 3, 7, 11, 15, 18, 22. Threshold-finding count oscillates rather than declines.",

  "plan_clarity": "over-scoped",          // see enum below
  "plan_clarity_reasoning": "Plan describes a 3-phase rewrite touching 60+ files; the agent had to repeatedly defer phases, leading to 'capped' outcome. A scoped phase-1-only plan would likely have converged.",

  "dominant_friction_source": "plan",     // see enum below — the audience-killer field
  "friction_attribution_reasoning": "Friction is attributable to plan over-scoping rather than the agent or repo. The verify pipeline behaved correctly; the repo is well-instrumented (full test/lint/typecheck commands present); findings are legitimate plan-completeness gaps.",

  "repo_signal": "well_instrumented",     // see enum below
  "repo_signal_reasoning": "discovery.json shows test/build/lint/typecheck/start/stop all present; deterministic verify steps (eslint, tsc-all, prettier-check, build-all, unit-tests) all ran.",

  "verify_pipeline_signal": "healthy",    // see enum below
  "verify_pipeline_signal_reasoning": "All verify skills produced findings; no synthesis fallback observed; no skill-step timeouts.",

  // ─── Friction examples (concrete, for evidence in the report) ───
  "friction_examples": [
    {
      "kind": "plan_over_scope",
      "turn": 18,
      "evidence_quote": "Phase 2 items such as player-sync snapshot events, overview/shop/player analytics service methods and routes, corresponding frontend screens, and their tests are still absent.",
      "artifact_path": "<run-dir>/turn-18/turn-summary.json"
    },
    {
      "kind": "regression_introduced",
      "turn": 1,
      "evidence_quote": "Shop analytics regresses from a working dashboard/API to a placeholder screen",
      "artifact_path": "<run-dir>/turn-1/turn-summary.json"
    }
  ],

  // ─── Skill-level finding tally (deterministic from verify.json files) ───
  "findings_by_source": {
    "reviewer": 14,
    "ux-reviewer": 8,
    "qa": 11,
    "plan-completeness": 9,
    "exerciser": 0,
    "build-all": 4,
    "tsc-all": 3,
    "prettier-check": 2,
    "eslint": 1,
    "unit-tests": 0
  },

  // ─── Plan and outcome summary (short — for aggregation prompt) ───
  "plan_title": "ClickHouse analytics rewrite",
  "plan_one_line": "Three-phase analytics rewrite onto ClickHouse with module health, shop analytics, and overview rebuilds.",
  "outcome_one_line": "Capped at 25 turns with phase-2/phase-3 work still incomplete; phase 1 landed but with a regression in shop analytics."
}
```

## Field guidance

### `convergence_pattern` (enum)

- **`clean`** — `outcome: "clean"`, low turn count (≤3), no regressions, finding count strictly decreased turn-over-turn.
- **`gradual`** — `outcome: "clean"` but took 4–N turns; findings declined steadily.
- **`thrashing`** — finding counts oscillated (didn't strictly decline), or the same files appeared in many turns' `scope.files`. Often correlates with `outcome: "capped"`.
- **`stalled`** — verify status went `error` or `skipped` repeatedly, or a single finding persisted unresolved across many turns.
- **`regression`** — finding count *increased* turn-over-turn at some point. Particularly bad signal.

### `plan_clarity` (enum)

- **`vague`** — plan reads like "improve X" without scope, success criteria, or files. Agent had to make many guesses.
- **`scoped`** — plan defines a clear bounded change with verification criteria. Agent can execute against it.
- **`over-scoped`** — plan describes too much (multi-phase, dozens of files). Even a successful agent would struggle to fit it in `maxTurns`.
- **`clear`** — plan is well-scoped *and* well-detailed; an unusually good plan.

A run can have `convergence_pattern: clean` AND `plan_clarity: vague` — the agent rescued a bad plan. That's still worth flagging in Plan Quality Signals; readers should know which clean runs were despite-the-plan.

### `dominant_friction_source` (enum) — the audience-killer field

This single field is the most important judgment in the facet because it powers Friction Attribution in the report. Choose one:

- **`plan`** — the friction would have been avoided with a better plan. Vague or over-scoped plans, missing acceptance criteria, contradictory requirements.
- **`repo_instrumentation`** — the repo isn't set up for adversary. No tests, no lint, no typecheck, broken build commands, monorepo structure that confuses discovery, no CLAUDE.md guidance.
- **`adversary_pipeline`** — adversary itself misbehaved. Synthesis fallback fired, a verify skill produced bogus findings, the verify command timed out, custom verification steps configured incorrectly.
- **`external`** — third-party flakiness: network failures, dependency install failures, broken upstream packages, infra outages.
- **`unclear`** — genuinely ambiguous. Use sparingly; if you find yourself defaulting here, look harder.

Apply this even to clean runs: a clean run with no friction has `dominant_friction_source: "plan"` and `friction_attribution_reasoning: "no significant friction observed"`. The aggregator filters by run outcome — but capturing it per-run keeps cache uniform.

### `repo_signal` (enum)

Based on the run's `discovery.json` and observed behavior of deterministic verify steps:

- **`well_instrumented`** — testCommand + buildCommand + lintCommands + typeCheckCommands all present and ran successfully when triggered.
- **`partially`** — some present, some missing or failing.
- **`poorly`** — most missing, broken, or producing nonsense.
- **`unclear`** — couldn't tell from this run alone.

### `verify_pipeline_signal` (enum)

Based on the verify pipeline's behavior in this specific run:

- **`healthy`** — all skills ran, synthesis worked, no timeouts, findings look legitimate.
- **`flaky`** — synthesis fallback fired, or one skill consistently failed/timed out, or findings have suspicious quality (e.g., the same finding emitted multiple times by one skill).
- **`misconfigured`** — custom verify steps failed to run, threshold seems wrong (everything above or below), skill overrides produced empty output.

### `friction_examples` (array)

Aim for 1–3 examples per run when there's friction. Each example must include:
- `kind`: short noun phrase (e.g., `plan_over_scope`, `regression_introduced`, `verify_skill_flaky`, `repo_lacks_tests`, `agent_thrashing`, `synthesis_fallback`, `external_flakiness`).
- `turn`: which turn (or `0` if run-level).
- `evidence_quote`: a verbatim string from the artifacts. Don't paraphrase. Quote a real finding title, commit message, or `turnSummary` excerpt.
- `artifact_path`: relative or absolute path to the file the quote came from.

For runs with no friction, omit the array (or set to `[]`).

### `findings_by_source` (object)

Sum `thresholdFindings[].sources` across every turn's `verify.json`. Each finding can have multiple sources (e.g., `["reviewer", "ux-reviewer"]`); count it for each. Built-in skill names + deterministic step names show up here. This object is a key input to Verify Pipeline Health analysis.

## Extraction workflow per run

1. Read `run-config.json` → `plan_title`, repo identification.
2. Read `done.flag` → `outcome`.
3. Read `plan.txt` → judge `plan_clarity`.
4. Read `discovery.json` → judge `repo_signal`.
5. List `turn-*/` directories → `totals.turns`.
6. For each turn: read `turn-summary.json` and `verify/scope.json` → accumulate `commits`, `files_modified_unique`, `threshold_finding_count_total`, durations, `findings_by_source`.
7. Read `final-summary.json` if present → use for `outcome_one_line`.
8. Optionally read `final-summary.md` for richer narrative quotes.
9. Form judgments: `convergence_pattern`, `dominant_friction_source`, `verify_pipeline_signal`. Each judgment must be backed by a `_reasoning` field that cites concrete artifacts.
10. Pick 1–3 `friction_examples` if friction exists; quote verbatim.
11. Write the JSON to the cache path.

If a run is malformed (corrupt `done.flag`, missing turn dirs, etc.), skip it and don't write a facet — the next insights run can retry.
