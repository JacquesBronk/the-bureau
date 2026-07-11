import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { ImageCatalog } from "../spawn/image-catalog.js";
import type { ContextResolver } from "../runtime/connection-context.js";

export function registerRegisterImage(
  server: McpServer,
  catalog: ImageCatalog,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(
    server,
    "register_image",
    {
      title: "Register Test Image",
      description:
        "Add a container image to the approved catalog for use with start_test_service. " +
        "Any authenticated Bureau user can register images (V1). " +
        "Example: register_image({image: 'redis:7.2'}).",
      inputSchema: z.object({
        image: z.string().describe("Image reference, e.g. 'redis:7' or 'postgres:16.3'"),
      }),
    },
    async ({ image }, extra) => {
      const ctx = getContext(extra);
      await catalog.register(image, ctx.sessionId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, image, registeredBy: ctx.sessionId }) }],
      };
    },
    getContext,
  );
}
