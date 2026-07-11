import type { Capability } from "../runtime/capability.js";
import type { McpGateway } from "./gateway.js";
import { resolveAllowedServers, type McpServerEntry } from "./registry.js";
import { augmentCapabilityWithProxyTools, proxyToolName } from "./proxy-tools.js";

/** Augment a worker's call-time capability with its allowed proxy-tool names, so the
 *  call-time authorization interceptor (capabilityAllowsTool) permits them — mirrors
 *  the registration-time augmentation that gates `buildSurface`'s tool registration.
 *
 *  P1: must use proxyToolName() (the same namespacing+truncation `registerProxyTools`
 *  uses at registration time), not an inline template — an inline `${e.name}__${t.name}`
 *  diverges for names needing the hash branch and the interceptor would then DENY the
 *  registered (correctly-named) tool.
 *
 *  Mirrors registerProxyTools' degrade-never-fail behavior (the same isDegraded skip +
 *  per-entry try/catch): a down/slow upstream MCP server must not fail worker
 *  authentication for every worker, only omit that server's proxy tools from this
 *  connection's allowlist.
 *
 *  A no-op (returns `capability` unchanged) when the registry is empty — the default,
 *  no-`BUREAU_MCP_REGISTRY_FILE` case. */
export async function augmentCapabilityForCallTime(
  mcpGateway: McpGateway,
  mcpRegistry: McpServerEntry[],
  project: string | undefined,
  capability: Capability,
): Promise<Capability> {
  if (mcpRegistry.length === 0) return capability;
  const allowed = resolveAllowedServers(mcpRegistry, project);
  const names: string[] = [];
  for (const e of allowed) {
    if (mcpGateway.isDegraded(e.name)) continue;
    try {
      for (const t of await mcpGateway.introspect(e.name)) names.push(proxyToolName(e.name, t.name));
    } catch {
      continue;
    }
  }
  return augmentCapabilityWithProxyTools(capability, names);
}
