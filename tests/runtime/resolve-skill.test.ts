import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadSkillCatalog } from "../../src/runtime/resolve-skill.js";

const SKILLS_DIR = resolve(__dirname, "../../skills");

describe("loadSkillCatalog", () => {
  it("loads the example skill from the catalog", () => {
    const catalog = loadSkillCatalog(SKILLS_DIR);
    const example = catalog.entries.find((e) => e.id === "example");
    expect(example).toBeDefined();
    expect(example).toMatchObject({ id: "example", name: "example" });
    expect(typeof example!.version).toBe("string");
    expect(example!.description.length).toBeGreaterThan(0);
  });

  it("returns an empty catalog for a missing directory (does not throw)", () => {
    const catalog = loadSkillCatalog("/no/such/dir");
    expect(catalog.entries).toEqual([]);
    expect(catalog.listSkills()).toEqual([]);
  });

  describe("listSkills", () => {
    it("includes example with a positive fileCount", () => {
      const catalog = loadSkillCatalog(SKILLS_DIR);
      const example = catalog.listSkills().find((s) => s.id === "example");
      expect(example).toBeDefined();
      expect(example!.fileCount).toBeGreaterThanOrEqual(1);
      expect(example!.version).toBe("0.1.0");
    });
  });

  describe("readSkill", () => {
    it("returns the file set with correct relpaths and excludes skill.json", () => {
      const catalog = loadSkillCatalog(SKILLS_DIR);
      const skill = catalog.readSkill("example");
      expect(skill).toMatchObject({ id: "example", name: "example", version: "0.1.0" });
      const relpaths = skill.files.map((f) => f.relpath);
      expect(relpaths).toContain("SKILL.md");
      expect(relpaths).not.toContain("skill.json");
      const skillMd = skill.files.find((f) => f.relpath === "SKILL.md");
      expect(skillMd!.content).toContain("Example");
    });

    it("throws a clear error on an unknown id", () => {
      const catalog = loadSkillCatalog(SKILLS_DIR);
      expect(() => catalog.readSkill("nope")).toThrow(/unknown skill "nope"/);
    });
  });
});
