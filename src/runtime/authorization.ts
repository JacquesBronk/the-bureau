import type { McpServer, ToolCallback, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat, AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { isToolAllowed } from "../mcp-profiles.js";
import type { ProfileName } from "../mcp-profiles.js";
import { capabilityAllowsTool } from "./capability.js";
import type { Capability } from "./capability.js";
import type { ContextResolver } from "./connection-context.js";

function denied(toolName: string, loadout: string) {
  return {
    isError: true as const,
    content: [{
      type: "text" as const,
      text: `Tool "${toolName}" is not available in the "${loadout}" loadout.`,
    }],
  };
}

/** Wrap `server.registerTool` so every tool call is authorized against the
 *  caller's per-connection loadout (D3 / ADR-012 R4). A call to a tool not in
 *  `getContext(extra).loadout` is rejected (fail-closed) without running the
 *  handler. If the context lookup throws (unknown/closed session), also reject.
 *
 *  Install this BEFORE the activity/enrichment wrappers so it is OUTERMOST at
 *  call time — a rejected call records no activity and runs no enrichment.
 *  HTTP mode only; stdio never installs it (registration-time gating suffices). */
export function installAuthorizationInterceptor(
  server: McpServer,
  getContext: ContextResolver,
): void {
  const orig = server.registerTool.bind(server);
  (server as { registerTool: typeof orig }).registerTool = <
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>
  ): RegisteredTool =>
    orig(name, config, (async (...args: unknown[]) => {
      let ctx: { loadout: ProfileName; capability?: Capability };
      try {
        ctx = getContext(args[1] as { sessionId?: string } | undefined);
      } catch {
        // Unknown/closed session — fail closed.
        return denied(name, "unknown");
      }
      if (ctx.capability) {
        if (!capabilityAllowsTool(name, ctx.capability)) {
          return denied(name, "capability");
        }
      } else {
        if (!isToolAllowed(name, ctx.loadout)) {
          return denied(name, ctx.loadout);
        }
      }
      return (cb as unknown as (...a: unknown[]) => unknown)(...args);
    }) as unknown as ToolCallback<InputArgs>);
}
