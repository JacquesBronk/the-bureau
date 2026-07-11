import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { SkillCatalog } from "../runtime/resolve-skill.js";

export function registerInstallSkill(server: McpServer, catalog: SkillCatalog): void {
  registerInstrumentedTool(
    server,
    "install_skill",
    {
      title: "Install Skill",
      description: [
        "Fetch a first-party skill's files so you can install it into this Claude Code client.",
        "",
        "The engine is reached over HTTP and CANNOT write your filesystem, so this tool does",
        "NOT write any files. It RETURNS the skill's files; YOU (the agent) must write each one.",
        "",
        "For every entry in the returned `files` array, write its `content` to",
        "`~/.claude/skills/<id>/<relpath>` (the user-global default; a project-local",
        "`.claude/skills/<id>/` is an acceptable alternative). Preserve subdirectories in",
        "`relpath` (e.g. create `evals/` when a relpath contains it). After writing every",
        "file, relay the returned `postInstall` note to the user.",
        "",
        "Use list_skills to discover available skill ids.",
      ].join("\n"),
      inputSchema: z.object({
        id: z.string().describe("The skill id to install (from list_skills)."),
      }),
    },
    async ({ id }) => {
      let skill;
      try {
        skill = catalog.readSkill(id);
      } catch {
        const available = catalog.listSkills().map((s) => s.id).join(", ") || "(none)";
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown skill "${id}". Available skills: ${available}.`,
            },
          ],
          isError: true,
        };
      }

      const targetDir = `~/.claude/skills/${skill.id}`;
      const postInstall =
        `Wrote ${skill.files.length} file(s) to ${targetDir}/. ` +
        `Skills load at session start — restart Claude Code (or start a new session) to activate ${skill.name}.`;

      const payload = {
        id: skill.id,
        name: skill.name,
        version: skill.version,
        targetDir,
        files: skill.files,
        postInstall,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
