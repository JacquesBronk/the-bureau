import { resolveAllowedServers, type McpServerEntry } from "./registry.js";
import { formatCapabilityNote } from "../workspace/enrichment.js";
import type { DirectiveRecord } from "../directives.js";

/** Pure composition: decides whether a one-time MCP-capability-awareness directive
 *  should be delivered to a newly-connected worker, and what it should contain.
 *
 *  Extracted so the wiring contract (registry + project → directive) is independently
 *  unit-testable without standing up the full mcp-server.ts singleton or a live Redis
 *  connection — mirrors http-transport.ts's `resolveSurfaceArgs` precedent.
 *
 *  Returns `undefined` (no directive) when: the registry is empty (the engine-wide
 *  no-op default), the worker has no graph/task identity (directives are keyed by
 *  graphId+taskId), or the project has no allowed servers — degrade, never fail.
 *  Callers are responsible for the actual `pushDirective(redis, ...)` write; this
 *  function performs no I/O. */
export function buildCapabilityNoteDirective(
  mcpRegistry: McpServerEntry[],
  project: string | undefined,
  graphId: string | undefined,
  taskId: string | undefined,
): Omit<DirectiveRecord, "id"> | undefined {
  if (mcpRegistry.length === 0 || !graphId || !taskId) return undefined;
  const allowed = resolveAllowedServers(mcpRegistry, project);
  const message = formatCapabilityNote(allowed);
  if (!message) return undefined;
  return {
    author: "mcp-gateway",
    message,
    ts: Date.now(),
    provenance: { subject: "mcp-gateway-capability-note", graphId, taskId },
  };
}
