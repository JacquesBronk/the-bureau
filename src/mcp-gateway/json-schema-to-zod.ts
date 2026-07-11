import { z } from "zod";

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

/** Convert a single JSON-Schema node to a Zod type. Unknown shapes degrade to
 *  z.any() — a converter must never throw (a degraded schema beats a crash). */
function nodeToZod(node: JsonSchema | undefined): z.ZodTypeAny {
  if (!node || typeof node !== "object") return z.any();
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const lits = node.enum.map((v) => z.literal(v as z.Primitive));
    const union = lits.length === 1 ? lits[0] : z.union(lits as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return node.description ? union.describe(node.description) : union;
  }
  let base: z.ZodTypeAny;
  switch (node.type) {
    case "string": base = z.string(); break;
    case "number": base = z.number(); break;
    case "integer": base = z.number().int(); break;
    case "boolean": base = z.boolean(); break;
    case "array": base = z.array(nodeToZod(node.items)); break;
    case "object": base = objectToZod(node); break;
    default: base = z.any();
  }
  return node.description ? base.describe(node.description) : base;
}

function objectToZod(node: JsonSchema): z.ZodTypeAny {
  const props = node.properties;
  if (!props || typeof props !== "object") return z.object({}).passthrough();
  const required = new Set(node.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, child] of Object.entries(props)) {
    const zChild = nodeToZod(child);
    shape[key] = required.has(key) ? zChild : zChild.optional();
  }
  return z.object(shape);
}

/** Convert an upstream MCP tool's JSON-Schema `inputSchema` to a Zod schema for
 *  registration. A falsy/non-object schema degrades to a permissive object. */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.object({}).passthrough();
  return nodeToZod(schema as JsonSchema);
}
