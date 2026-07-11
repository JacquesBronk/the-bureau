import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { RedisClient } from "../redis.js";
import type { ContextResolver } from "../runtime/connection-context.js";
import { pushDirective } from "../directives.js";
import { logger } from "../logger.js";

const MAX_MESSAGE_BYTES = 4096;

// High-confidence secret patterns — size-cap is the primary gate; these catch
// the most common credential leaks before they enter the directive store.
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,                          // AWS access key id
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----/,        // PEM private key
  /xox[baprs]-[0-9A-Za-z-]{10,}/,              // Slack tokens
  /[0-9a-fA-F]{40,}/,                           // Long hex token (40+ chars, e.g. SHA-1 sized secrets)
];

function containsSecret(message: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(message)) return true;
  }
  return false;
}

export function registerInjectContext(
  server: McpServer,
  redis: RedisClient,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(
    server,
    "inject_context",
    {
      title: "Inject Context",
      description:
        "Deliver an engine directive to a running worker. The message is prepended to the worker's next MCP tool response at high salience. Operator-only. Author is derived from the authenticated caller — not a free parameter.",
      inputSchema: z.object({
        graphId: z.string().describe("Target graph ID"),
        taskId: z.string().describe("Target task ID"),
        message: z.string().describe("The directive text to deliver (max 4096 chars)"),
      }),
    },
    async ({ graphId, taskId, message }, extra) => {
      const ctx = getContext(extra);
      logger.debug({ tool: "inject_context", graphId, taskId }, "tool call");

      if (message.length > MAX_MESSAGE_BYTES) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: message exceeds ${MAX_MESSAGE_BYTES} character limit (got ${message.length})`,
            },
          ],
          isError: true,
        };
      }

      if (containsSecret(message)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: message appears to contain a secret or credential — rejected",
            },
          ],
          isError: true,
        };
      }

      const author = ctx.role ?? ctx.sessionId;
      const provenance = {
        subject: ctx.sessionId,
        graphId: ctx.graphId ?? graphId,
        taskId: ctx.taskId ?? taskId,
      };

      const id = await pushDirective(redis, graphId, taskId, {
        author,
        message,
        ts: Date.now(),
        provenance,
      });

      logger.info({ tool: "inject_context", graphId, taskId, id, author }, "directive pushed");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, id }) }],
      };
    },
    getContext,
  );
}
