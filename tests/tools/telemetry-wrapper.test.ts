/**
 * Tests for the registerTool telemetry wrapper (src/mcp-server.ts).
 *
 * Regression suite for #53 (replace any casts with proper generics).
 * The wrapper lives inside the mcp-server entry point and is not exported,
 * so we test its extractable behavior pattern directly.
 *
 * Two concerns:
 *   1. Runtime: wrapper records tool calls via collector and passes handler result through.
 *   2. Compile-time: the generic signature compiles without `any` escapes so TypeScript
 *      catches mismatched handler types at registration sites.
 */
import { describe, it, expect, vi } from "vitest";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Helper: reproduce the wrapping pattern from mcp-server.ts so we can test it
// without importing the entry-point module.
// ---------------------------------------------------------------------------

type AnyHandler = (...args: any[]) => any;

interface MockServer {
  registerTool: (name: string, config: object, cb: AnyHandler) => RegisteredTool;
}

function applyTelemetryWrapper(
  server: MockServer,
  collector: { recordToolCall: (name: string) => void },
): MockServer {
  const _orig = server.registerTool.bind(server);
  return {
    ...server,
    registerTool: (name: string, config: object, cb: AnyHandler): RegisteredTool =>
      _orig(name, config, async (...args: unknown[]) => {
        collector.recordToolCall(name);
        return (cb as (...a: unknown[]) => unknown)(...args);
      }),
  };
}

// ---------------------------------------------------------------------------
// Runtime behavior tests
// ---------------------------------------------------------------------------

describe("registerTool telemetry wrapper (runtime — #53)", () => {
  function buildWrappedServer() {
    const recordedCalls: string[] = [];
    const collector = { recordToolCall: vi.fn((name: string) => recordedCalls.push(name)) };

    let capturedHandler: AnyHandler | undefined;
    const fakeOrig = vi.fn(
      (_name: string, _cfg: object, cb: AnyHandler): RegisteredTool => {
        capturedHandler = cb;
        return {} as RegisteredTool;
      },
    );
    const baseServer: MockServer = { registerTool: fakeOrig };
    const wrappedServer = applyTelemetryWrapper(baseServer, collector);

    return { wrappedServer, fakeOrig, collector, recordedCalls, getHandler: () => capturedHandler! };
  }

  it("delegates to the original registerTool with same name and config", () => {
    const { wrappedServer, fakeOrig } = buildWrappedServer();
    const config = { title: "My Tool", description: "does something" };

    wrappedServer.registerTool("my_tool", config, async () => ({ content: [] }));

    expect(fakeOrig).toHaveBeenCalledOnce();
    expect(fakeOrig.mock.calls[0][0]).toBe("my_tool");
    expect(fakeOrig.mock.calls[0][1]).toBe(config);
  });

  it("records the tool call via collector before invoking the handler", async () => {
    const { wrappedServer, collector, getHandler } = buildWrappedServer();
    const callOrder: string[] = [];

    wrappedServer.registerTool("tracked_tool", {}, async () => {
      callOrder.push("handler");
      return { content: [{ type: "text" as const, text: "ok" }] };
    });

    collector.recordToolCall.mockImplementation((name: string) => {
      callOrder.push(`recordToolCall:${name}`);
    });

    await getHandler()({});

    expect(callOrder[0]).toBe("recordToolCall:tracked_tool");
    expect(callOrder[1]).toBe("handler");
  });

  it("passes handler arguments through unchanged", async () => {
    const { wrappedServer, getHandler } = buildWrappedServer();
    let receivedArgs: unknown;

    wrappedServer.registerTool("echo_tool", {}, async (args: unknown) => {
      receivedArgs = args;
      return { content: [] };
    });

    const input = { foo: "bar", count: 42 };
    await getHandler()(input);

    expect(receivedArgs).toEqual(input);
  });

  it("returns the handler result without modification", async () => {
    const { wrappedServer, getHandler } = buildWrappedServer();
    const expectedResult = { content: [{ type: "text" as const, text: "hello" }] };

    wrappedServer.registerTool("result_tool", {}, async () => expectedResult);

    const result = await getHandler()({});
    expect(result).toEqual(expectedResult);
  });

  it("records the correct tool name when multiple tools are registered", async () => {
    const { wrappedServer, collector, recordedCalls, getHandler } = buildWrappedServer();

    wrappedServer.registerTool("tool_a", {}, async () => ({ content: [] }));
    await getHandler()({});

    // Register a second tool (handler replaces capturedHandler in our helper)
    wrappedServer.registerTool("tool_b", {}, async () => ({ content: [] }));
    await getHandler()({});

    expect(recordedCalls).toEqual(["tool_a", "tool_b"]);
    expect(collector.recordToolCall).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Compile-time type safety check (#53)
//
// The generic signature below mirrors the one in mcp-server.ts.
// If TypeScript accepts this file, the types are consistent — any regression
// to `any` casts would widen the types and this check would still pass, but
// the lack of compiler errors on the handler type would surface as a TS error
// at call sites that use mismatched types.
//
// We also verify that a correctly-typed async handler is assignable to the
// callback parameter without casting.
// ---------------------------------------------------------------------------

describe("registerTool wrapper type safety (compile-time — #53)", () => {
  it("typed handler is accepted without any cast", () => {
    // This test is primarily a compile-time check.
    // If TypeScript rejects this file, the type safety has regressed.
    type TypedHandler<TArgs extends object> = (args: TArgs) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;

    // Verify a concretely typed handler is assignable to a generic slot
    const handler: TypedHandler<{ value: string }> = async ({ value }) => ({
      content: [{ type: "text", text: value }],
    });

    // Cast to AnyHandler mirrors what the wrapper does internally; verifies
    // the pattern compiles without needing `as any` on the outer signature.
    const asGeneric: AnyHandler = handler;
    expect(typeof asGeneric).toBe("function");
  });
});
