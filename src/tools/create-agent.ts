import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import { openForgejoPR } from "../forgejo.js";
import { logger } from "../logger.js";

const FORBIDDEN_TEMPLATES = new Set(["coordinator", "full", "operator"]);
const VALID_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

export interface CreateAgentResult {
  role: string;
  file: string;
  prUrl: string | null;
}

/**
 * Core handler — separated from MCP registration so tests can call it directly
 * without spinning up a real McpServer.
 */
export function buildCreateAgentHandler(agentsDir: string) {
  return async (input: {
    id: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    model: string;
    effort: string;
    template: string;
    provider?: string;
    body: string;
  }): Promise<CreateAgentResult> => {
    const { id, name, description, category, tags, model, effort, template, provider, body } = input;

    if (!VALID_ID_RE.test(id)) {
      throw new Error(`Agent id must match /^[a-z][a-z0-9-]{0,62}$/, got: "${id}"`);
    }
    if (FORBIDDEN_TEMPLATES.has(template)) {
      throw new Error(`Dynamic agents cannot use template "${template}" — choose minimal or nano`);
    }

    const frontmatter = [
      "---",
      `id: ${id}`,
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(description)}`,
      `category: ${category}`,
      `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
      `model: ${JSON.stringify(model)}`,
      `effort: ${effort}`,
      `template: ${JSON.stringify(template)}`,
      ...(provider ? [`provider: ${JSON.stringify(provider)}`] : []),
      "---",
      "",
    ].join("\n");

    const fileContent = `${frontmatter}${body.trim()}\n`;
    const relPath = `agents/dynamic/${id}.md`;
    const dynamicDir = resolve(agentsDir, "dynamic");
    mkdirSync(dynamicDir, { recursive: true });
    writeFileSync(resolve(dynamicDir, `${id}.md`), fileContent, "utf-8");

    logger.info({ role: id, template, provider }, "dynamic agent created");

    const prUrl = await openForgejoPR({ agentId: id, relPath, content: fileContent });

    return { role: id, file: `dynamic/${id}.md`, prUrl };
  };
}

export function registerCreateAgent(server: McpServer, agentsDir: string): void {
  const handler = buildCreateAgentHandler(agentsDir);

  registerInstrumentedTool(
    server,
    "create_agent",
    {
      title: "Create Agent",
      description: [
        "Author a new agent role at runtime and make it immediately available for dispatch.",
        "",
        "Writes agents/dynamic/<id>.md to the live agent store and opens an export-back PR",
        "to claude/the-bureau so the definition survives a PVC reset.",
        "",
        "Guardrails:",
        "- id must match /^[a-z][a-z0-9-]{0,62}$/",
        "- template must be 'minimal' or 'nano' (coordinator/full/operator are forbidden)",
        "- provider must be a known provider key (e.g. 'local-qwen', 'anthropic')",
        "",
        "Returns the new role id (usable immediately in declare_task_graph) and the PR URL.",
        "If called twice with the same id, the file write is idempotent (overwrites) but the PR export",
        "returns null (Forgejo rejects the duplicate file push).",
      ].join("\n"),
      inputSchema: z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "id must be lowercase kebab-case"),
        name: z.string().min(1),
        description: z.string().min(1),
        category: z.enum(["planning", "implementation", "quality", "testing", "infrastructure", "documentation", "research", "operations"]),
        tags: z.array(z.string()).default([]),
        model: z.string().default("haiku"),
        effort: z.enum(["low", "medium", "high"]).default("medium"),
        template: z.string().default("minimal").describe("nano or minimal only for dynamic agents"),
        provider: z.string().optional().describe("Named provider key from agents.json providers (omit for default Anthropic)"),
        body: z.string().min(1).describe("Markdown body of the agent prompt (after the frontmatter)"),
      }),
    },
    async (input) => {
      try {
        const result = await handler(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
