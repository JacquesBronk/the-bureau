import { createHash } from "node:crypto";
import type { Capability } from "../runtime/capability.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import { jsonSchemaToZod } from "./json-schema-to-zod.js";
import type { McpGateway, UpstreamTool } from "./gateway.js";
import type { McpServerEntry } from "./registry.js";

const INVALID_CHARS = /[^A-Za-z0-9_-]/g;

/** sha1 over a JSON-encoded [server, tool] pair (unambiguous: JSON.stringify escapes
 *  quotes/backslashes within each string, so distinct pairs never serialize to the
 *  same text) — collision-safe even when the sanitized/truncated components would
 *  otherwise collide, since the hash is taken over the original, unsanitized pair. */
function pairHash(server: string, tool: string): string {
  return createHash("sha1").update(JSON.stringify([server, tool])).digest("hex").slice(0, 6);
}

/** A hash-branch output always ends in exactly `_` + 6 lowercase hex chars (see
 *  below). Reserving that shape exclusively for the hash branch — forcing any
 *  "clean" raw that happens to end the same way into the hash branch too — is
 *  what makes the two branches' output spaces disjoint; without it, a crafted
 *  clean tool name (e.g. "a-_51c084") can reproduce a different pair's
 *  hash-branch output verbatim. */
const HASH_SUFFIX_SHAPE = /_[0-9a-f]{6}$/;

/** Count occurrences of the 2-char substring "__" in `s`, counting overlaps (a
 *  run of k consecutive underscores contains k-1 overlapping occurrences). This
 *  is the complete, general characterization of separator ambiguity for
 *  `X + "__" + Y`: the join is splittable at a literal "__" in exactly one place
 *  — i.e. unambiguous — if and only if this count is exactly 1. A naive
 *  per-component `includes("__")` check misses the boundary-merge case where
 *  neither component contains "__" alone but a trailing underscore on one side
 *  and a leading underscore on the other recombine with the separator into a
 *  longer run, e.g. ("ab_", "cd") and ("ab", "_cd") both join to "ab___cd" (a
 *  run of 3, i.e. 2 overlapping occurrences) — two valid split points, hence
 *  ambiguous; this function returns 2 for that case, correctly flagging it. */
function countSeparatorOccurrences(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === "_" && s[i + 1] === "_") count++;
  }
  return count;
}

/** Namespaced proxy-tool name `<server>__<tool>`, guaranteed valid for the API
 *  tool-name limit ^[A-Za-z0-9_-]{1,64}$ and collision-resistant (no two distinct
 *  (server, tool) pairs deterministically produce the same name — residual risk is
 *  bounded by sha1-truncation collision odds only, same as the rest of this file's
 *  truncation scheme) — `tool` comes from an upstream MCP server's `tools/list`
 *  response, which this registry does not control or validate, so it cannot be
 *  assumed charset-clean, `__`-free, or free of underscores anywhere that could
 *  recombine with the separator at the join boundary.
 *
 *  Characters outside the allowed charset are replaced with `-`. A short stable
 *  hash of the *original* (server, tool) pair is appended whenever: sanitization
 *  changed either component; the joined raw doesn't contain *exactly one*
 *  occurrence of "__" (countSeparatorOccurrences, above — the complete
 *  separator-ambiguity condition, covering both embedded "__" within a component
 *  and boundary-merging across the join); the natural name exceeds 64 chars; or
 *  the natural name already happens to end in the hash branch's own
 *  `_[0-9a-f]{6}` shape (HASH_SUFFIX_SHAPE), which would otherwise let a crafted
 *  clean pair impersonate a different pair's hashed output.
 *
 *  Why this is complete (no remaining deterministic collision): a true clean-
 *  branch output has exactly one valid "__" split point by construction, so a
 *  different (server, tool) pair could only reproduce it via that same split —
 *  i.e. the identical pair. A true clean-branch output also never ends in the
 *  hash-suffix shape (forced into the hash branch otherwise), so it can never
 *  equal a hash-branch output, which always does. Two hash-branch outputs can
 *  only coincide if their trailing 6 hex characters — each exactly
 *  pairHash(server, tool) of that pair's true original inputs — coincide, which
 *  for distinct pairs requires an actual sha1-truncation collision (the same
 *  accepted, bounded, probabilistic residual risk used by this file's
 *  truncation scheme elsewhere), not a deterministic construction. */
export function proxyToolName(server: string, tool: string): string {
  const safeServer = server.replace(INVALID_CHARS, "-");
  const safeTool = tool.replace(INVALID_CHARS, "-");
  const raw = `${safeServer}__${safeTool}`;
  const needsHash = safeServer !== server || safeTool !== tool
    || countSeparatorOccurrences(raw) !== 1
    || HASH_SUFFIX_SHAPE.test(raw);
  if (!needsHash && raw.length <= 64) return raw;
  const hash = pairHash(server, tool);
  return raw.length <= 64 - 7 ? `${raw}_${hash}` : `${raw.slice(0, 64 - 7)}_${hash}`;
}

/** Append proxy-tool names to a list-shaped capability so the call-time
 *  authorization interceptor (capabilityAllowsTool) permits them. A "*"
 *  capability already allows everything and is returned unchanged. Pure — never
 *  mutates the input. */
export function augmentCapabilityWithProxyTools(cap: Capability, names: string[]): Capability {
  if (cap.mcp === "*" || names.length === 0) return cap;
  return { ...cap, mcp: [...cap.mcp, ...names] };
}

/** Register a first-class proxy tool per allowlisted upstream tool of each
 *  (non-degraded) entry. Each tool's handler proxies to the gateway and returns
 *  the upstream result, or a structured error (isError) on failure. Returns the
 *  registered proxy-tool names (for capability augmentation by the caller). */
export async function registerProxyTools(
  server: McpServer,
  gateway: McpGateway,
  entries: McpServerEntry[],
): Promise<string[]> {
  const registered: string[] = [];
  for (const entry of entries) {
    if (gateway.isDegraded(entry.name)) continue;
    let tools: UpstreamTool[];
    try { tools = await gateway.introspect(entry.name); } catch { continue; }
    for (const tool of tools) {
      const name = proxyToolName(entry.name, tool.name);
      // registerInstrumentedTool throws synchronously on a duplicate tool name
      // (e.g. an upstream `tools/list` bug, or two registry entries that happen
      // to namespace to the same proxy name) — never let one bad tool abort
      // registration for every other entry/tool still to come.
      try {
        registerInstrumentedTool(
          server,
          name,
          {
            title: `${entry.name}: ${tool.name}`,
            description: tool.description ?? `Proxied ${entry.type} tool ${tool.name} on ${entry.name}.`,
            inputSchema: jsonSchemaToZod(tool.inputSchema),
          },
          (async (args: Record<string, unknown>) => {
            const r = await gateway.call(entry.name, tool.name, args ?? {});
            if (r.ok) {
              const result = r.result as { content?: unknown };
              if (result && typeof result === "object" && Array.isArray(result.content)) return result;
              return { content: [{ type: "text" as const, text: JSON.stringify(r.result) }] };
            }
            return { isError: true as const, content: [{ type: "text" as const, text: `MCP ${r.server}/${r.tool} unavailable: ${r.message}` }] };
          }) as Parameters<typeof registerInstrumentedTool>[3],
        );
      } catch {
        continue;
      }
      registered.push(name);
    }
  }
  return registered;
}
