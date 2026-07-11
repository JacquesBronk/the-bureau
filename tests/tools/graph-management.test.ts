/**
 * Tests for MCP tool handlers: graph management batch 1.
 *
 * Strategy: create a minimal mock McpServer that captures the registered
 * handler, then invoke it directly with typed params. Service dependencies
 * (TaskGraphManager, ReworkManager, ProcessMonitor, Redis) are vi.fn() mocks —
 * the handlers are thin wrappers and we just need to verify they route params
 * correctly and format the response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerDeclareTaskGraph } from "../../src/tools/declare-task-graph.js";
import { registerGetTaskGraph } from "../../src/tools/get-task-graph.js";
import { registerApproveTask } from "../../src/tools/approve-task.js";
import { registerAddTask } from "../../src/tools/add-task.js";
import { registerCancelTaskGraph } from "../../src/tools/cancel-task-graph.js";
import { registerResumeGraph } from "../../src/tools/resume-graph.js";
import { registerRejectTask } from "../../src/tools/reject-task.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

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

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------
function makeGraphManager() {
  return {
    declareGraph: vi.fn(),
    getGraphVisualization: vi.fn(),
    getAllTasks: vi.fn(),
    approveTask: vi.fn(),
    addTask: vi.fn(),
    cancelGraph: vi.fn(),
    getGraph: vi.fn().mockResolvedValue(null),
    getTask: vi.fn(),
    getGraphDepth: vi.fn().mockResolvedValue(0),
    onTaskFailed: vi.fn(),
    resumeDispatch: vi.fn(),
  } as any;
}

function makeReworkManager() {
  return {
    canRework: vi.fn(),
    getReworkCount: vi.fn(),
    recordRejection: vi.fn(),
    recordExhaustion: vi.fn(),
  } as any;
}

function makeRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    xrevrange: vi.fn().mockResolvedValue([]),
    hgetall: vi.fn().mockResolvedValue(null),
  } as any;
}

// scanKeys stub — returns empty array by default (no yield keys)
vi.mock("../../src/redis.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/redis.js")>();
  return { ...actual, scanKeys: vi.fn().mockResolvedValue([]) };
});

function makeProcessMonitor() {
  return {
    // static method tested via ProcessMonitor.isPidAlive
  } as any;
}

// ---------------------------------------------------------------------------
// declare_task_graph
// ---------------------------------------------------------------------------
describe("declare_task_graph handler", () => {
  it("returns graphId and task summary on success", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.declareGraph.mockResolvedValue({
      graphId: "abc-123",
      readyTasks: ["task-a", "task-b"],
      totalTasks: 3,
    });

    registerDeclareTaskGraph(server, gm);

    const result = await invoke({
      project: "my-project",
      cwd: "/tmp",
      tasks: [
        { id: "task-a", role: "coder", task: "Do A" },
        { id: "task-b", role: "coder", task: "Do B" },
        { id: "task-c", role: "coder", task: "Do C", dependsOn: ["task-a"] },
      ],
    });

    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("abc-123");
    expect(result.content[0].text).toContain("Total tasks: 3");
    expect(result.content[0].text).toContain("task-a, task-b");
    expect(result.isError).toBeUndefined();

    expect(gm.declareGraph).toHaveBeenCalledWith(
      "my-project", "/tmp",
      expect.arrayContaining([expect.objectContaining({ id: "task-a" })]),
      expect.objectContaining({ maxConcurrency: undefined }),
    );
  });

  it("returns isError when declareGraph throws (e.g. cycle detected)", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.declareGraph.mockRejectedValue(new Error("Cycle detected: a → b → a"));

    registerDeclareTaskGraph(server, gm);

    const result = await invoke({
      project: "p", cwd: "/tmp",
      tasks: [
        { id: "a", role: "coder", task: "A", dependsOn: ["b"] },
        { id: "b", role: "coder", task: "B", dependsOn: ["a"] },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cycle detected");
  });



  it("declares graph without modification when no options provided", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.declareGraph.mockResolvedValue({
      graphId: "xyz-789",
      readyTasks: ["task-a"],
      totalTasks: 1,
    });

    registerDeclareTaskGraph(server, gm);

    await invoke({
      project: "p", cwd: "/tmp",
      tasks: [{ id: "task-a", role: "coder", task: "Do A" }],
    });

    const [, , tasksArg] = gm.declareGraph.mock.calls[0];
    expect(tasksArg).toHaveLength(1);
    expect(tasksArg[0].id).toBe("task-a");
  });

  it("rejects self-improvement graph when depth exceeds limit", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    // parentGraphId resolves to depth 1 (its own parent exists)
    gm.getGraphDepth.mockResolvedValue(1);

    registerDeclareTaskGraph(server, gm, { selfImprovementDepthLimit: 1 });

    const result = await invoke({
      project: "self-improvement-retro",
      cwd: "/tmp",
      parentGraphId: "parent-graph-id",
      tasks: [{ id: "analyze", role: "session-analyzer", task: "Analyze" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("depth limit");
    expect(gm.declareGraph).not.toHaveBeenCalled();
  });

  it("allows self-improvement graph when depth is within limit", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getGraphDepth.mockResolvedValue(0);
    gm.declareGraph.mockResolvedValue({
      graphId: "retro-graph",
      readyTasks: ["analyze"],
      totalTasks: 1,
    });

    registerDeclareTaskGraph(server, gm, { selfImprovementDepthLimit: 1 });

    const result = await invoke({
      project: "self-improvement-retro",
      cwd: "/tmp",
      parentGraphId: "parent-graph-id",
      tasks: [{ id: "analyze", role: "session-analyzer", task: "Analyze" }],
    });

    expect(result.isError).toBeUndefined();
    expect(gm.declareGraph).toHaveBeenCalled();
  });

  it("skips depth check for non-self-improvement projects", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.declareGraph.mockResolvedValue({
      graphId: "normal-graph",
      readyTasks: ["t1"],
      totalTasks: 1,
    });

    registerDeclareTaskGraph(server, gm, { selfImprovementDepthLimit: 0 });

    const result = await invoke({
      project: "some-other-project",
      cwd: "/tmp",
      parentGraphId: "parent-id",
      tasks: [{ id: "t1", role: "coder", task: "Do it" }],
    });

    // getGraphDepth should NOT be called for non-self-improvement projects
    expect(gm.getGraphDepth).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  describe("autoRework resolution", () => {
    async function declareWith(autoRework: unknown, buildConfig?: unknown) {
      const { server, invoke } = makeServer();
      const gm = makeGraphManager();
      gm.declareGraph.mockResolvedValue({ graphId: "g1", readyTasks: ["a"], totalTasks: 1 });
      registerDeclareTaskGraph(server, gm);
      await invoke({
        project: "p", cwd: "/tmp",
        tasks: [{ id: "a", role: "coder", task: "Do A" }],
        ...(autoRework !== undefined && { autoRework }),
        ...(buildConfig !== undefined && { buildConfig }),
      });
      return gm.declareGraph.mock.calls[0][3];
    }

    it("carries a normalized autoRework through to declareGraph opts", async () => {
      const opts = await declareWith({ maxAttempts: 2 });
      expect(opts.autoRework).toEqual({ maxAttempts: 2 });
    });

    it("clamps maxAttempts to the hard cap of 3", async () => {
      const opts = await declareWith({ maxAttempts: 5 });
      expect(opts.autoRework).toEqual({ maxAttempts: 3 });
    });

    it("treats maxAttempts 0 as off (undefined)", async () => {
      const opts = await declareWith({ maxAttempts: 0 });
      expect(opts.autoRework).toBeUndefined();
    });

    it("is undefined when autoRework is not provided", async () => {
      const opts = await declareWith(undefined);
      expect(opts.autoRework).toBeUndefined();
    });

    it("defaults maxAttempts to 1 for an empty autoRework object", async () => {
      const opts = await declareWith({});
      expect(opts.autoRework).toEqual({ maxAttempts: 1 });
    });

    it("resolves autoRework from buildConfig when declare input omits it", async () => {
      const opts = await declareWith(undefined, {
        services: [{ path: ".", language: "node" }],
        autoRework: { maxAttempts: 2 },
      });
      expect(opts.autoRework).toEqual({ maxAttempts: 2 });
    });

    it("declare input overrides buildConfig's autoRework", async () => {
      const opts = await declareWith({ maxAttempts: 1 }, {
        services: [{ path: ".", language: "node" }],
        autoRework: { maxAttempts: 3, fixRole: "reviewer" },
      });
      expect(opts.autoRework).toEqual({ maxAttempts: 1 });
    });
  });
});

// ---------------------------------------------------------------------------
// get_task_graph
// ---------------------------------------------------------------------------
describe("get_task_graph handler", () => {
  it("returns visualization and detailed task list", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getGraphVisualization.mockResolvedValue("[ a ] → [ b ]");
    gm.getAllTasks.mockResolvedValue([
      { id: "a", role: "coder", status: "completed", dependsOn: [], sessionId: "sess-a", exitCode: 0, retries: 0 },
      { id: "b", role: "coder", status: "running", dependsOn: ["a"], sessionId: "sess-b", exitCode: null, retries: 0 },
    ]);

    registerGetTaskGraph(server, gm, makeRedis());

    const result = await invoke({ graphId: "graph-xyz" });

    expect(result.content[0].text).toContain("[ a ] → [ b ]");
    expect(result.content[0].text).toContain('"id": "a"');
    expect(result.content[0].text).toContain('"status": "completed"');
    expect(gm.getGraphVisualization).toHaveBeenCalledWith("graph-xyz");
    expect(gm.getAllTasks).toHaveBeenCalledWith("graph-xyz");
  });
});

// ---------------------------------------------------------------------------
// approve_task
// ---------------------------------------------------------------------------
describe("approve_task handler", () => {
  it("returns confirmation message on success", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.approveTask.mockResolvedValue(undefined);

    registerApproveTask(server, gm);

    const result = await invoke({ graphId: "g1", taskId: "review" });

    expect(result.content[0].text).toContain("review");
    expect(result.content[0].text).toContain("approved");
    expect(result.isError).toBeUndefined();
    expect(gm.approveTask).toHaveBeenCalledWith("g1", "review");
  });

  it("returns isError when approveTask throws", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.approveTask.mockRejectedValue(new Error("Task not in awaiting_approval state"));

    registerApproveTask(server, gm);

    const result = await invoke({ graphId: "g1", taskId: "t1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not in awaiting_approval");
  });
});

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------
describe("add_task handler", () => {
  it("returns confirmation with task id and role", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.addTask.mockResolvedValue(undefined);

    registerAddTask(server, gm);

    const result = await invoke({
      graphId: "g-abcdef12",
      id: "new-task",
      role: "reviewer",
      task: "Review the code",
      dependsOn: ["build"],
    });

    expect(result.content[0].text).toContain("new-task");
    expect(result.content[0].text).toContain("reviewer");
    expect(result.content[0].text).toContain("build");
    expect(result.isError).toBeUndefined();
    expect(gm.addTask).toHaveBeenCalledWith("g-abcdef12", expect.objectContaining({
      id: "new-task", role: "reviewer",
    }));
  });

  it("returns isError when addTask throws", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.addTask.mockRejectedValue(new Error("Graph not found"));

    registerAddTask(server, gm);

    const result = await invoke({ graphId: "bad", id: "x", role: "coder", task: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Graph not found");
  });
});

// ---------------------------------------------------------------------------
// cancel_task_graph
// ---------------------------------------------------------------------------
describe("cancel_task_graph handler", () => {
  it("returns canceled task count", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.cancelGraph.mockResolvedValue(4);

    registerCancelTaskGraph(server, gm);

    const result = await invoke({ graphId: "g-cancel" });

    expect(result.content[0].text).toContain("g-cancel");
    expect(result.content[0].text).toContain("4 tasks canceled");
    expect(gm.cancelGraph).toHaveBeenCalledWith("g-cancel");
  });
});

// ---------------------------------------------------------------------------
// resume_graph
// ---------------------------------------------------------------------------
describe("resume_graph handler", () => {
  it("returns isError when graph does not exist", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getGraph.mockResolvedValue(null);

    const redis = makeRedis();
    const pm = makeProcessMonitor();

    registerResumeGraph(server, gm, redis, pm, createStaticResolver({ sessionId: "sess-orch" }));

    const result = await invoke({ graphId: "nonexistent" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns a report with graph status when graph has no running tasks", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();

    gm.getGraph.mockResolvedValue({
      id: "g-resume",
      project: "proj",
      status: "active",
      createdAt: Date.now() - 5000,
    });
    gm.getAllTasks.mockResolvedValue([
      { id: "a", status: "completed", sessionId: "s1" },
      { id: "b", status: "pending", sessionId: null },
    ]);
    gm.resumeDispatch.mockResolvedValue([]);

    const redis = makeRedis();
    redis.set.mockResolvedValue("OK");
    const pm = makeProcessMonitor();

    registerResumeGraph(server, gm, redis, pm, createStaticResolver({ sessionId: "sess-orch" }));

    const result = await invoke({ graphId: "g-resume" });

    expect(result.isError).toBeUndefined();
    const report = JSON.parse(result.content[0].text);
    expect(report.resumed).toBe(true);
    expect(report.graph.status).toBe("active");
    expect(report.deadTasksRecovered).toHaveLength(0);
    expect(report.redispatchedTasks).toHaveLength(0);
  });

  it("marks running tasks with no sessionId as dead and calls onTaskFailed", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();

    gm.getGraph.mockResolvedValue({
      id: "g-dead",
      project: "proj",
      status: "active",
      createdAt: Date.now() - 10000,
    });
    gm.getAllTasks.mockResolvedValue([
      { id: "orphan", status: "running", sessionId: null, startedAt: Date.now() - 5000 },
    ]);
    gm.onTaskFailed.mockResolvedValue(undefined);
    gm.resumeDispatch.mockResolvedValue([]);

    const redis = makeRedis();
    redis.set.mockResolvedValue("OK");
    const pm = makeProcessMonitor();

    registerResumeGraph(server, gm, redis, pm, createStaticResolver({ sessionId: "sess-orch" }));

    const result = await invoke({ graphId: "g-dead" });

    expect(gm.onTaskFailed).toHaveBeenCalledWith("g-dead", "orphan", "", 1);
    const report = JSON.parse(result.content[0].text);
    expect(report.deadTasksRecovered).toContain("orphan");
  });
});

// ---------------------------------------------------------------------------
// reject_task
// ---------------------------------------------------------------------------
describe("reject_task handler", () => {
  it("returns isError when task is not found", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getTask.mockResolvedValue(null);
    const rm = makeReworkManager();

    registerRejectTask(server, gm, rm, createStaticResolver({ sessionId: "sess-reviewer" }));

    const result = await invoke({ graphId: "g1", taskId: "ghost", reason: "missing", maxReworks: 3 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns isError when task is not completed", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getTask.mockResolvedValue({ id: "t1", status: "running", role: "coder" });
    const rm = makeReworkManager();

    registerRejectTask(server, gm, rm, createStaticResolver({ sessionId: "sess-reviewer" }));

    const result = await invoke({ graphId: "g1", taskId: "t1", reason: "bad", maxReworks: 3 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not completed");
  });

  it("returns isError when rework iterations are exhausted", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getTask.mockResolvedValue({ id: "t1", status: "completed", role: "coder" });
    const rm = makeReworkManager();
    rm.canRework.mockResolvedValue(false);

    registerRejectTask(server, gm, rm, createStaticResolver({ sessionId: "sess-reviewer" }));

    const result = await invoke({ graphId: "g1", taskId: "t1", reason: "still bad", maxReworks: 3 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exhausted");
  });

  it("records rejection and adds rework task on happy path", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    gm.getTask.mockResolvedValue({
      id: "t1", status: "completed", role: "coder",
      task: "Original prompt", cwd: "/repo", branch: "main",
    });
    gm.addTask.mockResolvedValue(undefined);
    const rm = makeReworkManager();
    rm.canRework.mockResolvedValue(true);
    rm.getReworkCount.mockResolvedValue(0);
    rm.recordRejection.mockResolvedValue(undefined);

    registerRejectTask(server, gm, rm, createStaticResolver({ sessionId: "sess-reviewer" }));

    const result = await invoke({ graphId: "g1", taskId: "t1", reason: "Tests missing", maxReworks: 3 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("rework-t1-1");
    expect(result.content[0].text).toContain("Tests missing");

    expect(rm.recordRejection).toHaveBeenCalledWith("g1", "t1", expect.objectContaining({
      iteration: 1,
      reason: "Tests missing",
      rejectedBy: "sess-reviewer",
    }), expect.objectContaining({ role: "coder" }));
    expect(gm.addTask).toHaveBeenCalledWith("g1", expect.objectContaining({
      id: "rework-t1-1",
      role: "coder",
    }));
  });
});
