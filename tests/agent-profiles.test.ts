import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const AGENTS_DIR = resolve(__dirname, "../agents");
const VALID_PROFILES = ["minimal", "coordinator"];

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }
  return fields;
}

describe("agent .md frontmatter", () => {
  const mdFiles = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ name: f, path: join(AGENTS_DIR, f) }));

  it("finds at least one agent .md file", () => {
    expect(mdFiles.length).toBeGreaterThan(0);
  });

  for (const { name, path } of mdFiles) {
    it(`${name} has a valid profile field`, () => {
      const content = readFileSync(path, "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm.profile, `${name} missing profile field`).toBeDefined();
      expect(
        VALID_PROFILES,
        `${name} has invalid profile "${fm.profile}"`,
      ).toContain(fm.profile);
    });
  }

  it("coordinator agents have profile: coordinator", () => {
    const coordinatorAgents = [
      "tech-lead.md",
      "release-manager.md",
      "devops.md",
      "self-improvement-coordinator.md",
      "integrator.md",
      "incident-responder.md",
    ];
    for (const filename of coordinatorAgents) {
      const content = readFileSync(join(AGENTS_DIR, filename), "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm.profile, `${filename} should have profile: coordinator`).toBe(
        "coordinator",
      );
    }
  });

  it("non-coordinator agents have profile: minimal", () => {
    const coordinatorSet = new Set([
      "tech-lead.md",
      "release-manager.md",
      "devops.md",
      "self-improvement-coordinator.md",
      "integrator.md",
      "incident-responder.md",
    ]);
    const minimalFiles = mdFiles.filter((f) => !coordinatorSet.has(f.name));
    for (const { name, path } of minimalFiles) {
      const content = readFileSync(path, "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm.profile, `${name} should have profile: minimal`).toBe(
        "minimal",
      );
    }
  });

  it("no agent has profile: full", () => {
    for (const { name, path } of mdFiles) {
      const content = readFileSync(path, "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm.profile, `${name} must not use profile: full`).not.toBe(
        "full",
      );
    }
  });
});
