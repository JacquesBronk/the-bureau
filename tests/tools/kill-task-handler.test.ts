/**
 * Tests for kill_task MCP tool handler (src/tools/kill-task.ts).
 * Tests the handler's error paths and the kill-then-fail flow using mock dependencies.
 * (Integration tests for the underlying TaskGraphManager behavior live in tests/kill-task.test.ts)
 */
import { describe, it, expect, vi } from "vitest";
import { registerKillTask } from "../../src/tools/kill-task.js";

function buildHandler(overrides?: {
  task?: any | null;
  killResult?: boolean;
  peerData?: string | null;
}) {
  const opts = {
    task: null,
    killResult: true,
    peerData: null,
    ...overrides,
  };

  let handler: (args: { graphId: string; taskId: string; reason?: string }) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockRedis = {
    get: vi.fn().mockResolvedValue(opts.peerData),
  } as any;

  const mockGraphManager = {
    getTask: vi.fn().mockResolvedValue(opts.task),
    onTaskFailed: vi.fn().mockResolvedValue(undefined),
    killTaskWorker: vi.fn().mockResolvedValue(undefined),
  } as any;

  const mockProcessMonitor = {
    killProcess: vi.fn().mockResolvedValue(opts.killResult),
  } as any;

  registerKillTask(mockServer, mockRedis, mockGraphManager, mockProcessMonitor);
  return { handler: handler!, mockGraphManager, mockProcessMonitor, mockRedis };
}

describe("kill_task handler", () => {
  it("returns isError when task is not found in the graph", async () => {
    const { handler } = buildHandler({ task: null });

    const result = await handler({ graphId: "g1", taskId: "missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns isError when task is not in running state", async () => {
    const { handler } = buildHandler({
      task: { id: "t1", status: "pending", sessionId: "sess-1" },
    });

    const result = await handler({ graphId: "g1", taskId: "t1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not running");
    expect(result.content[0].text).toContain("pending");
  });

  it("returns isError when running task has no sessionId", async () => {
    const { handler } = buildHandler({
      task: { id: "t1", status: "running", sessionId: undefined },
    });

    const result = await handler({ graphId: "g1", taskId: "t1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no session ID");
  });

  it("kills the process, marks task failed, and confirms with reason", async () => {
    const { handler, mockProcessMonitor, mockGraphManager } = buildHandler({
      task: { id: "t1", status: "running", sessionId: "sess-t1" },
      killResult: true,
    });

    const result = await handler({ graphId: "g1", taskId: "t1", reason: "timeout exceeded" });

    expect(mockProcessMonitor.killProcess).toHaveBeenCalledWith("sess-t1");
    expect(mockGraphManager.onTaskFailed).toHaveBeenCalledWith("g1", "t1", "sess-t1", 1);
    expect(result.content[0].text).toContain("t1 killed");
    expect(result.content[0].text).toContain("timeout exceeded");
  });

  it("routes a k8s task through the kill seam so the worker Job is deleted (#184)", async () => {
    const task = { id: "t1", status: "running", sessionId: "sess-t1", podMode: true };
    const { handler, mockGraphManager } = buildHandler({ task, killResult: true });

    await handler({ graphId: "g1", taskId: "t1" });

    // The seam (under k8s: deletes the worker Job + token Secret) is invoked with
    // the running task — not just the synthetic PID, which would leave the pod alive.
    expect(mockGraphManager.killTaskWorker).toHaveBeenCalledWith(task);
  });

  it("falls back to direct PID kill when killProcess returns false", async () => {
    const peerData = JSON.stringify({ pid: 99999 });
    const { handler, mockRedis } = buildHandler({
      task: { id: "t2", status: "running", sessionId: "sess-t2" },
      killResult: false,
      peerData,
    });

    // process.kill on a nonexistent PID should throw — that's caught internally
    const result = await handler({ graphId: "g1", taskId: "t2" });

    // Redis was queried for peer PID as fallback
    expect(mockRedis.get).toHaveBeenCalledWith("peers:sess-t2");
    // Still confirms kill despite fallback
    expect(result.content[0].text).toContain("t2 killed");
  });
});
