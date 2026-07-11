import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Redis } from "ioredis";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { PeerRegistry } from "../registry.js";
import type { SkillCatalog } from "../runtime/resolve-skill.js";
import type { BureauDiscoverOutput } from "../types/api.js";
import { buildListTemplates } from "./list-templates.js";
import { buildListAgents } from "./list-agents.js";
import { buildBureauHealth } from "./bureau-health.js";
import { buildListCriteriaPlugins } from "./list-criteria-plugins.js";
import { buildListModelsHandler, type ListModelsResult } from "./list-models.js";

const MODELS_TIMEOUT_MS = 2000;

export interface BureauDiscoverDeps {
  agentsDir: string;
  pluginsDir: string;
  redis: Redis;
  registry: PeerRegistry;
  skillCatalog: SkillCatalog;
  /**
   * Injectable so unit tests never hit the network. Defaults to the real
   * gateway-querying handler. `models` is the ONLY network-backed section;
   * it is timeout-guarded below so a stalled gateway can't hang orientation.
   */
  listModels?: (input: { provider?: string }) => Promise<ListModelsResult>;
}

const NEXT_STEPS =
  "Declare work with declare_task_graph; attach an engine-enforced validation gate (criteria) " +
  "so acceptance is machine-checked; watch it with observe_events. Run /bureau for the full flow.";

/** Best-effort per section: a thrown section degrades to a fallback, never failing the whole map. */
async function safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

/** A models lookup bounded by MODELS_TIMEOUT_MS, degrading to providerUnavailable on timeout. */
function timedModels(
  listModels: (input: { provider?: string }) => Promise<ListModelsResult>,
): Promise<ListModelsResult> {
  let timer: ReturnType<typeof setTimeout>;
  const onTimeout = new Promise<ListModelsResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ provider: null, baseUrl: null, models: [], providerUnavailable: true, reason: `models lookup exceeded ${MODELS_TIMEOUT_MS}ms` }),
      MODELS_TIMEOUT_MS,
    );
  });
  // list-models never rejects (it catches fetch errors), so the losing promise
  // resolves harmlessly — no unhandled rejection when the race is decided. Clear the
  // timer once the race settles so a fast lookup leaves no pending timeout dangling.
  return Promise.race([listModels({}), onTimeout]).finally(() => clearTimeout(timer));
}

export function buildBureauDiscover(deps: BureauDiscoverDeps): () => Promise<BureauDiscoverOutput> {
  const listModels = deps.listModels ?? buildListModelsHandler(deps.agentsDir);
  return async (): Promise<BureauDiscoverOutput> => {
    const templates = (await safe(() => buildListTemplates(), [])).map((t) => ({
      id: t.id, name: t.name, whenToUse: t.whenToUse, taskCount: t.taskCount,
    }));

    const modelsResult = await safe(
      () => timedModels(listModels),
      { provider: null, baseUrl: null, models: [], providerUnavailable: true, reason: "models lookup failed" } as ListModelsResult,
    );
    const models = (modelsResult.models ?? []).map((m: any) => ({
      name: m.name, description: m.description, maxTokens: m.maxTokens,
    }));

    const agents = (await safe(() => buildListAgents(deps.agentsDir), [])).map((a) => ({
      role: a.role, category: a.category, description: a.description,
    }));

    const criteria = (await safe(() => buildListCriteriaPlugins(deps.pluginsDir), [])).map((c) => ({
      name: c.name, version: c.version, description: c.description,
    }));

    const skills = deps.skillCatalog.listSkills().map((s) => ({
      id: s.id, name: s.name, version: s.version,
    }));

    // Single graph:* scan lives inside buildBureauHealth; activeGraphs is derived from it.
    const health = await safe(
      () => buildBureauHealth(deps.registry, deps.redis),
      { version: "unknown", uptime: 0, memory: { rss: 0, heapUsed: 0 }, activeGraphs: 0, activePeers: 0, redis: { pingMs: null } },
    );

    const out: BureauDiscoverOutput = {
      templates,
      models,
      agents,
      criteria,
      skills,
      activeGraphs: health.activeGraphs,
      health: {
        version: health.version,
        uptime: health.uptime,
        activePeers: health.activePeers,
        redisPingMs: health.redis.pingMs,
      },
      nextSteps: NEXT_STEPS,
    };
    if (modelsResult.providerUnavailable) out.modelsUnavailable = modelsResult.reason;
    return out;
  };
}

export function registerBureauDiscover(server: McpServer, deps: BureauDiscoverDeps): void {
  const handler = buildBureauDiscover(deps);
  registerInstrumentedTool(
    server,
    "bureau_discover",
    {
      title: "Bureau Discover",
      description: [
        "Return a curated orientation map of the live engine: available templates, models,",
        "agents, criteria plugins, installable skills, an active-graph count, and health.",
        "",
        "Call this FIRST when orienting to drive the Bureau — it reflects the current engine,",
        "so you never assume a stale roster. Drill into any section with the matching list_* tool.",
      ].join("\n"),
      inputSchema: z.object({}),
    },
    async () => {
      const result = await handler();
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
