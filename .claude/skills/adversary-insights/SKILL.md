---
name: adversary-insights
description: Generate a rich HTML insights report from adversary CLI run artifacts on disk. Use this whenever the user asks to analyze their adversary runs, see how adversary has been performing, generate a run report, look at convergence patterns across runs, find friction in adversary usage, evaluate whether the verify pipeline is healthy, or figure out which repos/plans work well with adversary — even if they don't explicitly say "insights" or "report". Triggers on phrases like "analyze my adversary runs", "show me how adversary has been doing", "make me a report from my recent runs", "is adversary working well in this repo", "what's going wrong in my adversary runs", and similar. Reads ~/.local/state/adversary/, extracts per-run quality facets, aggregates cross-repo, and renders a self-contained HTML dashboard with a per-repo report card, charts, narrative analysis, and click-to-expand evidence linking back to source artifacts.
---

# Adversary Insights

Build a high-quality HTML report that helps the user understand how the adversary CLI has been performing across their recent runs. The report attributes friction to one of four sources — **the plan**, **the repo's instrumentation**, **adversary itself (the verify pipeline)**, or **external tooling** — so the reader knows where to focus.

This is not a casual tool. Reports get read carefully. Every qualitative claim must be grounded in evidence pulled from real artifacts; readers trust the report because they can click any narrative and see the source quote.

## Inputs

Adversary persists rich per-run state at `~/.local/state/adversary/<repo>-<hash>/runs/<run-id>/`. Before doing anything, read `references/artifact-layout.md` for the full map of what's on disk and what's worth reading vs noise. The TL;DR:

- One state directory per repo (`<repo-name>-<8-char-hash>`).
- One run directory per `adversary` invocation, named `YYYYMMDD-HHMMSS-<plan-slug>`.
- Each run has structured JSON (`run-config.json`, `done.flag`, `discovery.json`, per-turn `turn-summary.json`, `verify/verify.json`, `verify/scope.json`) plus narrative artifacts (`plan.txt`, `final-summary.md`, commit messages).
- Don't read raw stdout transcripts (`*.stdout.log`) by default — they're huge and mostly noise.

## Workflow

Work through these phases in order. Don't skip ahead — each phase produces input for the next.

### Phase 1 — Enumerate completed runs

Walk every repo dir under `~/.local/state/adversary/` and for each, walk the `runs/` subdirectory. For each run, check whether `done.flag` exists. **Only completed runs (`done.flag` present) get analyzed** — incomplete runs are immutable-ish only when finished, and including them would make the cache unstable.

Apply the user's time window. Default is **last 30 days** (use `run-config.json`'s `startedAt` field). If the user asks for a different window ("last 90 days", "all time", "in this repo only"), respect it.

If there are zero qualifying runs, tell the user clearly and stop. Don't generate an empty report.

### Phase 2 — Per-run facet extraction

For each qualifying run, produce a per-run "facet" — a structured JSON object capturing the qualitative judgments that aren't directly readable from the structured fields. The facet schema is in `references/facet-schema.md`.

**Cache aggressively.** Per-run facets are immutable once written (the underlying run is done; the facet only changes if the schema does). Cache location: `~/.local/state/adversary/insights/facets/<repo>-<hash>/<run-id>.json`. Cache key: run-id + the `schema_version` field. If a cached facet exists with the same schema version, **reuse it** — don't re-read the run's artifacts.

For un-cached runs:
1. Read the structured artifacts only (skip stdout logs unless something looks broken and you need to investigate).
2. Form judgments per the schema (convergence pattern, dominant friction source, plan clarity, etc.).
3. Write the facet JSON to the cache path. Create parent directories as needed.

If you have many un-cached runs (>20), work through them in small batches of 5–10 to keep your context manageable. For each batch, read the artifacts → write the facet JSONs → move on.

### Phase 3 — Aggregation

Once all facets exist, build the `analysis.json` per `references/analysis-schema.md`. This is the single artifact the HTML renderer consumes.

Key principle: **structural data is strictly typed; qualitative analysis is `narrative_md` + `evidence`**. The structural fields drive charts and the report card grid (cannot deviate from schema). The narrative fields are short markdown paragraphs you write, and **every claim must be backed by `evidence: [{run_id, repo, quote, artifact_path}]`** so the renderer can show readers the source.

Reach back into raw run artifacts when you need a verbatim quote for evidence — don't paraphrase. If you make a claim like "users frequently ignore plan-completeness findings," your evidence should include actual `turn-summary.json` excerpts or finding titles from real runs.

The 6 + 1 sections, in order in the schema:

1. **Convergence Patterns** — how runs end (clean / capped / errors), turn count distribution, thrashing indicators.
2. **Friction Attribution** — for runs that didn't go clean, what's the dominant cause split? Plan / repo_instrumentation / adversary_pipeline / external. This is the audience-killer feature; readers go here first.
3. **Plan Quality** — vague vs scoped plan signals; correlated with turn-count and outcome. *Even successful runs can have bad plans (rescued by the agent), and that's still worth flagging.*
4. **Repo Instrumentation** — per-repo: discovery output, presence of test/lint/typecheck, custom verify steps. Surfaces "this repo is set up well/poorly for adversary."
5. **Verify Pipeline Health** — synthesis fallback rate, skill-level finding counts, custom-step timeout rate. Tells the reader whether the verify pipeline itself is misbehaving (adversary's responsibility) or working as intended.
6. **Suggested Tweaks** — actionable recommendations: CLAUDE.md additions (instructions seen across multiple plans), verify step changes, threshold adjustments.
7. **At a Glance** — synthesis: 4 short sections (working / hindering / quick wins / structural changes worth considering).

Also populate the **per-repo report card** array — one entry per repo, with convergence_rate, instrumentation_score (0–5), verify_health_score (0–5), recent activity. This drives the headline visual.

If you discover something interesting that doesn't fit any of these sections (e.g., an unusual pattern across one specific repo), populate the `notable_observations` escape hatch. Don't abuse it — it's a safety valve, not a dumping ground.

### Phase 4 — Render

1. Read `assets/report-template.html`.
2. Replace the single placeholder `__ANALYSIS_DATA__` with `JSON.stringify(analysis)` (no quoting around it — it's a JS variable assignment in the template).
3. Write the result to `~/.local/state/adversary/insights/report.html`. Create parent dirs if needed.

The template handles all visual rendering: CSS, JS interactivity (sortable per-repo table, click-to-expand evidence, filter controls), SVG charts, markdown rendering with sanitization. Don't try to inline data anywhere else in the template.

### Phase 5 — Open and report back

Open the HTML in the user's default browser:
- macOS: `open ~/.local/state/adversary/insights/report.html`
- Linux: `xdg-open ~/.local/state/adversary/insights/report.html`

Then tell the user, briefly:
- The output path.
- How many runs were analyzed (and how many were cached vs newly faceted).
- The headline finding (e.g., "27 of 31 runs converged cleanly; the 4 capped runs all share the `auth-rewrite` plan against `takaro-*` — likely a plan scoping issue").

Keep the user-facing summary short. The report itself does the heavy lifting.

## Triggering judgment

This skill is the right call when the user is asking to *understand* their adversary usage in aggregate — patterns across many runs, attribution of recurring problems, recommendations.

It's *not* the right call for:
- Looking at one specific run ("what happened in run X?") — the user wants you to read that run's artifacts directly, not run a 30-day pipeline.
- Real-time observability while a run is in progress — adversary has its own progress output for that.
- Modifying adversary itself — that's normal codebase work.

When in doubt, prefer triggering. The cost of running the skill (mostly cached after first invocation) is much smaller than the cost of leaving the user without insights they asked for.

## Things that go wrong (debugging)

- **No state dir at `~/.local/state/adversary/`.** Either the user has never run adversary, or `XDG_STATE_HOME` is set to something non-default. Check `XDG_STATE_HOME`; if set, walk `$XDG_STATE_HOME/adversary/` instead.
- **All runs are incomplete (no `done.flag`).** Tell the user — this is unusual and probably means runs are crashing before completion. The report can't really do its job without completed runs.
- **The HTML opens to a broken page.** Almost always a JSON-validity issue in `analysis.json` or a placeholder substitution that produced invalid JS. Check the browser console; fix the renderer's input. Don't edit the template's JS to work around bad data — fix the data.
- **Facet cache has stale schema.** If you've changed `facet-schema.md` and old cache entries don't have the new fields, bump `schema_version` in the schema and re-extract any facets whose cached version is older. Don't try to migrate stale cache in place.

## When you're done

The smoke test you should mentally run:
- The per-repo report card has at least one row with a non-trivial color (not everything green) — otherwise either every repo is healthy or your scoring is broken.
- Every `narrative_md` field has at least one `evidence` entry.
- The HTML opens in the browser, sorts the report card on column click, and expanding any narrative reveals concrete quotes with file paths.
- The "At a Glance" reads like a tight executive summary, not a generic restatement of the other sections.
