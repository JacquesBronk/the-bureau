/**
 * Tests for reject_task caller scoping (#330).
 *
 * Before this fix, any session holding reject_task (e.g. a minimal-profile reviewer
 * granted the tool for its OWN reviewLoop) could reject any completed task in any
 * graph — the handler had no caller scoping at all. A graph worker (a context with
 * its own taskId) must now be restricted to graphId === its own graphId, and to task
 * IDs its own task's reviewLoop.canReject names. A caller with no taskId (operator /
 * coordinator-profile sessions like tech-lead, not spawned as a graph worker) keeps
 * today's unrestricted behavior.
 */
import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerRejectTask } from "../../src/tools/reject-task.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";
import type { ConnectionContext } from "../../src/runtime/connection-context.js";

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
  return {
    getTask: vi.fn(),
    addTask: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeReworkManager() {
  return {
    canRework: vi.fn().mockResolvedValue(true),
    getReworkCount: vi.fn().mockResolvedValue(0),
    recordRejection: vi.fn().mockResolvedValue(undefined),
    recordExhaustion: vi.fn(),
  } as any;
}

function workerCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return { sessionId: "sess-reviewer", loadout: "minimal", taskId: "review-1", graphId: "g1", ...overrides };
}

describe("reject_task handler — caller scoping (#330)", () => {
  it("(e) worker caller whose reviewLoop.canReject names the target: allowed", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getTask.mockImplementation(async (graphId: string, taskId: string) => {
      if (taskId === "review-1") return { id: "review-1", status: "running", role: "reviewer", reviewLoop: { maxIterations: 3, fixerRole: "coder", canReject: ["t1"] } };
      if (taskId === "t1") return { id: "t1", status: "completed", role: "coder", task: "Original prompt", cwd: "/repo", branch: "main" };
      return null;
    });
    const rm = makeReworkManager();

    registerRejectTask(server, gm, rm, createStaticResolver(workerCtx()));

    const result = await invoke({ graphId: "g1", taskId: "t1", reason: "Tests missing", maxReworks: 3 });

    expect(result.isError).toBeUndefined();
    expect(rm.recordRejection).toHaveBeenCalledWith("g1", "t1", expect.objectContaining({ reason: "Tests missing" }), expect.objectContaining({ role: "coder" }));
  });

  it("(f) worker caller whose reviewLoop.canReject does NOT name the target: actionable error, no rejection recorded", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getTask.mockImplementation(async (graphId: string, taskId: string) => {
      if (taskId === "review-1") return { id: "review-1", status: "running", role: "reviewer", reviewLoop: { maxIterations: 3, fixerRole: "coder", canReject: ["some-other-task"] } };
      if (taskId === "t1") return { id: "t1", status: "completed", role: "coder", task: "Original prompt", cwd: "/repo", branch: "main" };
      return null;
    });
    const rm = makeReworkManager();

    registerRejectTask(server, gm, rm, createStaticResolver(workerCtx()));

    const result = await invoke({ graphId: "g1", taskId: "t1", reason: "Tests missing", maxReworks: 3 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("canReject");
    expect(rm.recordRejection).not.toHaveBeenCalled();
    expect(gm.addTask).not.toHaveBeenCalled();
  });

  it("(g) worker caller targeting a different graph: refused", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    const rm = makeReworkManager();

    registerRejectTask(server, gm, rm, createStaticResolver(workerCtx({ graphId: "g1" })));

    const result = await invoke({ graphId: "g2", taskId: "t1", reason: "Tests missing", maxReworks: 3 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("g1");
    expect(result.content[0].text).toContain("g2");
    // Cross-graph check short-circuits before any task lookup.
    expect(gm.getTask).not.toHaveBeenCalled();
    expect(rm.recordRejection).not.toHaveBeenCalled();
  });

  it("(h) operator/no-task-context caller: unrestricted, as today", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getTask.mockResolvedValue({ id: "t1", status: "completed", role: "coder", task: "Original prompt", cwd: "/repo", branch: "main" });
    const rm = makeReworkManager();

    // No taskId on the context — an operator/coordinator session, not a graph worker.
    registerRejectTask(server, gm, rm, createStaticResolver({ sessionId: "sess-operator", loadout: "operator" }));

    const result = await invoke({ graphId: "any-graph", taskId: "t1", reason: "Tests missing", maxReworks: 3 });

    expect(result.isError).toBeUndefined();
    expect(rm.recordRejection).toHaveBeenCalledWith("any-graph", "t1", expect.objectContaining({ reason: "Tests missing" }), expect.objectContaining({ role: "coder" }));
  });
});
