/**
 * Tests for use_template's autoRework/selfImprove forwarding (#321).
 *
 * Strategy: mirrors tests/tools/graph-management.test.ts — a minimal mock McpServer
 * captures the registered handler, TaskGraphManager.declareGraph is a vi.fn() mock.
 * Pure unit test: no Redis, no network.
 */
import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerUseTemplate } from "../../src/tools/use-template.js";

// ---------------------------------------------------------------------------
// Minimal mock McpServer — captures handler so tests can invoke it directly
// ---------------------------------------------------------------------------
function makeServer() {
  let capturedHandler: (params: any) => Promise<any>;
  const server = {
    registerTool: (_name: string, _config: any, handler: (params: any) => Promise<any>) => {
      capturedHandler = handler;
    },
  } as unknown as McpServer;

  return {
    server,
    invoke: (params: any) => capturedHandler(params),
  };
}

function makeGraphManager() {
  const calls: any[] = [];
  return {
    declareGraph: async (...args: any[]) => {
      calls.push(args);
      return { graphId: "g1", readyTasks: ["a"], totalTasks: 1 };
    },
    _calls: calls,
  } as any;
}

async function useTemplateWith(overrides: Record<string, unknown>) {
  const { server, invoke } = makeServer();
  const gm = makeGraphManager();
  registerUseTemplate(server, gm);

  await invoke({
    template: "single-task",
    project: "p",
    cwd: "/tmp",
    params: { task: "Do the thing", role: "coder" },
    // single-task defaults validation to "unit", so declare rejects an unresolved gate:
    // it needs both a resolvable test command (#336) AND a resolvable install (#354/#355),
    // unless the override supplies its own buildConfig.
    buildConfig: { services: [{ path: ".", language: "node", install: "npm ci", test: "npm test" }] },
    ...overrides,
  });

  const [, , , opts] = gm._calls[0];
  return opts;
}

describe("use_template autoRework/selfImprove forwarding", () => {
  it("accepts autoRework in the schema and forwards it (normalized) to declareGraph", async () => {
    const opts = await useTemplateWith({ autoRework: { maxAttempts: 2, fixRole: "debugger" } });
    expect(opts.autoRework).toEqual({ maxAttempts: 2, fixRole: "debugger" });
  });

  it("resolves autoRework from buildConfig when input omits it", async () => {
    const opts = await useTemplateWith({
      buildConfig: {
        services: [{ path: ".", language: "node", install: "npm ci", test: "npm test" }],
        autoRework: { maxAttempts: 2 },
      },
    });
    expect(opts.autoRework).toEqual({ maxAttempts: 2 });
  });

  it("input autoRework overrides buildConfig's autoRework wholesale", async () => {
    const opts = await useTemplateWith({
      autoRework: { maxAttempts: 1 },
      buildConfig: {
        services: [{ path: ".", language: "node", install: "npm ci", test: "npm test" }],
        autoRework: { maxAttempts: 3, fixRole: "reviewer" },
      },
    });
    expect(opts.autoRework).toEqual({ maxAttempts: 1 });
  });

  it("hard-caps maxAttempts at 3 via resolveAutoRework", async () => {
    const opts = await useTemplateWith({ autoRework: { maxAttempts: 5 } });
    expect(opts.autoRework).toEqual({ maxAttempts: 3 });
  });

  it("forwards selfImprove to declareGraph", async () => {
    const optsTrue = await useTemplateWith({ selfImprove: true });
    expect(optsTrue.selfImprove).toBe(true);

    const optsFalse = await useTemplateWith({ selfImprove: false });
    expect(optsFalse.selfImprove).toBe(false);
  });

  it("leaves existing behavior unchanged when both autoRework and selfImprove are omitted", async () => {
    const opts = await useTemplateWith({});
    expect(opts.autoRework).toBeUndefined();
    expect(opts.selfImprove).toBeUndefined();
  });
});
