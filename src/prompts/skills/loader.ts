import type { SkillOverride } from "../../types/index.js";

// Embed skill templates at compile time so they're available in compiled binaries.
// Bun's `with { type: "text" }` inlines these as string constants in the bundle.
import commandAnalyzerMd from "./command-analyzer.md" with { type: "text" };
import discoveryMd from "./discovery.md" with { type: "text" };
import exerciserMd from "./exerciser.md" with { type: "text" };
import planCompletenessMd from "./plan-completeness.md" with { type: "text" };
import qaMd from "./qa.md" with { type: "text" };
import reviewerMd from "./reviewer.md" with { type: "text" };
import synthesisMd from "./synthesis.md" with { type: "text" };
import toolOutputAnalyzerMd from "./tool-output-analyzer.md" with { type: "text" };
import uxReviewerMd from "./ux-reviewer.md" with { type: "text" };

const BUILTIN_SKILLS: Record<string, string> = {
  "command-analyzer": commandAnalyzerMd,
  discovery: discoveryMd,
  exerciser: exerciserMd,
  "plan-completeness": planCompletenessMd,
  qa: qaMd,
  reviewer: reviewerMd,
  synthesis: synthesisMd,
  "tool-output-analyzer": toolOutputAnalyzerMd,
  "ux-reviewer": uxReviewerMd,
};

/**
 * Load a skill prompt template, applying any overrides.
 *
 * - If overrides.promptFile: load that file entirely
 * - Otherwise: load vendored src/prompts/skills/{skillName}.md
 * - If overrides.extraContext: append as ## Additional Context section
 * - Error if both promptFile and extraContext are set
 */
export async function loadSkillTemplate(
  skillName: string,
  overrides?: SkillOverride
): Promise<string> {
  if (overrides?.promptFile && overrides?.extraContext) {
    throw new Error(
      `skillOverrides.${skillName}: promptFile and extraContext are mutually exclusive`
    );
  }

  let content: string;

  if (overrides?.promptFile) {
    content = await Bun.file(overrides.promptFile).text();
  } else {
    const builtin = BUILTIN_SKILLS[skillName];
    if (!builtin) {
      throw new Error(`Unknown built-in skill: ${skillName}`);
    }
    content = builtin;
  }

  if (overrides?.extraContext) {
    content = content + "\n\n## Additional Context\n\n" + overrides.extraContext;
  }

  return content;
}
