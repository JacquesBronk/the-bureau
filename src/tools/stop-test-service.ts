import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { TestServiceManager } from "../spawn/test-service-manager.js";

export function registerStopTestService(
  server: McpServer,
  manager: TestServiceManager,
): void {
  registerInstrumentedTool(
    server,
    "stop_test_service",
    {
      title: "Stop Test Service",
      description:
        "Immediately stop a running test service and release its k8s resources. " +
        "Call this when tests are done — services also stop automatically on " +
        "graph completion or lease expiry.",
      inputSchema: z.object({
        serviceId: z.string().describe("Service ID returned by start_test_service"),
      }),
    },
    async ({ serviceId }) => {
      await manager.stopService(serviceId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, serviceId }) }],
      };
    },
  );
}
