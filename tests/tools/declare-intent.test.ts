import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import Redis from "ioredis";
import { WorkspaceLedger } from "../../src/workspace/ledger.js";
import { registerDeclareIntent } from "../../src/tools/declare-intent.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

// ─── captureHandler helper ────────────────────────────────────────────────────

function captureHandler(register: (server: any) => void) {
  let handler: (...args: any[]) => any;
  const server = {
    registerTool: vi.fn((_name: string, _schema: unknown, h: (...args: any[]) => any) => {
      handler = h;
    }),
  };
  register(server);
  return (args: Record<string, unknown>) => handler(args);
}

// ─── declare_intent unit tests (mock ledger) ─────────────────────────────────

describe("declare_intent tool (unit — mock ledger)", () => {
  it("returns isError when graphId is missing", async () => {
    const ledger = { publishIntent: vi.fn(), detectConflicts: vi.fn() } as any;
    const invoke = captureHandler((server) =>
      registerDeclareIntent(server, ledger, createStaticResolver({ sessionId: "", graphId: undefined, taskId: "t1" }))
    );

    const result = await invoke({ files: ["src/foo.ts"], description: "doing work" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("graph context");
  });

  it("returns isError when taskId is missing", async () => {
    const ledger = { publishIntent: vi.fn(), detectConflicts: vi.fn() } as any;
    const invoke = captureHandler((server) =>
      registerDeclareIntent(server, ledger, createStaticResolver({ sessionId: "", graphId: "g1", taskId: undefined }))
    );

    const result = await invoke({ files: ["src/foo.ts"], description: "doing work" });

    expect(result.isError).toBe(true);
  });

  it("publishes intent and returns no-conflict message when no conflicts", async () => {
    const ledger = {
      publishIntent: vi.fn().mockResolvedValue(undefined),
      detectConflicts: vi.fn().mockResolvedValue([]),
    } as any;
    const invoke = captureHandler((server) =>
      registerDeclareIntent(server, ledger, createStaticResolver({ sessionId: "", graphId: "g1", taskId: "t1" }))
    );

    const result = await invoke({ files: ["src/foo.ts"], description: "adding feature" });

    expect(ledger.publishIntent).toHaveBeenCalledWith("g1", "t1", {
      files: ["src/foo.ts"],
      description: "adding feature",
    }, undefined);
    expect(result.content[0].text).toContain("No conflicts detected");
  });

  it("passes undefined parentGraphId to detectConflicts when not in config (no parent)", async () => {
    const ledger = {
      publishIntent: vi.fn().mockResolvedValue(undefined),
      detectConflicts: vi.fn().mockResolvedValue([]),
    } as any;
    const invoke = captureHandler((server) =>
      registerDeclareIntent(server, ledger, createStaticResolver({ sessionId: "", graphId: "g1", taskId: "t1" }))
    );

    await invoke({ files: ["src/foo.ts"], description: "work" });

    // detectConflicts called without parentGraphId (third arg undefined)
    expect(ledger.detectConflicts).toHaveBeenCalledWith("g1", "t1", undefined);
  });

  it("passes parentGraphId to detectConflicts when provided in config", async () => {
    const ledger = {
      publishIntent: vi.fn().mockResolvedValue(undefined),
      detectConflicts: vi.fn().mockResolvedValue([]),
    } as any;
    const invoke = captureHandler((server) =>
      registerDeclareIntent(server, ledger, createStaticResolver({
        sessionId: "",
        graphId: "child-graph",
        taskId: "child-task",
        parentGraphId: "parent-graph",
      }))
    );

    await invoke({ files: ["src/shared.ts"], description: "child work" });

    expect(ledger.detectConflicts).toHaveBeenCalledWith(
      "child-graph",
      "child-task",
      "parent-graph"
    );
  });

  it("lists conflicts from parent graph in response when parentGraphId provided", async () => {
    const ledger = {
      publishIntent: vi.fn().mockResolvedValue(undefined),
      detectConflicts: vi.fn().mockResolvedValue([
        {
          taskA: "child-task",
          taskB: "parent-task",
          files: ["src/shared.ts"],
          severity: "critical",
          detectedAt: Date.now(),
        },
      ]),
    } as any;
    const invoke = captureHandler((server) =>
      registerDeclareIntent(server, ledger, createStaticResolver({
        sessionId: "",
        graphId: "child-graph",
        taskId: "child-task",
        parentGraphId: "parent-graph",
      }))
    );

    const result = await invoke({ files: ["src/shared.ts"], description: "child work" });

    expect(result.content[0].text).toContain("conflict");
    expect(result.content[0].text).toContain("parent-task");
    expect(result.content[0].text).toContain("CRITICAL");
  });
});

// ─── declare_intent integration tests (real Redis) ───────────────────────────

describe("declare_intent tool (integration — real Redis)", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let ledger: WorkspaceLedger;
  let childGraphId: string;
  let parentGraphId: string;

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    childGraphId = `test-child-${suffix}`;
    parentGraphId = `test-parent-${suffix}`;
    ledger = new WorkspaceLedger(redis);
  });

  afterEach(async () => {
    await ledger.cleanupGraph(childGraphId);
    await ledger.cleanupGraph(parentGraphId);
    for (const gid of [childGraphId, parentGraphId]) {
      const keys = await redis.keys(`workspace:${gid}:*`);
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("child graph declare_intent detects conflict with parent task on same file", async () => {
    // Parent graph already has a task working on the same file
    await ledger.publishIntent(parentGraphId, "parent-task", {
      files: ["src/shared.ts"],
      phase: "implementing",
      role: "architect",
    });

    const invoke = captureHandler((server) =>
      registerDeclareIntent(server, ledger, createStaticResolver({
        sessionId: "",
        graphId: childGraphId,
        taskId: "child-task",
        parentGraphId,
      }))
    );

    const result = await invoke({ files: ["src/shared.ts"], description: "child work" });

    expect(result.content[0].text).toContain("conflict");
    expect(result.content[0].text).toContain("parent-task");
  });

  it("child graph declare_intent sees NO conflict without parentGraphId even on same file", async () => {
    await ledger.publishIntent(parentGraphId, "parent-task", {
      files: ["src/shared.ts"],
      phase: "implementing",
      role: "architect",
    });

    // No parentGraphId — should not see parent conflict
    const invoke = captureHandler((server) =>
      registerDeclareIntent(server, ledger, createStaticResolver({
        sessionId: "",
        graphId: childGraphId,
        taskId: "child-task",
      }))
    );

    const result = await invoke({ files: ["src/shared.ts"], description: "child work" });

    expect(result.content[0].text).toContain("No conflicts detected");
  });

  it("root graph (no parent): declare_intent behavior unchanged — detects only sibling conflicts", async () => {
    // Two tasks in same graph share a file — standard conflict
    await ledger.publishIntent(childGraphId, "sibling-task", {
      files: ["src/api.ts"],
      phase: "implementing",
      role: "coder",
    });

    const invoke = captureHandler((server) =>
      registerDeclareIntent(server, ledger, createStaticResolver({
        sessionId: "",
        graphId: childGraphId,
        taskId: "child-task",
        // No parentGraphId
      }))
    );

    const result = await invoke({ files: ["src/api.ts"], description: "also working on api" });

    expect(result.content[0].text).toContain("conflict");
    expect(result.content[0].text).toContain("sibling-task");
  });
});
