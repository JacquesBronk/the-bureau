// tests/runtime/skill-catalog-content.test.ts
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadSkillCatalog } from "../../src/runtime/resolve-skill.js";

const SKILLS_DIR = resolve(__dirname, "../../skills");

describe("served skill catalog content", () => {
  it("includes business-analyst with its evals/ files", () => {
    const cat = loadSkillCatalog(SKILLS_DIR);
    const ba = cat.listSkills().find((s) => s.id === "business-analyst");
    expect(ba).toBeDefined();
    const resolved = cat.readSkill("business-analyst");
    const paths = resolved.files.map((f) => f.relpath).sort();
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("contract.md");
    expect(paths.filter((p) => p.startsWith("evals/")).length).toBe(5);
    expect(paths).not.toContain("skill.json"); // excluded from delivery
  });

  it("includes the bureau skill named 'bureau' (so the command is /bureau)", () => {
    const cat = loadSkillCatalog(SKILLS_DIR);
    const b = cat.listSkills().find((s) => s.id === "bureau");
    expect(b).toBeDefined();
    const resolved = cat.readSkill("bureau");
    const paths = resolved.files.map((f) => f.relpath);
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("patterns.md");
    const skillMd = resolved.files.find((f) => f.relpath === "SKILL.md")!.content;
    expect(skillMd).toMatch(/^name:\s*bureau\s*$/m); // frontmatter name is literally 'bureau'
    expect(skillMd).toContain("bureau_discover"); // orient-first is present
  });
});
