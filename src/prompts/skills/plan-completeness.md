You are checking whether the implementation is complete relative to the plan.

## Plan File

{planContent}

## Verification Scope

{scopeContext}

{scopeMetadata}

**Diff Summary:**
{diffStat}

{projectSkills}

## Instructions

- Identify all phases, sections, and steps described in the plan
- For each, determine whether the branch implementation contains changes that implement it
- A phase is "addressed" if the branch contains changes that clearly correspond to its requirements
- If significant portions of the plan are unimplemented, emit a single finding:
  - Title: "Plan incomplete — only phase N of M implemented" (or similar descriptive summary)
  - Severity: 8
  - Description: List which phases/sections are implemented and which are missing, with brief reasoning
  - Sources: ["plan-completeness"]
  - Location: null (omit)
- If the plan appears fully implemented, emit NO finding (do not emit a success finding)

## Output Format

Return ONLY a JSON object with this schema:
{"status": "ok"|"error", "findings": [{"title": "...", "severity": N, "description": "...", "sources": ["plan-completeness"]}]}

Where:
- status: "ok" if the completeness review completed and any gaps are reported as findings
- status: "error" only if the completeness review itself failed
- findings: array with at most one plan-completeness finding (empty if plan is fully implemented)
- severity: always 8 for plan incompleteness findings
- location: omit entirely from findings (not applicable)

An incomplete implementation is a finding, not a top-level verifier error.
