import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import { loadAgentManifest } from "../runtime/resolve-agent.js";

export interface ModelInfo {
  name: string;
  description?: string;
  tags?: string[];
  maxTokens?: number;
}

export interface ListModelsResult {
  /** Provider queried, or null when no gateway provider is configured. */
  provider: string | null;
  /** baseUrl queried, or null when no gateway provider is configured. */
  baseUrl: string | null;
  models: ModelInfo[];
  /** Set when the result degraded gracefully (no gateway configured, or gateway unreachable). */
  providerUnavailable?: boolean;
  /** Human-readable explanation when providerUnavailable is set. */
  reason?: string;
}

/** Core handler — separated from MCP registration so tests can call it directly. */
export function buildListModelsHandler(agentsDir: string) {
  return async (input: { provider?: string }): Promise<ListModelsResult> => {
    const manifest = loadAgentManifest(agentsDir);
    const providers = manifest.providers ?? {};

    let providerName: string;
    let baseUrl: string;
    let authEnv: string;

    if (input.provider) {
      const def = providers[input.provider];
      if (!def) throw new Error(`Unknown provider "${input.provider}" — not in agents.json`);
      if (!def.baseUrl) throw new Error(`Provider "${input.provider}" has no baseUrl — cannot query models`);
      providerName = input.provider;
      baseUrl = def.baseUrl;
      authEnv = def.auth.env;
    } else {
      // Auto-discover: first provider with a baseUrl and gateway auth.
      // No gateway configured (e.g. direct-Anthropic-only) is a normal state, not an error —
      // degrade to a structured empty result so callers (model pickers) can render it (#303).
      const entry = Object.entries(providers).find(
        ([, def]) => def.baseUrl && def.auth.mode === "gateway",
      );
      if (!entry) {
        return {
          provider: null,
          baseUrl: null,
          models: [],
          providerUnavailable: true,
          reason: "no gateway provider configured (no provider with a baseUrl and gateway auth in agents.json)",
        };
      }
      [providerName, { baseUrl, auth: { env: authEnv } }] = entry as [string, { baseUrl: string; auth: { env: string } }];
    }

    const key = process.env[authEnv] ?? "";
    // A configured-but-unreachable gateway surfaces as a fetch rejection (TypeError: fetch
    // failed). Degrade to a structured result rather than propagating a raw error (#303).
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/model/info`, {
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch (err) {
      return {
        provider: providerName,
        baseUrl,
        models: [],
        providerUnavailable: true,
        reason: `gateway unreachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!res.ok) {
      throw new Error(`LiteLLM /model/info returned ${res.status} ${res.statusText}`);
    }

    const body = await res.json() as { data?: Array<{ model_name: string; model_info?: { description?: string; tags?: string[]; max_tokens?: number } }> };
    const models: ModelInfo[] = (body.data ?? []).map((entry) => {
      const info = entry.model_info;
      const m: ModelInfo = { name: entry.model_name };
      if (info?.description) m.description = info.description;
      if (info?.tags?.length) m.tags = info.tags;
      if (info?.max_tokens) m.maxTokens = info.max_tokens;
      return m;
    });

    return { provider: providerName, baseUrl, models };
  };
}

export function registerListModels(server: McpServer, agentsDir: string): void {
  const handler = buildListModelsHandler(agentsDir);
  registerInstrumentedTool(
    server,
    "list_models",
    {
      title: "List Models",
      description: [
        "Query a LiteLLM gateway provider and return its available models with metadata.",
        "",
        "Use during task-graph setup to discover what local models are available, their",
        "context window sizes, and their intended use cases (description + tags), then",
        "select the right model for the task.",
        "",
        "If no provider is specified, auto-discovers the first configured gateway provider.",
        "Providers with no baseUrl (e.g. direct Anthropic) are not queryable.",
        "",
        "If no gateway is configured or the gateway is unreachable, returns a structured",
        "result with models: [] and providerUnavailable: true (plus a reason) rather than",
        "erroring — so a model picker can degrade gracefully.",
      ].join("\n"),
      inputSchema: z.object({
        provider: z.string().optional().describe(
          "Provider key from agents.json (e.g. 'local-qwen'). Omit to auto-discover.",
        ),
      }),
    },
    async (input) => {
      try {
        const result = await handler(input);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
