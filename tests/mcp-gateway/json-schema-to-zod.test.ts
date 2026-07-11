import { describe, it, expect } from "vitest";
import { z } from "zod";
import { jsonSchemaToZod } from "../../src/mcp-gateway/json-schema-to-zod.js";

describe("jsonSchemaToZod", () => {
  it("converts an object with a required string and an optional number", () => {
    const zod = jsonSchemaToZod({
      type: "object",
      properties: { query: { type: "string", description: "the q" }, limit: { type: "number" } },
      required: ["query"],
    });
    expect(zod.safeParse({ query: "x" }).success).toBe(true);          // limit optional
    expect(zod.safeParse({ query: "x", limit: 5 }).success).toBe(true);
    expect(zod.safeParse({ limit: 5 }).success).toBe(false);           // query required
    expect(zod.safeParse({ query: 1 }).success).toBe(false);           // wrong type
  });

  it("converts enum, boolean, integer, and array-of-string", () => {
    const zod = jsonSchemaToZod({
      type: "object",
      properties: {
        mode: { enum: ["a", "b"] },
        flag: { type: "boolean" },
        n: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["mode"],
    });
    expect(zod.safeParse({ mode: "a", flag: true, n: 3, tags: ["x"] }).success).toBe(true);
    expect(zod.safeParse({ mode: "c" }).success).toBe(false);
    expect(zod.safeParse({ mode: "a", tags: [1] }).success).toBe(false);
  });

  it("degrades an unknown/empty schema to an object that accepts anything", () => {
    const zod = jsonSchemaToZod(undefined);
    expect(zod.safeParse({ anything: 1, here: "ok" }).success).toBe(true);
    expect(zod instanceof z.ZodType).toBe(true);
  });

  it("degrades a property with neither a recognized type nor enum to z.any()", () => {
    const zod = jsonSchemaToZod({
      type: "object",
      properties: { weird: { type: "something-unrecognized" } },
      required: ["weird"],
    });
    expect(zod.safeParse({ weird: "x" }).success).toBe(true);
    expect(zod.safeParse({ weird: 42 }).success).toBe(true);
    expect(zod.safeParse({ weird: { nested: true } }).success).toBe(true);
  });

  it("degrades a nested object with no properties to a passthrough object", () => {
    const zod = jsonSchemaToZod({
      type: "object",
      properties: { meta: { type: "object" } },
      required: ["meta"],
    });
    expect(zod.safeParse({ meta: { anything: 1 } }).success).toBe(true);
    expect(zod.safeParse({ meta: {} }).success).toBe(true);
  });
});
