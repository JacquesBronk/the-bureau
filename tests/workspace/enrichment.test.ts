import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import Redis from "ioredis";
import {
  enrichResponse,
  formatConflictNote,
  formatDiscoveryNote,
  formatWorkspaceSummary,
  formatActiveGraphNote,
  type EnrichmentOpts,
} from "../../src/workspace/enrichment.js";
import { WorkspaceLedger } from "../../src/workspace/ledger.js";
import { DiscoveryStore } from "../../src/workspace/discovery.js";
import { GraphRegistry } from "../../src/workspace/graph-registry.js";
import type { WorkspaceConflict, WorkspaceIntent, Discovery } from "../../src/types/workspace.js";

// ─── formatConflictNote (pure function) ──────────────────────────────────────

describe("formatConflictNote()", () => {
  const baseIntent: WorkspaceIntent = {
    taskId: "other-task",
    graphId: "g1",
    files: ["src/foo.ts"],
    description: "adding feature X",
    role: "implementer",
    sessionId: "s1",
    updatedAt: Date.now(),
    phase: "implementing",
    lastDiscoveryId: "0-0",
  };

  it("produces [CONFLICT <severity>] header with agent id, role, and file", () => {
    const conflict: WorkspaceConflict = {
      taskA: "my-task",
      taskB: "other-task",
      files: ["src/foo.ts"],
      severity: "high",
      detectedAt: Date.now(),
    };
    const intents = new Map([["other-task", baseIntent]]);

    const note = formatConflictNote(conflict, intents);

    expect(note).toMatch(/^\[CONFLICT high\]/);
    expect(note).toContain("other-task");
    expect(note).toContain("implementer");
    expect(note).toContain("src/foo.ts");
  });

  it("includes an Action: line with yield_to call referencing the conflicting agent", () => {
    const conflict: WorkspaceConflict = {
      taskA: "my-task",
      taskB: "other-task",
      files: ["src/foo.ts"],
      severity: "high",
      detectedAt: Date.now(),
    };
    const intents = new Map([["other-task", baseIntent]]);

    const note = formatConflictNote(conflict, intents);

    expect(note).toContain("Action:");
    expect(note).toContain('yield_to(["other-task"])');
  });

  it("uses 'critical' severity in header when conflict is critical", () => {
    const conflict: WorkspaceConflict = {
      taskA: "my-task",
      taskB: "other-task",
      files: ["src/foo.ts"],
      severity: "critical",
      detectedAt: Date.now(),
    };
    const intents = new Map([["other-task", baseIntent]]);

    const note = formatConflictNote(conflict, intents);

    expect(note).toContain("[CONFLICT critical]");
  });

  it("falls back to 'unknown' role when intent is not in the map", () => {
    const conflict: WorkspaceConflict = {
      taskA: "my-task",
      taskB: "ghost-task",
      files: ["src/bar.ts"],
      severity: "high",
      detectedAt: Date.now(),
    };

    const note = formatConflictNote(conflict, new Map());

    expect(note).toContain("ghost-task");
    expect(note).toContain("unknown");
    expect(note).toContain("Action:");
  });
});

// ─── formatDiscoveryNote (pure function) ─────────────────────────────────────

describe("formatDiscoveryNote()", () => {
  it("produces [DISCOVERY] header with agent id, content, and Action line", () => {
    const discovery: Discovery = {
      id: "1234-0",
      taskId: "agent-a",
      role: "coder",
      topic: "redis-client",
      content: "createRedisClient() requires poolSize option",
      files: ["src/redis.ts"],
      scope: "graph",
      timestamp: Date.now(),
    };

    const note = formatDiscoveryNote(discovery);

    expect(note).toMatch(/^\[DISCOVERY\]/);
    expect(note).toContain("agent-a");
    expect(note).toContain("coder");
    expect(note).toContain("createRedisClient() requires poolSize option");
    expect(note).toContain("Action:");
    expect(note).toContain('query_discoveries("redis-client")');
  });

  it("includes 'Related to your work on' line when files array is non-empty", () => {
    const discovery: Discovery = {
      id: "1234-0",
      taskId: "agent-a",
      role: "coder",
      topic: "redis-client",
      content: "some finding",
      files: ["src/redis.ts"],
      scope: "graph",
      timestamp: Date.now(),
    };

    const note = formatDiscoveryNote(discovery);

    expect(note).toContain("Related to your work on src/redis.ts");
  });

  it("omits file line when files array is empty", () => {
    const discovery: Discovery = {
      id: "1234-0",
      taskId: "agent-a",
      role: "coder",
      topic: "auth",
      content: "JWT now required",
      files: [],
      scope: "graph",
      timestamp: Date.now(),
    };

    const note = formatDiscoveryNote(discovery);

    expect(note).not.toContain("Related to your work on");
    expect(note).toContain("Action:");
  });
});

// ─── formatWorkspaceSummary (pure function) ───────────────────────────────────

describe("formatWorkspaceSummary()", () => {
  it("returns empty string when intents array is empty", () => {
    expect(formatWorkspaceSummary([])).toBe("");
  });

  it("produces [WORKSPACE] header with agent count and graphId", () => {
    const intents: WorkspaceIntent[] = [
      {
        taskId: "agent-a",
        graphId: "graph-xyz",
        files: ["src/mcp-server.ts"],
        description: "adding list_graphs tool",
        role: "implementer",
        sessionId: "s1",
        updatedAt: Date.now(),
        phase: "implementing",
        lastDiscoveryId: "0-0",
      },
      {
        taskId: "agent-b",
        graphId: "graph-xyz",
        files: ["tests/integration/"],
        description: "writing e2e tests",
        role: "tester",
        sessionId: "s2",
        updatedAt: Date.now(),
        phase: "testing",
        lastDiscoveryId: "0-0",
      },
    ];

    const summary = formatWorkspaceSummary(intents);

    expect(summary).toContain("[WORKSPACE]");
    expect(summary).toContain("2 agents active");
    expect(summary).toContain("graph-xyz");
  });

  it("uses singular 'agent' when only one intent", () => {
    const intents: WorkspaceIntent[] = [
      {
        taskId: "solo",
        graphId: "g1",
        files: [],
        description: "",
        role: "coder",
        sessionId: "",
        updatedAt: Date.now(),
        phase: "implementing",
        lastDiscoveryId: "0-0",
      },
    ];

    const summary = formatWorkspaceSummary(intents);

    expect(summary).toContain("1 agent active");
    expect(summary).not.toMatch(/1 agents/);
  });

  it("includes one line per agent with taskId, role, phase, and first file", () => {
    const intents: WorkspaceIntent[] = [
      {
        taskId: "api-tools",
        graphId: "g1",
        files: ["src/mcp-server.ts", "src/other.ts"],
        description: "adding list_graphs tool",
        role: "implementer",
        sessionId: "s1",
        updatedAt: Date.now(),
        phase: "implementing",
        lastDiscoveryId: "0-0",
      },
    ];

    const summary = formatWorkspaceSummary(intents);

    expect(summary).toContain("api-tools");
    expect(summary).toContain("implementer");
    expect(summary).toContain("src/mcp-server.ts");
    expect(summary).toContain("[implementing]");
  });

  it("shows '(no files declared)' when agent has no files", () => {
    const intents: WorkspaceIntent[] = [
      {
        taskId: "planner",
        graphId: "g1",
        files: [],
        description: "planning phase",
        role: "tech-lead",
        sessionId: "s1",
        updatedAt: Date.now(),
        phase: "planning",
        lastDiscoveryId: "0-0",
      },
    ];

    const summary = formatWorkspaceSummary(intents);

    expect(summary).toContain("(no files declared)");
  });
});

// ─── truncateDesc (via pure function render sites) ───────────────────────────

describe("description truncation in formatConflictNote()", () => {
  it("truncates descriptions longer than 120 chars with an ellipsis", () => {
    const longDesc = "a".repeat(130);
    const intent: WorkspaceIntent = {
      taskId: "other-task",
      graphId: "g1",
      files: ["src/foo.ts"],
      description: longDesc,
      role: "implementer",
      sessionId: "s1",
      updatedAt: Date.now(),
      phase: "implementing",
      lastDiscoveryId: "0-0",
    };
    const conflict: WorkspaceConflict = {
      taskA: "my-task",
      taskB: "other-task",
      files: ["src/foo.ts"],
      severity: "high",
      detectedAt: Date.now(),
    };
    const note = formatConflictNote(conflict, new Map([["other-task", intent]]));
    expect(note).not.toContain(longDesc);
    expect(note).toContain("…");
    // truncated portion is at most 120 chars
    const match = note.match(/\(([^)]+)\)/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(120);
  });

  it("leaves descriptions of exactly 120 chars unchanged", () => {
    const exactDesc = "b".repeat(120);
    const intent: WorkspaceIntent = {
      taskId: "other-task",
      graphId: "g1",
      files: ["src/foo.ts"],
      description: exactDesc,
      role: "implementer",
      sessionId: "s1",
      updatedAt: Date.now(),
      phase: "implementing",
      lastDiscoveryId: "0-0",
    };
    const conflict: WorkspaceConflict = {
      taskA: "my-task",
      taskB: "other-task",
      files: ["src/foo.ts"],
      severity: "high",
      detectedAt: Date.now(),
    };
    const note = formatConflictNote(conflict, new Map([["other-task", intent]]));
    expect(note).toContain(exactDesc);
    expect(note).not.toContain("…");
  });
});

describe("description truncation in formatWorkspaceSummary()", () => {
  it("truncates descriptions longer than 120 chars with an ellipsis", () => {
    const longDesc = "c".repeat(130);
    const intents: WorkspaceIntent[] = [
      {
        taskId: "agent-a",
        graphId: "g1",
        files: ["src/foo.ts"],
        description: longDesc,
        role: "coder",
        sessionId: "s1",
        updatedAt: Date.now(),
        phase: "implementing",
        lastDiscoveryId: "0-0",
      },
    ];
    const summary = formatWorkspaceSummary(intents);
    expect(summary).not.toContain(longDesc);
    expect(summary).toContain("…");
  });

  it("leaves short descriptions unchanged", () => {
    const shortDesc = "short desc";
    const intents: WorkspaceIntent[] = [
      {
        taskId: "agent-a",
        graphId: "g1",
        files: ["src/foo.ts"],
        description: shortDesc,
        role: "coder",
        sessionId: "s1",
        updatedAt: Date.now(),
        phase: "implementing",
        lastDiscoveryId: "0-0",
      },
    ];
    const summary = formatWorkspaceSummary(intents);
    expect(summary).toContain(shortDesc);
    expect(summary).not.toContain("…");
  });
});

// ─── enrichResponse (Redis-backed integration tests) ─────────────────────────

describe("enrichResponse()", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let ledger: WorkspaceLedger;
  let store: DiscoveryStore;
  let graphId: string;
  const MY_TASK = "my-task";

  beforeEach(() => {
    graphId = `test-enrich-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ledger = new WorkspaceLedger(redis);
    store = new DiscoveryStore(redis);
  });

  afterEach(async () => {
    await ledger.cleanupGraph(graphId);
    await store.cleanupGraph(graphId);
    // Belt-and-suspenders: remove any lingering keys
    const keys = await redis.keys(`workspace:${graphId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  function makeOpts(toolName: string, overrides: Partial<EnrichmentOpts> = {}): EnrichmentOpts {
    return {
      toolName,
      graphId,
      taskId: MY_TASK,
      response: "original response",
      ledger,
      discoveryStore: store,
      ...overrides,
    };
  }

  // ─── BUREAU_DISABLE_ENRICHMENT bypass ──────────────────────────────────────

  describe("BUREAU_DISABLE_ENRICHMENT bypass", () => {
    it("returns response unchanged when env var is 'true', regardless of tool", async () => {
      const original = process.env.BUREAU_DISABLE_ENRICHMENT;
      process.env.BUREAU_DISABLE_ENRICHMENT = "true";
      try {
        // Set up a real conflict so enrichment would normally inject notes
        await ledger.publishIntent(graphId, MY_TASK, {
          files: ["src/conflict.ts"],
          phase: "implementing",
        });
        await ledger.publishIntent(graphId, "other-task", {
          files: ["src/conflict.ts"],
          phase: "implementing",
        });

        const result = await enrichResponse(makeOpts("set_status"));

        expect(result).toBe("original response");
      } finally {
        if (original === undefined) {
          delete process.env.BUREAU_DISABLE_ENRICHMENT;
        } else {
          process.env.BUREAU_DISABLE_ENRICHMENT = original;
        }
      }
    });
  });

  // ─── Missing graphId or taskId ─────────────────────────────────────────────

  describe("missing graphId or taskId", () => {
    it("returns response unchanged when graphId is undefined", async () => {
      const result = await enrichResponse(makeOpts("set_status", { graphId: undefined }));
      expect(result).toBe("original response");
    });

    it("returns response unchanged when taskId is undefined", async () => {
      const result = await enrichResponse(makeOpts("set_status", { taskId: undefined }));
      expect(result).toBe("original response");
    });
  });

  // ─── Non-enriched tools ────────────────────────────────────────────────────

  describe("non-enriched tools", () => {
    it("returns response unchanged for spawn_session", async () => {
      const result = await enrichResponse(makeOpts("spawn_session"));
      expect(result).toBe("original response");
    });

    it("returns response unchanged for list_peers", async () => {
      const result = await enrichResponse(makeOpts("list_peers"));
      expect(result).toBe("original response");
    });

    it("returns response unchanged for get_task_graph", async () => {
      const result = await enrichResponse(makeOpts("get_task_graph"));
      expect(result).toBe("original response");
    });
  });

  // ─── set_status enrichment ─────────────────────────────────────────────────

  describe("set_status enrichment", () => {
    it("appends --- Workspace --- section with [CONFLICT high] when same file, non-both-implementing", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/redis.ts"],
        phase: "planning",
      });
      await ledger.publishIntent(graphId, "other-task", {
        files: ["src/redis.ts"],
        role: "implementer",
        phase: "implementing",
      });

      const result = await enrichResponse(makeOpts("set_status"));

      expect(result).toContain("--- Workspace ---");
      expect(result).toContain("[CONFLICT high]");
      expect(result).toContain("src/redis.ts");
      expect(result).toContain("Action:");
    });

    it("appends [CONFLICT critical] when both agents are implementing the same file", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/redis.ts"],
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "other-task", {
        files: ["src/redis.ts"],
        role: "implementer",
        phase: "implementing",
      });

      const result = await enrichResponse(makeOpts("set_status"));

      expect(result).toContain("[CONFLICT critical]");
    });

    it("does NOT append workspace section when conflict severity is only low", async () => {
      // Same directory, different files → low severity
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/foo.ts"],
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "other-task", {
        files: ["src/bar.ts"],
        phase: "implementing",
      });

      const result = await enrichResponse(makeOpts("set_status"));

      expect(result).not.toContain("--- Workspace ---");
      expect(result).toBe("original response");
    });

    it("does NOT append workspace section when there are no conflicts at all", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/foo.ts"],
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "other-task", {
        files: ["tests/bar.test.ts"],
        phase: "implementing",
      });

      const result = await enrichResponse(makeOpts("set_status"));

      expect(result).toBe("original response");
    });

    it("appends [DISCOVERY] note when a discovery topic matches intent description", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/redis.ts"],
        description: "working on redis client",
        phase: "implementing",
        lastDiscoveryId: "0-0",
      });
      await store.postDiscovery(graphId, {
        taskId: "agent-a",
        role: "coder",
        topic: "redis",
        content: "createRedisClient requires poolSize",
        files: [],
      });

      const result = await enrichResponse(makeOpts("set_status"));

      expect(result).toContain("[DISCOVERY]");
      expect(result).toContain("createRedisClient requires poolSize");
      expect(result).toContain("Action:");
    });

    it("does NOT append discovery note when topic does not match intent", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/graphql.ts"],
        description: "working on graphql resolvers",
        phase: "implementing",
        lastDiscoveryId: "0-0",
      });
      await store.postDiscovery(graphId, {
        taskId: "agent-a",
        role: "coder",
        topic: "redis",
        content: "redis optimization tip",
        files: ["src/redis.ts"],
      });

      const result = await enrichResponse(makeOpts("set_status"));

      expect(result).not.toContain("[DISCOVERY]");
      expect(result).toBe("original response");
    });
  });

  // ─── check_messages enrichment ────────────────────────────────────────────

  describe("check_messages enrichment", () => {
    it("appends [WORKSPACE] summary with one line per active agent", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/tools.ts"],
        description: "adding new tool",
        role: "coder",
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "tester-task", {
        files: ["tests/integration/"],
        description: "writing e2e tests",
        role: "tester",
        phase: "testing",
      });

      const result = await enrichResponse(makeOpts("check_messages"));

      expect(result).toContain("[WORKSPACE]");
      expect(result).toContain(MY_TASK);
      expect(result).toContain("tester-task");
      expect(result).toContain("[implementing]");
      expect(result).toContain("[testing]");
    });

    it("returns response unchanged when no intents exist for the graph", async () => {
      const result = await enrichResponse(makeOpts("check_messages"));
      expect(result).toBe("original response");
    });

    it("appends [DISCOVERY] note for pending discoveries on check_messages", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/redis.ts"],
        description: "redis improvements",
        phase: "implementing",
        lastDiscoveryId: "0-0",
      });
      await store.postDiscovery(graphId, {
        taskId: "agent-a",
        role: "coder",
        topic: "redis",
        content: "connection pool size matters",
        files: [],
      });
      // Publish another intent so workspace summary fires (non-empty intents)
      await ledger.publishIntent(graphId, "other-task", {
        files: [],
        role: "reviewer",
        phase: "reviewing",
      });

      const result = await enrichResponse(makeOpts("check_messages"));

      expect(result).toContain("[DISCOVERY]");
      expect(result).toContain("connection pool size matters");
    });
  });

  // ─── lock_files enrichment ────────────────────────────────────────────────

  describe("lock_files enrichment", () => {
    it("warns about overlap with another agent's declared intent when files intersect", async () => {
      await ledger.publishIntent(graphId, "other-agent", {
        files: ["src/redis.ts", "src/types.ts"],
        role: "implementer",
        description: "refactoring redis layer",
        phase: "implementing",
      });

      const result = await enrichResponse(
        makeOpts("lock_files", {
          toolArgs: { files: ["src/redis.ts", "src/unrelated.ts"] },
        })
      );

      expect(result).toContain("--- Workspace ---");
      expect(result).toContain("[CONFLICT high]");
      expect(result).toContain("other-agent");
      expect(result).toContain("src/redis.ts");
      expect(result).toContain("Action:");
    });

    it("returns response unchanged when locked files have no overlap with other intents", async () => {
      await ledger.publishIntent(graphId, "other-agent", {
        files: ["src/graphql.ts"],
        role: "implementer",
        phase: "implementing",
      });

      const result = await enrichResponse(
        makeOpts("lock_files", {
          toolArgs: { files: ["src/redis.ts"] },
        })
      );

      expect(result).toBe("original response");
    });

    it("returns response unchanged when toolArgs.files is empty", async () => {
      await ledger.publishIntent(graphId, "other-agent", {
        files: ["src/anything.ts"],
        role: "implementer",
        phase: "implementing",
      });

      const result = await enrichResponse(
        makeOpts("lock_files", { toolArgs: { files: [] } })
      );

      expect(result).toBe("original response");
    });

    it("does not warn about the calling task's own intent", async () => {
      // MY_TASK declares the same files — should not conflict with itself
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/redis.ts"],
        phase: "implementing",
      });

      const result = await enrichResponse(
        makeOpts("lock_files", { toolArgs: { files: ["src/redis.ts"] } })
      );

      expect(result).toBe("original response");
    });
  });

  // ─── set_status auto-declare-intent hint ──────────────────────────────────

  describe("set_status auto-declare-intent hint", () => {
    it("appends [WORKSPACE HINT] when phase is 'implementing' and no intent exists", async () => {
      const result = await enrichResponse(
        makeOpts("set_status", { toolArgs: { phase: "implementing", description: "adding new feature" } })
      );

      expect(result).toContain("[WORKSPACE HINT]");
      expect(result).toContain("declare_intent");
    });

    it("does NOT append [WORKSPACE HINT] when intent already exists for the task", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/foo.ts"],
        description: "working on foo",
        phase: "implementing",
      });

      const result = await enrichResponse(
        makeOpts("set_status", { toolArgs: { phase: "implementing" } })
      );

      expect(result).not.toContain("[WORKSPACE HINT]");
    });

    it("does NOT append [WORKSPACE HINT] when phase is 'starting' (not implementing)", async () => {
      const result = await enrichResponse(
        makeOpts("set_status", { toolArgs: { phase: "starting" } })
      );

      expect(result).not.toContain("[WORKSPACE HINT]");
    });

    it("does NOT append [WORKSPACE HINT] when phase is not provided in toolArgs", async () => {
      const result = await enrichResponse(makeOpts("set_status"));

      expect(result).not.toContain("[WORKSPACE HINT]");
    });
  });

  // ─── send_message enrichment ──────────────────────────────────────────────

  describe("send_message enrichment", () => {
    it("appends [CONFLICT high] when high-severity conflict exists", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/server.ts"],
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "other-task", {
        files: ["src/server.ts"],
        role: "implementer",
        phase: "planning",
      });

      const result = await enrichResponse(makeOpts("send_message"));

      expect(result).toContain("--- Workspace ---");
      expect(result).toContain("[CONFLICT high]");
      expect(result).toContain("src/server.ts");
      expect(result).toContain("Action:");
    });

    it("appends [CONFLICT critical] when both agents are implementing the same file", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/server.ts"],
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "other-task", {
        files: ["src/server.ts"],
        role: "implementer",
        phase: "implementing",
      });

      const result = await enrichResponse(makeOpts("send_message"));

      expect(result).toContain("[CONFLICT critical]");
    });

    it("returns response unchanged when conflict severity is only low", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/foo.ts"],
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "other-task", {
        files: ["src/bar.ts"],
        phase: "implementing",
      });

      const result = await enrichResponse(makeOpts("send_message"));

      expect(result).toBe("original response");
    });

    it("returns response unchanged when there are no conflicts", async () => {
      const result = await enrichResponse(makeOpts("send_message"));
      expect(result).toBe("original response");
    });
  });

  // ─── list_peers enrichment ────────────────────────────────────────────────

  describe("list_peers enrichment", () => {
    it("appends [WORKSPACE] summary when intents exist", async () => {
      await ledger.publishIntent(graphId, "agent-a", {
        files: ["src/tools.ts"],
        description: "adding list_graphs tool",
        role: "coder",
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "agent-b", {
        files: ["tests/"],
        description: "writing tests",
        role: "tester",
        phase: "testing",
      });

      const result = await enrichResponse(makeOpts("list_peers"));

      expect(result).toContain("[WORKSPACE]");
      expect(result).toContain("agent-a");
      expect(result).toContain("agent-b");
      expect(result).toContain("[implementing]");
      expect(result).toContain("[testing]");
    });

    it("returns response unchanged when no intents exist", async () => {
      const result = await enrichResponse(makeOpts("list_peers"));
      expect(result).toBe("original response");
    });
  });

  // ─── set_handoff enrichment ───────────────────────────────────────────────

  describe("set_handoff enrichment", () => {
    it("appends workspace summary when other agents are active", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/api.ts"],
        description: "shipping feature",
        role: "coder",
        phase: "committing",
      });
      await ledger.publishIntent(graphId, "peer-task", {
        files: ["src/utils.ts"],
        description: "refactoring utils",
        role: "coder",
        phase: "implementing",
      });

      const result = await enrichResponse(makeOpts("set_handoff"));

      expect(result).toContain("[WORKSPACE]");
      expect(result).toContain(MY_TASK);
      expect(result).toContain("peer-task");
    });

    it("appends conflict notes for all severities (not just high/critical)", async () => {
      // Both implementing same file → critical
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/shared.ts"],
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "peer-task", {
        files: ["src/shared.ts"],
        role: "implementer",
        phase: "implementing",
      });

      const result = await enrichResponse(makeOpts("set_handoff"));

      expect(result).toContain("[CONFLICT");
      expect(result).toContain("src/shared.ts");
      expect(result).toContain("Action:");
    });

    it("returns response unchanged when no intents exist", async () => {
      const result = await enrichResponse(makeOpts("set_handoff"));
      expect(result).toBe("original response");
    });

    it("appends both workspace summary and conflict notes when both apply", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/conflict.ts"],
        phase: "implementing",
        role: "coder",
      });
      await ledger.publishIntent(graphId, "other-task", {
        files: ["src/conflict.ts"],
        role: "implementer",
        phase: "implementing",
      });

      const result = await enrichResponse(makeOpts("set_handoff"));

      expect(result).toContain("[WORKSPACE]");
      expect(result).toContain("[CONFLICT");
    });
  });

  // ─── Parent graph read-access via parentGraphId ───────────────────────────

  describe("parentGraphId threading", () => {
    let parentGraphId: string;

    beforeEach(() => {
      parentGraphId = `test-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    });

    afterEach(async () => {
      await ledger.cleanupGraph(parentGraphId);
      const keys = await redis.keys(`workspace:${parentGraphId}:*`);
      if (keys.length > 0) await redis.del(...keys);
    });

    it("set_status: child-graph agent sees parent-graph conflict when parentGraphId is provided", async () => {
      // Child task declares intent on a file
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/shared.ts"],
        phase: "implementing",
      });
      // Parent graph has another task on the same file
      await ledger.publishIntent(parentGraphId, "parent-task", {
        files: ["src/shared.ts"],
        phase: "implementing",
        role: "coder",
      });

      const result = await enrichResponse(
        makeOpts("set_status", { parentGraphId })
      );

      expect(result).toContain("[CONFLICT");
      expect(result).toContain("src/shared.ts");
    });

    it("set_status: WITHOUT parentGraphId, child-graph agent does NOT see parent-graph conflict", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/shared.ts"],
        phase: "implementing",
      });
      await ledger.publishIntent(parentGraphId, "parent-task", {
        files: ["src/shared.ts"],
        phase: "implementing",
        role: "coder",
      });

      // No parentGraphId passed — behavior byte-identical to before
      const result = await enrichResponse(makeOpts("set_status"));

      expect(result).toBe("original response");
    });

    it("list_peers: parent intents appear in workspace summary when parentGraphId provided", async () => {
      await ledger.publishIntent(parentGraphId, "parent-agent", {
        files: ["src/parent.ts"],
        description: "parent work",
        role: "architect",
        phase: "planning",
      });

      const result = await enrichResponse(
        makeOpts("list_peers", { parentGraphId })
      );

      expect(result).toContain("[WORKSPACE]");
      expect(result).toContain("parent-agent");
    });

    it("list_peers: parent intents NOT in summary when parentGraphId is omitted", async () => {
      await ledger.publishIntent(parentGraphId, "parent-agent", {
        files: ["src/parent.ts"],
        description: "parent work",
        role: "architect",
        phase: "planning",
      });

      const result = await enrichResponse(makeOpts("list_peers"));

      expect(result).toBe("original response");
    });

    it("graphs without a parent: no fromParent entries, behavior unchanged", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: ["src/only.ts"],
        phase: "implementing",
      });
      await ledger.publishIntent(graphId, "peer-task", {
        files: ["src/other.ts"],
        role: "coder",
        phase: "planning",
      });

      // No parentGraphId — must behave exactly as if feature didn't exist
      const intents = await ledger.getAllIntents(graphId);
      expect(intents.every((i) => !i.fromParent)).toBe(true);

      const result = await enrichResponse(makeOpts("list_peers"));
      expect(result).toContain("[WORKSPACE]");
      expect(result).not.toContain("fromParent");
    });
  });

  // ─── Discovery high-water mark ────────────────────────────────────────────

  describe("discovery high-water mark", () => {
    it("updates lastDiscoveryId after surfacing a discovery via set_status", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: [],
        description: "working on redis auth",
        phase: "implementing",
        lastDiscoveryId: "0-0",
      });
      await store.postDiscovery(graphId, {
        taskId: "agent-a",
        role: "coder",
        topic: "redis",
        content: "auth token TTL is 30s",
        files: [],
      });

      // First call — discovery should surface and high-water mark should advance
      const first = await enrichResponse(makeOpts("set_status"));
      expect(first).toContain("[DISCOVERY]");

      // Read back the intent and verify lastDiscoveryId is no longer "0-0"
      const updated = await ledger.getIntent(graphId, MY_TASK);
      expect(updated!.lastDiscoveryId).not.toBe("0-0");
    });

    it("does not re-surface the same discovery on the second call", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: [],
        description: "working on redis auth",
        phase: "implementing",
        lastDiscoveryId: "0-0",
      });
      await store.postDiscovery(graphId, {
        taskId: "agent-a",
        role: "coder",
        topic: "redis",
        content: "auth token TTL is 30s",
        files: [],
      });

      // First call surfaces and advances the mark
      await enrichResponse(makeOpts("set_status"));

      // Second call — same discovery should NOT appear again
      const second = await enrichResponse(makeOpts("set_status"));
      expect(second).not.toContain("[DISCOVERY]");
      expect(second).toBe("original response");
    });

    it("surfaces a new discovery posted after the high-water mark", async () => {
      await ledger.publishIntent(graphId, MY_TASK, {
        files: [],
        description: "working on redis",
        phase: "implementing",
        lastDiscoveryId: "0-0",
      });

      const oldId = await store.postDiscovery(graphId, {
        taskId: "agent-a",
        role: "coder",
        topic: "redis",
        content: "first discovery",
        files: [],
      });

      // Advance the mark past the first discovery
      await ledger.publishIntent(graphId, MY_TASK, { lastDiscoveryId: oldId });

      // Post a second discovery after the mark
      await store.postDiscovery(graphId, {
        taskId: "agent-a",
        role: "coder",
        topic: "redis",
        content: "second discovery",
        files: [],
      });

      const result = await enrichResponse(makeOpts("set_status"));

      expect(result).toContain("second discovery");
      expect(result).not.toContain("first discovery");
    });
  });

  // ─── Cross-graph registry notes ───────────────────────────────────────────

  describe("cross-graph registry notes", () => {
    it("surfaces a registry-backed peer note on set_status without any declare_intent", async () => {
      const dk = `test-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const reg = new GraphRegistry(redis);
      // Peer graph A (project 'a') active on the shared destination, predicted to touch service.py
      await reg.register(dk, {
        graphId: "gA", project: "a", status: "active", destination: dk, baseRef: "dogfood",
        focus: ["change service signatures"], predictedFiles: ["src/service.py"],
        startedAt: 1, updatedAt: 1,
      });
      // Caller graph B (project 'b') also predicted to touch service.py — NO declare_intent called
      await reg.register(dk, {
        graphId: "gB", project: "b", status: "active", destination: dk, baseRef: "dogfood",
        focus: ["update test doubles"], predictedFiles: ["src/service.py"],
        startedAt: 1, updatedAt: 1,
      });

      const out = await enrichResponse({
        toolName: "set_status", graphId: "gB", taskId: "t1", response: "ok",
        ledger, discoveryStore: store, graphRegistry: reg, destKey: dk,
      } as any);

      expect(out).toContain("gA".slice(0, 7));
      expect(out).toContain("src/service.py"); // overlap surfaced
    });

    it("surfaces a registry-backed peer note on check_messages without any declare_intent", async () => {
      const dk = `test-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const reg = new GraphRegistry(redis);
      await reg.register(dk, {
        graphId: "gA", project: "a", status: "active", destination: dk, baseRef: "dogfood",
        focus: ["change service signatures"], predictedFiles: ["src/service.py"],
        startedAt: 1, updatedAt: 1,
      });
      await reg.register(dk, {
        graphId: "gB", project: "b", status: "active", destination: dk, baseRef: "dogfood",
        focus: ["update test doubles"], predictedFiles: ["src/service.py"],
        startedAt: 1, updatedAt: 1,
      });

      // No declare_intent called — cross-graph note must still fire on check_messages
      const out = await enrichResponse({
        toolName: "check_messages", graphId: "gB", taskId: "t1", response: "ok",
        ledger, discoveryStore: store, graphRegistry: reg, destKey: dk,
      } as any);

      expect(out).toContain("gA".slice(0, 7));
    });
  });
});
