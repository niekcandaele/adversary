import type { SkillResult, VerifyReport, VerifyFinding } from "../types/index.js";

/**
 * Deterministic fallback synthesis when the LLM synthesis step fails.
 * Concatenates all findings, deduplicates by (path, line) taking highest severity.
 */
export function synthesizeFallback(results: SkillResult[]): VerifyReport {
  const status = "ok" as const;

  // Collect all findings
  const allFindings = results.flatMap((r) => r.findings);

  // Deduplicate by location key, taking highest severity
  const deduped = deduplicateFindings(allFindings);

  return {
    schemaVersion: 1,
    status,
    findings: deduped,
  };
}

function deduplicateFindings(findings: VerifyFinding[]): VerifyFinding[] {
  // Group by (path, line) location key
  const byLocation = new Map<string, VerifyFinding[]>();

  for (const f of findings) {
    // Include a normalized title snippet in the key so that two different findings
    // at the same file:line are not incorrectly merged. Without this, unrelated
    // findings that happen to share a location would be collapsed into one.
    const titleSnippet = f.title.slice(0, 60).toLowerCase().replace(/\s+/g, "-");
    const key = f.location
      ? `${f.location.path}:${f.location.line ?? "noLine"}:${titleSnippet}`
      : `noLoc:${f.title}`;

    const group = byLocation.get(key);
    if (group) {
      group.push(f);
    } else {
      byLocation.set(key, [f]);
    }
  }

  // Merge each group
  const merged: VerifyFinding[] = [];
  for (const [, group] of byLocation) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }

    // Take highest severity, merge sources, keep first title/description
    const highest = group.reduce((a, b) => (b.severity > a.severity ? b : a));
    const allSources = [...new Set(group.flatMap((f) => f.sources))];

    merged.push({
      title: highest.title,
      severity: highest.severity,
      description: highest.description,
      sources: allSources,
      location: highest.location,
    });
  }

  // Sort by severity descending
  merged.sort((a, b) => b.severity - a.severity);

  return merged;
}
