import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { TestServiceManager } from "../spawn/test-service-manager.js";

export function registerExtendLease(
  server: McpServer,
  manager: TestServiceManager,
): void {
  registerInstrumentedTool(
    server,
    "extend_lease",
    {
      title: "Extend Test Service Lease",
      description:
        "Extend the lease on a running test service. Use when a test will run longer than " +
        "the initial leaseTtlSeconds. The new TTL is set absolutely from now, not added " +
        "to the remaining time.",
      inputSchema: z.object({
        serviceId: z.string().describe("Service ID returned by start_test_service"),
        leaseTtlSeconds: z.number().int().min(30).max(1800).describe("New TTL from now"),
      }),
    },
    async ({ serviceId, leaseTtlSeconds }) => {
      const alloc = await manager.get(serviceId);
      if (!alloc) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "service_not_found", serviceId }) }],
          isError: true,
        };
      }
      const newExpiry = await manager.extendLease(serviceId, leaseTtlSeconds);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ serviceId, leaseExpiresAt: newExpiry }) }],
      };
    },
  );
}
