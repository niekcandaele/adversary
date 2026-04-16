import type { VerifyFinding } from "../types/index.js";

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
