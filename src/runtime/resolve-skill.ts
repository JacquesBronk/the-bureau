import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import type { SkillEntry, SkillFile, SkillSummary, ResolvedSkill } from "../types/skill.js";

/** skill.json manifest shape — validated on load (fail loud on a malformed catalog entry). */
const SkillManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
});

/** A loaded skill catalog: a validated entry list plus readers for listing and delivery. */
export interface SkillCatalog {
  /** All catalog entries, in directory order. */
  entries: SkillEntry[];
  /** Listing rows: metadata + file count for each skill. */
  listSkills(): SkillSummary[];
  /** Resolve one skill's full file set for delivery (skill.json excluded). Throws on unknown id. */
  readSkill(id: string): ResolvedSkill;
}

/**
 * Load the skill catalog by scanning skillsDir for <id>/skill.json entries.
 * Mirrors loadAgentManifest/scanAgentFiles: readdirSync over a dir, zod-validated
 * manifests, tolerant of a missing directory (returns an empty catalog).
 */
export function loadSkillCatalog(skillsDir: string): SkillCatalog {
  const entries = scanSkillDirs(skillsDir);

  return {
    entries,
    listSkills(): SkillSummary[] {
      return entries.map((e) => ({
        ...e,
        fileCount: collectSkillFiles(join(skillsDir, e.id)).length,
      }));
    },
    readSkill(id: string): ResolvedSkill {
      const entry = entries.find((e) => e.id === id);
      if (!entry) {
        const available = entries.map((e) => e.id).join(", ") || "(none)";
        throw new Error(`unknown skill "${id}" — available: ${available}`);
      }
      return {
        id: entry.id,
        name: entry.name,
        version: entry.version,
        files: collectSkillFiles(join(skillsDir, entry.id)),
      };
    },
  };
}

/** Scan skillsDir for subdirs containing a valid skill.json; build SkillEntry[]. */
function scanSkillDirs(skillsDir: string): SkillEntry[] {
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = join(skillsDir, dirent.name, "skill.json");
    if (!existsSync(manifestPath)) continue;
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const parsed = SkillManifestSchema.parse(raw);
    if (parsed.id !== dirent.name) {
      throw new Error(`skill.json id "${parsed.id}" must match directory name "${dirent.name}"`);
    }
    skills.push(parsed);
  }
  return skills;
}

/**
 * Recursively collect a skill's files relative to its dir, EXCLUDING skill.json
 * (catalog metadata, not a skill file). Recurses subdirs like evals/.
 */
function collectSkillFiles(skillDir: string): SkillFile[] {
  const files: SkillFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const relpath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(join(dir, dirent.name), relpath);
      } else if (dirent.isFile()) {
        if (prefix === "" && dirent.name === "skill.json") continue;
        files.push({ relpath, content: readFileSync(join(dir, dirent.name), "utf-8") });
      }
    }
  };
  walk(skillDir, "");
  return files;
}

/** Default catalog dir resolution, mirroring how the engine resolves agentsDir at runtime. */
export function defaultSkillsDir(baseDir: string): string {
  return process.env.SKILLS_DIR || resolve(baseDir, "..", "skills");
}
