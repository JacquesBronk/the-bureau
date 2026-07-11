import { createRequire } from "node:module";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { Redis } from "ioredis";
import type { PeerRegistry } from "../registry.js";
import type { GraphStatus } from "../types/graph.js";
import { scanKeys } from "../redis.js";
import type { BureauHealthOutput } from "../types/api.js";

declare const BUNDLE_VERSION: string | undefined;
declare const BUNDLE_NAME: string | undefined;

const pkg = typeof BUNDLE_VERSION !== "undefined"
  ? { name: BUNDLE_NAME!, version: BUNDLE_VERSION! }
  : (() => { const r = createRequire(import.meta.url); return r("../../package.json"); })();

// #317 phase3 pre-merge sweep item 5(a): `reworking` is a non-terminal status with
// live children (a fix or re-validation child graph is in flight) — the same as
// `active`/`validating` from a health-reporting standpoint. Omitting it under-counts
// active work while the auto-rework loop is mid-round.
const ACTIVE_GRAPH_STATUSES: ReadonlySet<GraphStatus> = new Set<GraphStatus>(["active", "validating", "reworking"]);

export async function buildBureauHealth(
  registry: PeerRegistry,
  redis: Redis,
): Promise<BureauHealthOutput> {
  const uptime = Math.round(process.uptime());

  const mem = process.memoryUsage();
  const memory = {
    rss: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
    heapUsed: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
  };

  const peers = await registry.listPeers();
  const activePeers = peers.length;

  const allKeys = await scanKeys(redis, "graph:*");
  const graphKeys = allKeys.filter((k) => /^graph:[^:]+$/.test(k));
  const statuses = await Promise.all(
    graphKeys.map(async (key) => {
      try {
        const raw = await redis.get(key);
        if (!raw) return null;
        return (JSON.parse(raw) as { status?: string }).status ?? null;
      } catch {
        return null;
      }
    }),
  );
  const activeGraphs = statuses.filter(
    (s) => s !== null && ACTIVE_GRAPH_STATUSES.has(s as GraphStatus),
  ).length;

  let redisPingMs: number | null = null;
  try {
    const start = Date.now();
    await redis.ping();
    redisPingMs = Date.now() - start;
  } catch { /* redis down */ }

  return { version: pkg.version, uptime, memory, activePeers, activeGraphs, redis: { pingMs: redisPingMs } };
}

export function registerBureauHealth(
  server: McpServer,
  registry: PeerRegistry,
  redis: Redis,
): void {
  registerInstrumentedTool(server,
    "bureau_health",
    {
      title: "Bureau Health",
      description: [
        "Returns a structured health snapshot of the Bureau MCP server.",
        "",
        "Includes: process uptime, memory usage (RSS and heap in MB), active peer count,",
        "active graph count, Redis ping latency (ms), and server version.",
        "",
        "Use this to quickly verify the server is healthy and to diagnose resource issues.",
      ].join("\n"),
      inputSchema: z.object({}),
    },
    async () => {
      const result = await buildBureauHealth(registry, redis);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
