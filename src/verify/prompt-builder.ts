import type { VerifyScope, ToolchainDiscovery, SkillResult } from "../types/index.js";
// Import canonical implementations from scope module to avoid duplication
import { buildScopeContext, buildScopeMetadata } from "../scope/index.js";

// Re-export so callers that import from prompt-builder continue to work
export { buildScopeContext, buildScopeMetadata };

/**
 * Build a JSON string of toolchain discovery for injection into prompts.
 */
export function buildDiscoveryContext(discovery: ToolchainDiscovery): string {
  return JSON.stringify(discovery, null, 2);
}

/**
 * Build a JSON string of toolchain discovery for the exerciser prompt.
 * Strips startCommand and stopCommand to prevent the exerciser LLM from
 * attempting to start/stop services that the harness already manages.
 * The exerciser prompt also contains explicit instructions not to re-start.
 */
export function buildExerciserDiscoveryContext(discovery: ToolchainDiscovery): string {
  const { startCommand: _start, stopCommand: _stop, ...rest } = discovery;
  return JSON.stringify(rest, null, 2);
}

/**
 * Build a human-readable summary of Phase 1 findings for the exerciser.
 */
export function buildPhase1FindingsSummary(results: SkillResult[]): string {
  const allFindings = results.flatMap((r) => r.findings);
  if (allFindings.length === 0) {
    return "No findings from Phase 1 skills.";
  }

  const lines = [
    `Phase 1 found ${allFindings.length} issue(s):`,
    "",
    ...allFindings.map((f) => {
      const loc = f.location ? ` (${f.location.path}${f.location.line ? `:${f.location.line}` : ""})` : "";
      return `- [Severity ${f.severity}] ${f.title}${loc}: ${f.description.slice(0, 100)}${f.description.length > 100 ? "..." : ""}`;
    }),
  ];

  return lines.join("\n");
}

/**
 * Build a JSON representation of all skill findings for synthesis.
 */
export function buildSkillFindingsJson(results: SkillResult[]): string {
  const data = results.map((r) => ({
    skill: r.skill,
    status: r.status,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    findings: r.findings,
  }));
  return JSON.stringify(data, null, 2);
}
