import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { Redis } from "ioredis";
import { scanKeys } from "../redis.js";
import type { ListGraphsOutput } from "../types/api.js";

export function registerListGraphs(server: McpServer, redis: Redis): void {
  registerInstrumentedTool(server,
    "list_graphs",
    {
      title: "List Graphs",
      description: "List all task graphs stored in Redis with their status, task count, and age.",
      inputSchema: z.object({}),
    },
    async () => {
      const allKeys = await scanKeys(redis, "graph:*");
      const graphKeys = allKeys.filter((k) => /^graph:[^:]+$/.test(k));

      const graphs = await Promise.all(
        graphKeys.map(async (key) => {
          const graphId = key.slice("graph:".length);
          try {
            const raw = await redis.get(key);
            if (!raw) return null;
            const data = JSON.parse(raw);
            const createdAt = data.createdAt ?? null;
            const age = createdAt
              ? Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)
              : null;
            // Task IDs live in a separate set (`graph:<id>:taskIds`), not inline in the
            // graph record — so read that set's cardinality rather than data.taskIds
            // (which is always undefined, hence the historical null; issue #262).
            const taskCount = Array.isArray(data.taskIds)
              ? data.taskIds.length
              : (data.taskCount ?? (await redis.scard(`graph:${graphId}:taskIds`)) ?? null);
            return {
              graphId,
              project: data.project ?? null,
              status: data.status ?? null,
              taskCount,
              createdAt,
              age,
            };
          } catch {
            return { graphId, project: null, status: null, taskCount: null, createdAt: null, age: null };
          }
        }),
      );

      const result: ListGraphsOutput = graphs.filter((g) => g !== null);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}

export function registerCleanupGraph(server: McpServer, redis: Redis): void {
  registerInstrumentedTool(server,
    "cleanup_graph",
    {
      title: "Cleanup Graph",
      description: "Delete all Redis keys associated with a specific graph ID.",
      inputSchema: z.object({
        graphId: z.string().describe("The graph ID to clean up"),
      }),
    },
    async ({ graphId }) => {
      const patterns = [
        `graph:${graphId}`,
        `graph:${graphId}:tasks:*`,
        `graph:${graphId}:taskIds`,
        `graph:${graphId}:completed`,
        `graph:${graphId}:deps:*`,
        `graph:${graphId}:rdeps:*`,
        `graph:${graphId}:lock:*`,
        `graph:${graphId}:orchestrator`,
        `result:${graphId}:*`,
        `handoff:${graphId}:*`,
        `files:${graphId}:*`,
        `graph:${graphId}:rework:*`,
        `graph:${graphId}:started_flag`,
        `merge:${graphId}:lock`,
      ];

      const keySets = await Promise.all(patterns.map((p) => scanKeys(redis, p)));
      const keys = keySets.flat();

      if (keys.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No keys found for graph ${graphId}.` }],
        };
      }

      const pipeline = redis.pipeline();
      for (const key of keys) {
        pipeline.del(key);
      }
      await pipeline.exec();

      return {
        content: [{ type: "text" as const, text: `Deleted ${keys.length} keys for graph ${graphId}.` }],
      };
    },
  );
}

export function registerCleanupAll(server: McpServer, redis: Redis): void {
  registerInstrumentedTool(server,
    "cleanup_all",
    {
      title: "Cleanup All",
      description: "Nuclear option: delete ALL the-bureau Redis keys. Requires confirm=true.",
      inputSchema: z.object({
        confirm: z.boolean().describe("Must be true to proceed with deletion"),
      }),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return {
          content: [{ type: "text" as const, text: "Aborted: confirm must be true to delete all keys." }],
        };
      }

      const patterns = [
        "graph:*",
        "events:*",
        "broadcast:*",
        "peers:*",
        "handoff:*",
        "result:*",
        "files:*",
        "metrics:*",
        "process:*",
        "merge:*",
        "deadagent:*",
      ];

      const keySets = await Promise.all(patterns.map((p) => scanKeys(redis, p)));
      const keys = [...new Set(keySets.flat())];

      if (keys.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No the-bureau keys found in Redis." }],
        };
      }

      const pipeline = redis.pipeline();
      for (const key of keys) {
        pipeline.del(key);
      }
      await pipeline.exec();

      return {
        content: [{ type: "text" as const, text: `Deleted ${keys.length} keys across all the-bureau namespaces.` }],
      };
    },
  );
}

/** Registers all three cleanup tools. Kept for use in tests that register the full bundle. */
export function registerCleanupTools(server: McpServer, redis: Redis): void {
  registerListGraphs(server, redis);
  registerCleanupGraph(server, redis);
  registerCleanupAll(server, redis);
}
