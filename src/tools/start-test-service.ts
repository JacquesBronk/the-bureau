import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { TestServiceManager } from "../spawn/test-service-manager.js";
import type { ImageCatalog } from "../spawn/image-catalog.js";
import type { ContextResolver } from "../runtime/connection-context.js";
import { logger } from "../logger.js";

export function registerStartTestService(
  server: McpServer,
  manager: TestServiceManager,
  catalog: ImageCatalog,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(
    server,
    "start_test_service",
    {
      title: "Start Test Service",
      description:
        "Start an ephemeral test service (redis or postgres) scoped to the current graph. " +
        "Returns a ready-to-use connection string. The service is automatically cleaned up " +
        "when the graph completes or the lease expires. Images must be in the approved catalog " +
        "(see register_image). Default images: redis:7, postgres:16.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph ID this service belongs to"),
        serviceType: z.enum(["redis", "postgres"]).describe("Service type"),
        leaseTtlSeconds: z.number().int().min(30).max(1800).default(60).describe(
          "Seconds until lease expires if not extended. Heartbeat auto-extends active leases."
        ),
        image: z.string().optional().describe(
          "Override image ref, e.g. 'redis:7.2'. Must be in the approved catalog."
        ),
      }),
    },
    async ({ graphId, serviceType, leaseTtlSeconds, image }, extra) => {
      const ctx = getContext(extra);
      const resolvedImage = image ?? (serviceType === "redis" ? "redis:7" : "postgres:16");

      if (!(await catalog.isApproved(resolvedImage))) {
        logger.warn({ tool: "start_test_service", image: resolvedImage, graphId }, "image not approved");
        void manager.emitImageNotApproved(graphId, ctx.sessionId, serviceType, resolvedImage);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "image_not_approved",
              image: resolvedImage,
              message: `Image "${resolvedImage}" is not in the approved catalog. ` +
                `Call register_image first, or use a pre-approved image.`,
            }),
          }],
          isError: true,
        };
      }

      const alloc = await manager.startService({
        graphId,
        taskId: ctx.sessionId,
        serviceType,
        leaseTtlSeconds,
        image: resolvedImage,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(alloc) }],
      };
    },
    getContext,
  );
}
