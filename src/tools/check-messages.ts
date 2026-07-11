import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { Messaging } from "../messaging.js";
import type { PeerRegistry } from "../registry.js";
import { parseStreamMessages, getStreamLatestId } from "../redis.js";
import type { RedisClient } from "../redis.js";
import { logger } from "../logger.js";
import type { ContextResolver } from "../runtime/connection-context.js";
export function registerCheckMessages(
  server: McpServer,
  messaging: Messaging,
  registry: PeerRegistry,
  getContext: ContextResolver,
  redis: RedisClient,
  eventCursors: Map<string, string>,
): void {
  registerInstrumentedTool(server,
    "check_messages",
    {
      title: "Check Messages",
      description: "Check for new messages in your inbox, project broadcasts, and task graph events. Call this frequently between tasks.",
      inputSchema: z.object({
        project: z.string().optional().describe("Also check broadcast and events for this project"),
      }),
    },
    async ({ project }, extra) => {
      const ctx = getContext(extra);
      logger.debug({ tool: 'check_messages', project }, 'tool call');
      await registry.applyPeerUpdate(ctx.sessionId, { lastActivity: Date.now() });

      const inboxMessages = await messaging.checkMessages(ctx.sessionId);
      const broadcastMessages = project
        ? await messaging.checkBroadcasts(project)
        : [];

      let events: any[] = [];
      if (project) {
        // Per-session cursor key: each HTTP session (unique sessionId) advances its own
        // cursor independently. Stdio mode has one fixed sessionId so this is unchanged
        // for the single-session case.
        const cursorKey = `${ctx.sessionId}:${project}`;
        let cursor = eventCursors.get(cursorKey);
        if (cursor === undefined) {
          // Lazy seed: seed to the current stream head on first access so a new session
          // only sees events published after it started, not the full history (issue #75).
          cursor = await getStreamLatestId(redis, `events:${project}`);
          eventCursors.set(cursorKey, cursor);
        }
        const results = await redis.xread(
          "COUNT", 100,
          "STREAMS", `events:${project}`,
          cursor,
        );
        if (results) {
          const [, entries] = results[0] as [string, [string, string[]][]];
          for (const [streamId, fields] of entries) {
            const parsed = parseStreamMessages(fields);
            // task_progress events are status updates from sibling agents — only
            // useful to the orchestrator via monitor_graph/await_graph_event.
            // Exclude them here to prevent inbox flooding.
            if (parsed.type !== "task_progress") {
              events.push({
                ...parsed,
                channel: `events:${project}`,
                timestamp: parseInt(parsed.timestamp, 10),
              });
            }
            eventCursors.set(cursorKey, streamId);
          }
        }
      }

      const all = [
        ...inboxMessages.map((m) => ({ ...m, channel: "inbox" })),
        ...broadcastMessages.map((m) => ({ ...m, channel: `broadcast:${project}` })),
        ...events,
      ];

      if (all.length === 0) {
        return { content: [{ type: "text" as const, text: "No new messages." }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(all, null, 2) }] };
    },
    getContext,
  );
}
