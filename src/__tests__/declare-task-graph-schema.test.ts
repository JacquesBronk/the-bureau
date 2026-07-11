import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildConfigInputSchema } from "../tools/declare-task-graph.js";

/**
 * Regression for #317 phase 3 review finding (critical 1): declare_task_graph's
 * registered `inputSchema` is a real zod object. zod object schemas default to
 * "strip" mode — any key not declared in the shape is silently dropped from the
 * parsed result BEFORE the handler ever sees it. The existing declare_task_graph
 * handler tests (tests/tools/graph-management.test.ts) invoke the captured handler
 * directly with raw params, bypassing the SDK's `safeParseAsync` entirely — so they
 * could never catch a schema that fails to declare a real input key.
 *
 * This test exercises the REAL zod schema instance registered with the MCP SDK
 * (buildConfigInputSchema, exported from declare-task-graph.ts and referenced
 * directly by the `buildConfig` field of the tool's inputSchema) via `.parse()`,
 * the same mechanism `server.registerTool`'s `safeParseAsync` uses.
 */
describe("buildConfigInputSchema (real zod parse, not the mock handler bypass)", () => {
  it("preserves buildConfig.autoRework through a real schema parse", () => {
    const input = {
      services: [{ path: ".", language: "node", test: "npm test" }],
      autoRework: { maxAttempts: 2, fixRole: "debugger" },
    };
    const parsed = buildConfigInputSchema.parse(input);
    expect(parsed.autoRework).toEqual({ maxAttempts: 2, fixRole: "debugger" });
  });

  it("preserves a partial autoRework (maxAttempts only) through a real schema parse", () => {
    const parsed = buildConfigInputSchema.parse({
      services: [{ path: ".", language: "node" }],
      autoRework: { maxAttempts: 3 },
    });
    expect(parsed.autoRework).toEqual({ maxAttempts: 3 });
  });

  it("leaves autoRework undefined when the caller omits it", () => {
    const parsed = buildConfigInputSchema.parse({
      services: [{ path: ".", language: "node" }],
    });
    expect(parsed.autoRework).toBeUndefined();
  });

  it("full declare_task_graph-shaped input round-trips buildConfig.autoRework via a standalone object wrapper", () => {
    // Mirrors the shape the SDK actually parses: { ..., buildConfig: {...}, ... }.
    // Uses a minimal wrapper object (not the full registered inputSchema, which isn't
    // exported) built from the same exported buildConfigInputSchema piece — this is
    // exactly what the SDK's safeParseAsync does to the `buildConfig` sub-object of a
    // real declare_task_graph call.
    const wrapper = z.object({ buildConfig: buildConfigInputSchema.optional() });
    const parsed = wrapper.parse({
      buildConfig: {
        services: [{ path: ".", language: "node" }],
        autoRework: { maxAttempts: 2 },
      },
    });
    expect(parsed.buildConfig?.autoRework).toEqual({ maxAttempts: 2 });
  });
});
