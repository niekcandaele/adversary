import type { VerifyFinding, VerifyScope } from "../types/index.js";

/**
 * Returns true when pathA and pathB share a common trailing segment sequence.
 * Used to tolerate absolute-vs-relative path differences while avoiding false
 * positives where two paths have the same filename but different directories.
 *
 * Examples:
 *   "src/cli/run.ts" matches "cli/run.ts"    → true  (shared trailing segments)
 *   "src/cli/run.ts" matches "run.ts"         → true  (shared trailing segments)
 *   "src/cli/run.ts" matches "src/other/run.ts" → false (diverging middle segments)
 *   "/abs/src/cli/run.ts" matches "src/cli/run.ts" → true (absolute vs relative)
 */
function pathSegmentsMatch(pathA: string, pathB: string): boolean {
  const segsA = pathA.split("/").filter(Boolean);
  const segsB = pathB.split("/").filter(Boolean);
  // Walk backwards comparing segments until one sequence is exhausted
  const minLen = Math.min(segsA.length, segsB.length);
  for (let i = 1; i <= minLen; i++) {
    if (segsA[segsA.length - i] !== segsB[segsB.length - i]) return false;
  }
  return minLen > 0;
}

/**
 * Filter a list of findings to only those in scope (i.e. whose location.path
 * matches one of the files touched on the branch).
 *
 * - Findings with no location.path are kept unconditionally (e.g. "no tests
 *   exist for new feature" — legitimately in-scope without a specific path).
 * - Findings whose location.path exactly matches a scope file path are kept.
 * - Findings whose location.path shares trailing path segments with a scope file
 *   are also kept, to tolerate absolute-vs-relative path differences.
 *   The match is component-aware: "src/cli/run.ts" matches "cli/run.ts" and
 *   "run.ts" but does NOT match "src/other/run.ts" even though both end in "run.ts".
 *
 * DESIGN NOTE (cross-file findings): This filter may drop legitimate cross-file
 * reviewer findings where new changes in a scoped file interact with unchanged
 * callee code (e.g. "when src/foo.ts calls this function, bar.ts:42 misbehaves").
 * This is by design. The alternative — keeping findings about out-of-scope files —
 * was tried and caused runs to go off the rails when verifiers filed findings about
 * entirely unrelated modules, pulling the implementer into unrelated work.
 * We accept the occasional missed cross-file finding in exchange for stable,
 * focused runs. WONTFIX.
 */
export function filterFindingsByScope(findings: VerifyFinding[], scope: VerifyScope): VerifyFinding[] {
  const scopePaths = scope.files.map((f) => f.path);
  if (scopePaths.length === 0) return findings;

  return findings.filter((finding) => {
    if (!finding.location?.path) return true; // no path — keep unconditionally
    const fp = finding.location.path;
    return scopePaths.some((sp) => {
      if (sp === fp) return true;
      // Tolerate absolute-vs-relative with component-aware suffix matching
      return pathSegmentsMatch(fp, sp);
    });
  });
}

/**
 * Validate and parse a raw array of findings from LLM skill output.
 * Malformed entries are skipped with a warning; valid entries are returned.
 */
export function validateRawFindings(
  rawFindings: unknown[],
  sourceName: string
): VerifyFinding[] {
  const findings: VerifyFinding[] = [];

  for (let i = 0; i < rawFindings.length; i++) {
    const f = rawFindings[i] as Record<string, unknown>;
    if (typeof f !== "object" || f === null) {
      process.stderr.write(
        `  Warning: skill "${sourceName}" findings[${i}] is not an object — skipping\n`
      );
      continue;
    }
    if (typeof f.title !== "string") {
      process.stderr.write(
        `  Warning: skill "${sourceName}" findings[${i}].title must be a string — skipping\n`
      );
      continue;
    }
    if (typeof f.severity !== "number") {
      process.stderr.write(
        `  Warning: skill "${sourceName}" findings[${i}].severity must be a number — skipping\n`
      );
      continue;
    }
    if (typeof f.description !== "string") {
      process.stderr.write(
        `  Warning: skill "${sourceName}" findings[${i}].description must be a string — skipping\n`
      );
      continue;
    }
    // Construct from explicit validated fields only — do not spread arbitrary LLM keys
    const rawLocation = f.location as Record<string, unknown> | undefined;
    const location: VerifyFinding["location"] =
      rawLocation &&
      typeof rawLocation === "object" &&
      typeof rawLocation.path === "string"
        ? {
            path: rawLocation.path,
            ...(typeof rawLocation.line === "number" ? { line: rawLocation.line } : {}),
          }
        : undefined;
    findings.push({
      title: f.title as string,
      severity: f.severity as number,
      description: f.description as string,
      sources: Array.isArray(f.sources)
        ? (f.sources as unknown[]).filter((s): s is string => typeof s === "string")
        : [sourceName],
      ...(location ? { location } : {}),
    });
  }

  return findings;
}
