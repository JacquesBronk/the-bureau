import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { TestServiceManager } from "../spawn/test-service-manager.js";

export function registerListTestServices(
  server: McpServer,
  manager: TestServiceManager,
): void {
  registerInstrumentedTool(
    server,
    "list_test_services",
    {
      title: "List Test Services",
      description: "List all running test services for a graph, with their connection strings and lease expiry times.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph ID to list services for"),
      }),
    },
    async ({ graphId }) => {
      const services = await manager.listForGraph(graphId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(services) }],
      };
    },
  );
}
