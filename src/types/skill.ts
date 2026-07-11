// Skill catalog types (mirror src/types/agent.ts).
// A skill is a client-side Claude Code construct the engine serves over HTTP:
// install_skill returns the files and the connected agent writes them to disk.

/** A validated catalog entry, parsed from skills/<id>/skill.json. */
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  version: string;
}

/** One file belonging to a skill, relative to skills/<id>/. */
export interface SkillFile {
  /** Path relative to skills/<id>/ (e.g. "SKILL.md" or "evals/basic.md"). */
  relpath: string;
  content: string;
}

/** Lightweight listing row (skill.json metadata + file count). */
export interface SkillSummary extends SkillEntry {
  fileCount: number;
}

/** A skill resolved for delivery: metadata + its full file set (skill.json excluded). */
export interface ResolvedSkill {
  id: string;
  name: string;
  version: string;
  files: SkillFile[];
}
