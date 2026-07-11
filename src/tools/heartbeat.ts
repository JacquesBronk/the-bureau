import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { RedisClient } from "../redis.js";
import type { ContextResolver } from "../runtime/connection-context.js";
import type { TestServiceManager } from "../spawn/test-service-manager.js";
import { logger } from "../logger.js";

const DEFAULT_LEASE_EXTENSION_SECONDS = 60;

export function registerHeartbeat(
  server: McpServer,
  redis: RedisClient,
  getContext: ContextResolver,
  testServiceManager?: TestServiceManager,
): void {
  registerInstrumentedTool(
    server,
    "heartbeat",
    {
      title: "Heartbeat",
      description:
        "Cheap liveness signal. Call once at the start of every turn. The engine delivers any pending directives and peer messages on this response. Returns {ok:true}.",
      inputSchema: z.object({}),
    },
    async (_args, extra) => {
      const ctx = getContext(extra);
      logger.debug({ tool: "heartbeat", sessionId: ctx.sessionId }, "tool call");

      // Update MCP-level heartbeat marker (best-effort — never block the response)
      redis.hset(
        `heartbeat:mcp:${ctx.sessionId}`,
        "ts", Math.floor(Date.now() / 1000).toString(),
        "status", "alive",
      ).catch(() => {});
      redis.expire(`heartbeat:mcp:${ctx.sessionId}`, 120).catch(() => {});

      // Auto-extend active test service leases for this session
      if (testServiceManager) {
        testServiceManager.listForTask(ctx.sessionId).then(services => {
          return Promise.all(
            services
              .filter(s => s.status !== "stopped" && s.status !== "expired")
              .map(s => testServiceManager.extendLease(s.serviceId, DEFAULT_LEASE_EXTENSION_SECONDS))
          );
        }).catch(err => {
          logger.warn({ sessionId: ctx.sessionId, err: String(err) }, "heartbeat: lease extension failed");
        });
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
      };
    },
    getContext,
  );
}
