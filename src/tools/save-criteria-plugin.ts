import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function registerSaveCriteriaPlugin(
  server: McpServer,
  pluginsDir: string,
): void {
  registerInstrumentedTool(server,
    "save_criteria_plugin",
    {
      title: "Save Criteria Plugin",
      description: "Promote a working inline criterion to a named, reusable plugin. Creates the plugin directory, writes plugin.json and the entrypoint script, and commits to git.",
      inputSchema: z.object({
        name: z.string().describe("Plugin name (kebab-case, used as directory name)"),
        description: z.string().describe("What the plugin checks"),
        tags: z.array(z.string()).describe("Categorization tags"),
        script: z.string().describe("Script content for the entrypoint"),
        entrypoint: z.string().default("check.sh").describe("Entrypoint filename"),
        inputs: z.record(z.object({
          description: z.string(),
          required: z.boolean().optional(),
          default: z.string().optional(),
        })).optional().describe("Input declarations"),
      }),
    },
    async ({ name, description, tags, script, entrypoint, inputs }) => {
      const pluginDir = join(pluginsDir, name);
      await mkdir(pluginDir, { recursive: true });

      const manifest = {
        name,
        version: "1.0.0",
        description,
        tags,
        entrypoint,
        inputs: inputs || {},
      };

      await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
      await writeFile(join(pluginDir, entrypoint), script);
      await chmod(join(pluginDir, entrypoint), 0o755);

      try {
        await execFileAsync("git", ["add", pluginDir], { cwd: pluginsDir });
        await execFileAsync("git", ["commit", "-m", `feat(criteria): add ${name} plugin`], { cwd: pluginsDir });
      } catch {
        // Git commit may fail if no git repo — that's OK
      }

      return {
        content: [{
          type: "text" as const,
          text: `Plugin '${name}' saved to plugins/criteria/${name}/\nEntrypoint: ${entrypoint}\nInputs: ${Object.keys(inputs || {}).join(", ") || "(none)"}`,
        }],
      };
    },
  );
}
