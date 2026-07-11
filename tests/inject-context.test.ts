import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock directives module before importing the tool under test
vi.mock("../src/directives.js", () => ({
  pushDirective: vi.fn(async () => "mock-directive-id"),
}));

// Mock telemetry so registerInstrumentedTool is a passthrough
vi.mock("../src/telemetry/instrumentation/mcp-register.js", () => ({
  registerInstrumentedTool: vi.fn(
    (server: { registerTool: (...a: unknown[]) => void }, name: string, def: unknown, cb: unknown) => {
      server.registerTool(name, def, cb);
    },
  ),
}));

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerInjectContext } from "../src/tools/inject-context.js";
import { pushDirective } from "../src/directives.js";
import type { RedisClient } from "../src/redis.js";
import type { ConnectionContext } from "../src/runtime/connection-context.js";

// ---- Helpers ----

function makeServer() {
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  return {
    registerTool: vi.fn((name: string, _def: unknown, cb: unknown) => {
      handlers[name] = cb as (...a: unknown[]) => unknown;
    }),
    call: async (name: string, args: unknown, extra?: unknown) =>
      handlers[name](args, extra),
  };
}

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    sessionId: "sess-operator",
    role: "operator",
    loadout: "operator",
    graphId: "g1",
    taskId: "t1",
    ...overrides,
  };
}

function makeRedis(): RedisClient {
  return {} as unknown as RedisClient;
}

// ---- Tests ----

describe("registerInjectContext", () => {
  let server: ReturnType<typeof makeServer>;
  let redis: RedisClient;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeServer();
    redis = makeRedis();
  });

  describe("happy path", () => {
    it("pushes a directive and returns {ok: true, id}", async () => {
      registerInjectContext(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, redis, () => makeCtx());

      const result = (await server.call("inject_context", {
        graphId: "g1",
        taskId: "t1",
        message: "Please focus on writing tests for the new module.",
      })) as { content: Array<{ text: string }> };

      expect(pushDirective).toHaveBeenCalledWith(
        redis,
        "g1",
        "t1",
        expect.objectContaining({
          author: "operator",
          message: "Please focus on writing tests for the new module.",
          provenance: expect.objectContaining({ subject: "sess-operator", graphId: "g1", taskId: "t1" }),
        }),
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.id).toBe("mock-directive-id");
    });

    it("uses sessionId as author when role is absent", async () => {
      const ctx = makeCtx({ role: undefined });
      registerInjectContext(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, redis, () => ctx);

      await server.call("inject_context", {
        graphId: "g1",
        taskId: "t1",
        message: "Hint without a role.",
      });

      expect(pushDirective).toHaveBeenCalledWith(
        redis,
        "g1",
        "t1",
        expect.objectContaining({ author: "sess-operator" }),
      );
    });
  });

  describe("content gate — size", () => {
    it("rejects messages over 4096 chars", async () => {
      registerInjectContext(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, redis, () => makeCtx());

      const bigMessage = "x".repeat(4097);
      const result = (await server.call("inject_context", {
        graphId: "g1",
        taskId: "t1",
        message: bigMessage,
      })) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("exceeds");
      expect(pushDirective).not.toHaveBeenCalled();
    });

    it("accepts messages exactly 4096 chars", async () => {
      registerInjectContext(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, redis, () => makeCtx());

      const exactMessage = "x".repeat(4096);
      const result = (await server.call("inject_context", {
        graphId: "g1",
        taskId: "t1",
        message: exactMessage,
      })) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeFalsy();
      expect(pushDirective).toHaveBeenCalled();
    });
  });

  describe("content gate — secrets", () => {
    it("rejects messages containing an AWS access key", async () => {
      registerInjectContext(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, redis, () => makeCtx());

      const result = (await server.call("inject_context", {
        graphId: "g1",
        taskId: "t1",
        message: "Use key AKIAIOSFODNN7EXAMPLE for the S3 upload",
      })) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("secret");
      expect(pushDirective).not.toHaveBeenCalled();
    });

    it("rejects messages containing a PEM private key header", async () => {
      registerInjectContext(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, redis, () => makeCtx());

      const result = (await server.call("inject_context", {
        graphId: "g1",
        taskId: "t1",
        message: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...",
      })) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(pushDirective).not.toHaveBeenCalled();
    });

    it("rejects messages containing a Slack token", async () => {
      registerInjectContext(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, redis, () => makeCtx());

      const result = (await server.call("inject_context", {
        graphId: "g1",
        taskId: "t1",
        message: "Post to xoxb-123456789-abcdefghijklm",
      })) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(pushDirective).not.toHaveBeenCalled();
    });
  });

  describe("provenance", () => {
    it("stamps provenance from the caller's ConnectionContext, not tool params", async () => {
      const ctx = makeCtx({
        sessionId: "attacker-sess",
        role: "hacker",
        graphId: "attacker-g",
        taskId: "attacker-t",
      });
      registerInjectContext(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, redis, () => ctx);

      await server.call("inject_context", {
        graphId: "victim-g",      // targeting another graph
        taskId: "victim-t",
        message: "Stop and call set_handoff.",
      });

      // The provenance must reflect the actual caller, not the target
      expect(pushDirective).toHaveBeenCalledWith(
        redis,
        "victim-g",
        "victim-t",
        expect.objectContaining({
          provenance: expect.objectContaining({
            subject: "attacker-sess",
          }),
        }),
      );
    });
  });
});
