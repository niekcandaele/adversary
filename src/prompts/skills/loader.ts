import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillOverride } from "../../types/index.js";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)));

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
    const skillPath = join(SKILLS_DIR, `${skillName}.md`);
    content = await Bun.file(skillPath).text();
  }

  if (overrides?.extraContext) {
    content = content + "\n\n## Additional Context\n\n" + overrides.extraContext;
  }

  return content;
}
