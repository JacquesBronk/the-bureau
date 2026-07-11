import { z } from "zod";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import { discoverAndReport, applySetupChoices, detectDraftBuildConfig, readExistingBuildConfig, writeBuildConfig, removeBuildConfig } from "../bureau-setup.js";
import { BuildConfigError } from "../buildconfig/load.js";

export function registerBureauSetup(server: McpServer): void {
  registerInstrumentedTool(server, 
    "bureau_setup",
    {
      title: "Bureau Setup",
      description:
        "Configure which MCP servers spawned agents inherit, and manage the project's build recipe. " +
        "Run with action='discover' first to see all available MCP servers detected from your config sources " +
        "and to detect the project toolchain, drafting a bureau.buildconfig.json for review. " +
        "Use action='apply' to save your MCP preferences and/or persist a build recipe (pass buildConfig). " +
        "Use action='reset' to remove saved MCP configuration and the build recipe, returning to defaults.",
      inputSchema: z.object({
        action: z
          .enum(["discover", "apply", "reset"])
          .optional()
          .default("discover")
          .describe(
            "'discover' (default): show all detected MCP servers and current config, plus a detected toolchain draft for bureau.buildconfig.json. " +
            "'apply': save setup choices — which servers agents inherit — and/or persist a build recipe via buildConfig. " +
            "'reset': delete .bureau/config.json and bureau.buildconfig.json, returning to defaults."
          ),
        exclude: z
          .array(z.string())
          .optional()
          .describe("Server names to exclude from agent inheritance (used with action='apply')"),
        inherit: z
          .boolean()
          .optional()
          .describe("Whether agents inherit MCP servers at all (used with action='apply'; omit to leave MCP config untouched)"),
        envOverrides: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variable overrides written to .bureau/.env (used with action='apply')"),
        buildConfig: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Build recipe to persist to bureau.buildconfig.json at repo root (used with action='apply'). Same shape as the declare_task_graph buildConfig object."),
      }),
    },
    async ({ action, exclude, inherit, envOverrides, buildConfig }) => {
      const cwd = process.cwd();

      if (action === "discover") {
        const result = discoverAndReport(cwd);

        const lines: string[] = [];

        lines.push("## MCP Server Discovery\n");

        // Sources
        lines.push("### Sources scanned");
        for (const src of result.sources) {
          if (!src.exists) {
            lines.push(`- ${src.path} *(not found)*`);
          } else if (src.servers.length === 0) {
            lines.push(`- ${src.path} *(no servers)*`);
          } else {
            lines.push(`- ${src.path}: ${src.servers.join(", ")}`);
          }
        }
        lines.push("");

        // All servers
        const serverNames = Object.keys(result.allServers);
        if (serverNames.length === 0) {
          lines.push("### Detected servers\nNone found.");
        } else {
          lines.push(`### Detected servers (${serverNames.length})`);
          for (const name of serverNames) {
            const cfg = result.allServers[name];
            const cmd = [cfg.command, ...(cfg.args ?? [])].join(" ");
            lines.push(`- **${name}**: \`${cmd}\``);
          }
        }
        lines.push("");

        // OAuth warnings
        if (result.oauthWarnings.length > 0) {
          lines.push("### OAuth warnings");
          for (const w of result.oauthWarnings) {
            lines.push(`- **${w.serverName}**: ${w.reason}`);
          }
          lines.push("");
        }

        // Current config
        if (result.hasExistingConfig && result.currentConfig) {
          const mc = result.currentConfig.mcp;
          lines.push("### Current .bureau/config.json");
          lines.push(`- inherit: ${mc.inherit ?? true}`);
          if (mc.exclude && mc.exclude.length > 0) {
            lines.push(`- exclude: ${mc.exclude.join(", ")}`);
          } else {
            lines.push("- exclude: (none)");
          }
        } else {
          lines.push("### Current config\nNo .bureau/config.json — defaults apply (inherit all servers).");
        }

        lines.push("");
        lines.push(
          'To save preferences, call again with action=\'apply\', e.g. exclude=["server-name"] and inherit=true.'
        );

        // Build configuration (bureau.buildconfig.json)
        lines.push("");
        lines.push("### Build configuration");
        const existingBc = readExistingBuildConfig(cwd);
        if (existingBc) {
          lines.push("Committed `bureau.buildconfig.json`:");
          for (const s of existingBc.services) {
            lines.push(`- **${s.name ?? s.path}** (${s.language}) test: \`${s.test ?? "(none)"}\``);
          }
        } else {
          lines.push("No committed `bureau.buildconfig.json`.");
        }
        const { draft, detections } = detectDraftBuildConfig(cwd);
        if (draft) {
          lines.push("");
          lines.push("Detected draft (pass to `apply` as `buildConfig` after review):");
          lines.push("```json");
          lines.push(JSON.stringify(draft, null, 2));
          lines.push("```");
        } else {
          lines.push("");
          lines.push(`Toolchain detection was not confident (${detections.map((d) => d.reason).join("; ")}). Author the config manually.`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }

      if (action === "apply") {
        const mcpProvided = inherit !== undefined || exclude !== undefined || envOverrides !== undefined;
        if (!mcpProvided && !buildConfig) {
          return {
            content: [{ type: "text" as const, text: "Error: apply needs at least one of MCP options (inherit/exclude/envOverrides) or buildConfig." }],
            isError: true,
          };
        }

        const parts: string[] = [];

        if (mcpProvided) {
          applySetupChoices(cwd, {
            inherit: inherit ?? true,
            exclude: exclude ?? [],
            envOverrides,
          });
          parts.push(
            `Bureau config saved to .bureau/config.json.`,
            `- inherit: ${inherit ?? true}`,
            `- exclude: ${exclude && exclude.length > 0 ? exclude.join(", ") : "(none)"}`,
          );
          if (envOverrides && Object.keys(envOverrides).length > 0) {
            parts.push(`- env overrides written to .bureau/.env: ${Object.keys(envOverrides).join(", ")}`);
          }
        }

        if (buildConfig) {
          try {
            const written = writeBuildConfig(cwd, buildConfig);
            parts.push(`Wrote bureau.buildconfig.json (${written.services.length} service(s)) — commit it to the repo.`);
          } catch (e) {
            if (e instanceof BuildConfigError) {
              return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
            }
            throw e;
          }
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      }

      // action === "reset"
      const configPath = join(cwd, ".bureau", "config.json");
      const removedConfig = existsSync(configPath);
      if (removedConfig) unlinkSync(configPath);
      const removedBc = removeBuildConfig(cwd);
      const msgs: string[] = [];
      if (removedConfig) msgs.push("Deleted .bureau/config.json.");
      if (removedBc) msgs.push("Deleted bureau.buildconfig.json.");
      if (msgs.length === 0) msgs.push("Nothing to reset.");
      return { content: [{ type: "text" as const, text: msgs.join(" ") }] };
    }
  );
}
