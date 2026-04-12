/**
 * Tests for skill template loading (src/prompts/skills/loader.ts)
 */
import { test, expect, describe, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadSkillTemplate } from "../src/prompts/skills/loader.js";

describe("loadSkillTemplate", () => {
  test("loads a vendored skill template by name", async () => {
    const template = await loadSkillTemplate("reviewer");
    expect(template).toBeTruthy();
    expect(template).toContain("reviewer");
  });

  test("loads all built-in skills without error", async () => {
    const skills = [
      "reviewer",
      "qa",
      "tester",
      "static-analysis",
      "ux-reviewer",
      "exerciser",
      "plan-completeness",
      "discovery",
      "synthesis",
    ];
    for (const skill of skills) {
      const template = await loadSkillTemplate(skill);
      expect(template.length).toBeGreaterThan(0);
    }
  });

  test("vendored templates contain required placeholders", async () => {
    // Core skills should have the scope/discovery context placeholders
    const coreSkills = ["reviewer", "qa", "tester", "static-analysis", "ux-reviewer"];
    for (const skill of coreSkills) {
      const template = await loadSkillTemplate(skill);
      expect(template).toContain("{scopeContext}");
      expect(template).toContain("{discoveryJson}");
    }
  });

  test("exerciser template has phase1Findings placeholder", async () => {
    const template = await loadSkillTemplate("exerciser");
    expect(template).toContain("{phase1Findings}");
  });

  test("plan-completeness template has planContent placeholder", async () => {
    const template = await loadSkillTemplate("plan-completeness");
    expect(template).toContain("{planContent}");
  });

  test("synthesis template has skillFindings placeholder", async () => {
    const template = await loadSkillTemplate("synthesis");
    expect(template).toContain("{skillFindings}");
  });

  test("all skill templates have JSON output format section", async () => {
    const skills = [
      "reviewer",
      "qa",
      "tester",
      "static-analysis",
      "ux-reviewer",
      "exerciser",
      "plan-completeness",
      "synthesis",
    ];
    for (const skill of skills) {
      const template = await loadSkillTemplate(skill);
      // Should mention JSON output format
      expect(template).toContain('"status"');
      expect(template).toContain('"findings"');
    }
  });

  describe("with overrides", () => {
    let tmpDir: string;

    afterEach(async () => {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("extraContext appends to vendored template", async () => {
      const template = await loadSkillTemplate("reviewer", {
        extraContext: "Always focus on security vulnerabilities.",
      });
      expect(template).toContain("You are the Reviewer");
      expect(template).toContain("Always focus on security vulnerabilities.");
      expect(template).toContain("## Additional Context");
    });

    test("promptFile replaces vendored template entirely", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "adversary-loader-test-"));
      const customPath = join(tmpDir, "custom-reviewer.md");
      await writeFile(customPath, "# Custom Reviewer\nMy custom review prompt.");

      const template = await loadSkillTemplate("reviewer", {
        promptFile: customPath,
      });
      expect(template).toBe("# Custom Reviewer\nMy custom review prompt.");
      // Should NOT contain the vendored content
      expect(template).not.toContain("You are the Reviewer");
    });

    test("throws error if both promptFile and extraContext are set", async () => {
      await expect(
        loadSkillTemplate("reviewer", {
          extraContext: "extra",
          promptFile: "/some/path.md",
        })
      ).rejects.toThrow("mutually exclusive");
    });

    test("throws error for unknown skill with no overrides", async () => {
      await expect(loadSkillTemplate("nonexistent-skill")).rejects.toThrow();
    });
  });
});
