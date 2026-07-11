/**
 * Integration tests for the workspace awareness system.
 *
 * These tests exercise the INTERACTION between WorkspaceLedger, DiscoveryStore,
 * YieldManager, and enrichResponse — not individual module methods in isolation.
 *
 * Run with: REDIS_URL=redis://redis.local:6379 npm test
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import Redis from "ioredis";
import { WorkspaceLedger } from "../../src/workspace/ledger.js";
import { DiscoveryStore } from "../../src/workspace/discovery.js";
import { YieldManager, shouldAutoResolve, selectForceProceeder } from "../../src/workspace/yield.js";
import { enrichResponse } from "../../src/workspace/enrichment.js";

// ─── Shared Redis connection ───────────────────────────────────────────────

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

afterAll(async () => {
  await redis.quit();
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function uniqueGraph(): string {
  return `test-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function cleanupGraph(graphId: string): Promise<void> {
  const workspaceKeys = await redis.keys(`workspace:${graphId}:*`);
  const yieldKeys = await redis.keys(`bureau:yield:${graphId}:*`);
  const allKeys = [...workspaceKeys, ...yieldKeys];
  if (allKeys.length > 0) await redis.del(...allKeys);
}

// ─── Test 1: Conflict detection e2e ───────────────────────────────────────

describe("conflict detection e2e", () => {
  let ledger: WorkspaceLedger;
  let store: DiscoveryStore;
  let graphId: string;

  beforeEach(() => {
    graphId = uniqueGraph();
    ledger = new WorkspaceLedger(redis);
    store = new DiscoveryStore(redis);
  });

  afterEach(async () => {
    await cleanupGraph(graphId);
  });

  it("enriches set_status with [CONFLICT critical] when two agents both implement the same file", async () => {
    await ledger.publishIntent(graphId, "agent-a", {
      files: ["src/redis.ts"],
      description: "adding XRANGE wrapper",
      role: "implementer",
      phase: "implementing",
      sessionId: "session-a",
    });
    await ledger.publishIntent(graphId, "agent-b", {
      files: ["src/redis.ts"],
      description: "refactoring connection pool",
      role: "coder",
      phase: "implementing",
      sessionId: "session-b",
    });

    const result = await enrichResponse({
      toolName: "set_status",
      graphId,
      taskId: "agent-a",
      response: "Status updated.",
      ledger,
      discoveryStore: store,
    });

    expect(result).toContain("[CONFLICT critical]");
    expect(result).toContain("agent-b");
    expect(result).toContain("src/redis.ts");
  });

  it("enriched conflict note includes an Action line mentioning yield_to", async () => {
    await ledger.publishIntent(graphId, "agent-a", {
      files: ["src/redis.ts"],
      phase: "implementing",
    });
    await ledger.publishIntent(graphId, "agent-b", {
      files: ["src/redis.ts"],
      phase: "implementing",
    });

    const result = await enrichResponse({
      toolName: "set_status",
      graphId,
      taskId: "agent-a",
      response: "Status updated.",
      ledger,
      discoveryStore: store,
    });

    expect(result).toContain("yield_to");
    expect(result).toContain("agent-b");
  });

  it("does not include [CONFLICT high] when severity is low (same directory, different files)", async () => {
    await ledger.publishIntent(graphId, "agent-a", {
      files: ["src/foo.ts"],
      phase: "implementing",
    });
    await ledger.publishIntent(graphId, "agent-b", {
      files: ["src/bar.ts"],
      phase: "implementing",
    });

    const result = await enrichResponse({
      toolName: "set_status",
      graphId,
      taskId: "agent-a",
      response: "Status updated.",
      ledger,
      discoveryStore: store,
    });

    expect(result).not.toContain("[CONFLICT");
  });
});

// ─── Test 2: Discovery flow e2e ────────────────────────────────────────────

describe("discovery flow e2e", () => {
  let ledger: WorkspaceLedger;
  let store: DiscoveryStore;
  let graphId: string;

  beforeEach(() => {
    graphId = uniqueGraph();
    ledger = new WorkspaceLedger(redis);
    store = new DiscoveryStore(redis);
  });

  afterEach(async () => {
    await cleanupGraph(graphId);
  });

  it("surfacing: discovery from agent-a appears in agent-b's set_status enrichment when topic matches", async () => {
    // Agent A working on redis
    await ledger.publishIntent(graphId, "agent-a", {
      files: ["src/redis.ts"],
      description: "implementing redis client wrapper",
      role: "coder",
      phase: "implementing",
      lastDiscoveryId: "0-0",
    });
    // Agent B working on mcp-server with redis-client integration
    await ledger.publishIntent(graphId, "agent-b", {
      files: ["src/mcp-server.ts"],
      description: "adding redis-client integration to mcp server",
      role: "coder",
      phase: "implementing",
      lastDiscoveryId: "0-0",
    });

    // Agent A posts a discovery relevant to redis-client
    await store.postDiscovery(graphId, {
      taskId: "agent-a",
      role: "coder",
      topic: "redis-client",
      content: "createRedisClient() needs poolSize option, default 5",
      files: ["src/redis.ts"],
    });

    // Enrich Agent B's set_status — should surface the discovery (topic 'redis-client' matches B's description)
    const result = await enrichResponse({
      toolName: "set_status",
      graphId,
      taskId: "agent-b",
      response: "Status updated.",
      ledger,
      discoveryStore: store,
    });

    expect(result).toContain("[DISCOVERY]");
    expect(result).toContain("createRedisClient() needs poolSize option");
    expect(result).toContain("agent-a");
  });

  it("high-water mark: same discovery is NOT surfaced again on the second set_status call", async () => {
    await ledger.publishIntent(graphId, "agent-b", {
      files: ["src/mcp-server.ts"],
      description: "adding redis-client integration to mcp server",
      role: "coder",
      phase: "implementing",
      lastDiscoveryId: "0-0",
    });

    await store.postDiscovery(graphId, {
      taskId: "agent-a",
      role: "coder",
      topic: "redis-client",
      content: "createRedisClient() needs poolSize option",
    });

    // First call — discovery appears
    const first = await enrichResponse({
      toolName: "set_status",
      graphId,
      taskId: "agent-b",
      response: "Status updated.",
      ledger,
      discoveryStore: store,
    });
    expect(first).toContain("[DISCOVERY]");

    // Second call — high-water mark was advanced; same discovery must not appear again
    const second = await enrichResponse({
      toolName: "set_status",
      graphId,
      taskId: "agent-b",
      response: "Status updated.",
      ledger,
      discoveryStore: store,
    });
    expect(second).not.toContain("[DISCOVERY]");
  });

  it("non-matching discovery (different topic and no file overlap) does not appear in enrichment", async () => {
    await ledger.publishIntent(graphId, "agent-b", {
      files: ["src/redis.ts"],
      description: "redis work",
      role: "coder",
      phase: "implementing",
      lastDiscoveryId: "0-0",
    });

    await store.postDiscovery(graphId, {
      taskId: "agent-a",
      role: "coder",
      topic: "graphql-schema",
      content: "added new query resolver",
      files: ["src/graphql/resolver.ts"],
    });

    const result = await enrichResponse({
      toolName: "set_status",
      graphId,
      taskId: "agent-b",
      response: "Status updated.",
      ledger,
      discoveryStore: store,
    });

    expect(result).not.toContain("[DISCOVERY]");
  });
});

// ─── Test 3: Yield and resume context ─────────────────────────────────────

describe("yield and resume context", () => {
  let yieldManager: YieldManager;
  let graphId: string;

  beforeEach(() => {
    graphId = uniqueGraph();
    yieldManager = new YieldManager(redis);
  });

  afterEach(async () => {
    await cleanupGraph(graphId);
  });

  it("yieldTo stores context that getYieldContext reads back with all fields", async () => {
    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-a",
      agents: ["agent-b"],
      reason: "redis.ts overlap with redis-layer agent",
      partialComplete: {
        summary: "added 3 wrapper functions",
        filesModified: ["src/redis.ts"],
        commitSha: "abc1234",
      },
    });

    const ctx = await yieldManager.getYieldContext(graphId, "agent-a");

    expect(ctx).not.toBeNull();
    expect(ctx!.taskId).toBe("agent-a");
    expect(ctx!.graphId).toBe(graphId);
    expect(ctx!.agents).toEqual(["agent-b"]);
    expect(ctx!.reason).toBe("redis.ts overlap with redis-layer agent");
    expect(ctx!.partialComplete?.summary).toBe("added 3 wrapper functions");
    expect(ctx!.partialComplete?.filesModified).toContain("src/redis.ts");
    expect(ctx!.partialComplete?.commitSha).toBe("abc1234");
  });

  it("resolveYield returns the context and removes it from Redis", async () => {
    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-a",
      agents: ["agent-b"],
      reason: "overlap",
    });

    const resolved = await yieldManager.resolveYield(graphId, "agent-a");
    expect(resolved).not.toBeNull();
    expect(resolved!.reason).toBe("overlap");

    // After resolve, the yield context is gone
    const after = await yieldManager.getYieldContext(graphId, "agent-a");
    expect(after).toBeNull();
  });

  it("buildResumeContext includes yield reason, partial progress, and handoff from completed agent", async () => {
    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-a",
      agents: ["agent-b"],
      reason: "redis.ts overlap with redis-layer agent",
      partialComplete: {
        summary: "added 3 wrapper functions",
        filesModified: ["src/redis.ts"],
        commitSha: "abc1234",
      },
    });

    const ctx = await yieldManager.resolveYield(graphId, "agent-a");
    expect(ctx).not.toBeNull();

    const resumeText = yieldManager.buildResumeContext(ctx!, {
      "agent-b": "completed redis refactor — poolSize default set to 5",
    });

    expect(resumeText).toContain("redis.ts overlap with redis-layer agent");
    expect(resumeText).toContain("added 3 wrapper functions");
    expect(resumeText).toContain("src/redis.ts");
    expect(resumeText).toContain("abc1234");
    expect(resumeText).toContain("agent-b");
    expect(resumeText).toContain("completed redis refactor");
  });
});

// ─── Test 4: Deadlock detection ───────────────────────────────────────────

describe("deadlock detection", () => {
  let yieldManager: YieldManager;
  let graphId: string;

  beforeEach(() => {
    graphId = uniqueGraph();
    yieldManager = new YieldManager(redis);
  });

  afterEach(async () => {
    await cleanupGraph(graphId);
  });

  it("detects a two-agent A→B, B→A deadlock cycle", async () => {
    await yieldManager.yieldTo({ graphId, taskId: "agent-a", agents: ["agent-b"], reason: "overlap" });
    await yieldManager.yieldTo({ graphId, taskId: "agent-b", agents: ["agent-a"], reason: "overlap" });

    const result = await yieldManager.detectDeadlock(graphId);

    expect(result.deadlocked).toBe(true);
    expect(result.cycle.length).toBeGreaterThan(0);
    expect(result.cycle).toContain("agent-a");
    expect(result.cycle).toContain("agent-b");
  });

  it("returns deadlocked=false when no cycle exists (A yields to B, B is not yielded)", async () => {
    await yieldManager.yieldTo({ graphId, taskId: "agent-a", agents: ["agent-b"], reason: "overlap" });
    // agent-b has not yielded to anyone

    const result = await yieldManager.detectDeadlock(graphId);

    expect(result.deadlocked).toBe(false);
    expect(result.cycle).toHaveLength(0);
  });

  it("selectForceProceeder picks an agent from a deadlocked pair", async () => {
    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-a",
      agents: ["agent-b"],
      reason: "overlap",
      partialComplete: { summary: "done some work", filesModified: ["src/a.ts"], commitSha: "abc" },
    });
    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-b",
      agents: ["agent-a"],
      reason: "overlap",
      partialComplete: { summary: "early work", filesModified: [] },
    });

    const yields = await yieldManager.getActiveYields(graphId);
    const proceeder = selectForceProceeder(yields);

    expect(proceeder).not.toBeNull();
    expect(["agent-a", "agent-b"]).toContain(proceeder);
  });

  it("selectForceProceeder prefers the agent with a commit SHA", async () => {
    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-a",
      agents: ["agent-b"],
      reason: "overlap",
      partialComplete: { summary: "more work done", filesModified: ["src/a.ts"], commitSha: "sha-abc" },
    });
    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-b",
      agents: ["agent-a"],
      reason: "overlap",
      partialComplete: { summary: "less work", filesModified: [] },
    });

    const yields = await yieldManager.getActiveYields(graphId);
    const proceeder = selectForceProceeder(yields);

    // agent-a has a commit SHA, agent-b does not — agent-a should be picked
    expect(proceeder).toBe("agent-a");
  });
});

// ─── Test 5: shouldAutoResolve scenarios ──────────────────────────────────

describe("shouldAutoResolve()", () => {
  let ledger: WorkspaceLedger;
  let yieldManager: YieldManager;
  let graphId: string;

  beforeEach(() => {
    graphId = uniqueGraph();
    ledger = new WorkspaceLedger(redis);
    yieldManager = new YieldManager(redis);
  });

  afterEach(async () => {
    await cleanupGraph(graphId);
  });

  it("returns 'no-conflict' when yielding agent and target agent have no file overlap", async () => {
    await ledger.publishIntent(graphId, "agent-a", { files: ["src/redis.ts"] });
    await ledger.publishIntent(graphId, "agent-b", { files: ["src/mcp-server.ts"] });

    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-a",
      agents: ["agent-b"],
      reason: "precautionary",
    });

    const ctx = await yieldManager.getYieldContext(graphId, "agent-a");
    const result = await shouldAutoResolve({
      yieldContext: ctx!,
      ledger,
      graphId,
      taskId: "agent-a",
      isWorktree: false,
    });

    expect(result).toBe("no-conflict");
  });

  it("returns 'proceed' when there is real file overlap and agent is in a worktree", async () => {
    await ledger.publishIntent(graphId, "agent-a", { files: ["src/shared.ts"] });
    await ledger.publishIntent(graphId, "agent-b", { files: ["src/shared.ts"] });

    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-a",
      agents: ["agent-b"],
      reason: "shared.ts overlap",
    });

    const ctx = await yieldManager.getYieldContext(graphId, "agent-a");
    const result = await shouldAutoResolve({
      yieldContext: ctx!,
      ledger,
      graphId,
      taskId: "agent-a",
      isWorktree: true,
    });

    expect(result).toBe("proceed");
  });

  it("returns 'wait' when there is real file overlap and agent is not in a worktree", async () => {
    await ledger.publishIntent(graphId, "agent-a", { files: ["src/shared.ts"] });
    await ledger.publishIntent(graphId, "agent-b", { files: ["src/shared.ts"] });

    await yieldManager.yieldTo({
      graphId,
      taskId: "agent-a",
      agents: ["agent-b"],
      reason: "shared.ts overlap",
    });

    const ctx = await yieldManager.getYieldContext(graphId, "agent-a");
    const result = await shouldAutoResolve({
      yieldContext: ctx!,
      ledger,
      graphId,
      taskId: "agent-a",
      isWorktree: false,
    });

    expect(result).toBe("wait");
  });
});

// ─── Test 6: Enrichment filtering ─────────────────────────────────────────

describe("enrichment filtering", () => {
  let ledger: WorkspaceLedger;
  let store: DiscoveryStore;
  let graphId: string;
  let savedEnrichmentEnv: string | undefined;

  beforeEach(() => {
    graphId = uniqueGraph();
    ledger = new WorkspaceLedger(redis);
    store = new DiscoveryStore(redis);
    savedEnrichmentEnv = process.env.BUREAU_DISABLE_ENRICHMENT;
    delete process.env.BUREAU_DISABLE_ENRICHMENT;
  });

  afterEach(async () => {
    // Restore env var
    if (savedEnrichmentEnv !== undefined) {
      process.env.BUREAU_DISABLE_ENRICHMENT = savedEnrichmentEnv;
    } else {
      delete process.env.BUREAU_DISABLE_ENRICHMENT;
    }
    await cleanupGraph(graphId);
  });

  it("BUREAU_DISABLE_ENRICHMENT=true returns original response unchanged even with conflicts", async () => {
    process.env.BUREAU_DISABLE_ENRICHMENT = "true";

    await ledger.publishIntent(graphId, "agent-a", { files: ["src/redis.ts"], phase: "implementing" });
    await ledger.publishIntent(graphId, "agent-b", { files: ["src/redis.ts"], phase: "implementing" });

    const result = await enrichResponse({
      toolName: "set_status",
      graphId,
      taskId: "agent-a",
      response: "Status updated.",
      ledger,
      discoveryStore: store,
    });

    expect(result).toBe("Status updated.");
    expect(result).not.toContain("Workspace");
  });

  it("BUREAU_DISABLE_ENRICHMENT=true bypasses enrichment on check_messages too", async () => {
    process.env.BUREAU_DISABLE_ENRICHMENT = "true";

    await ledger.publishIntent(graphId, "agent-a", { files: ["src/redis.ts"], role: "coder", phase: "implementing" });
    await ledger.publishIntent(graphId, "agent-b", { files: ["src/foo.ts"], role: "tester", phase: "testing" });

    const result = await enrichResponse({
      toolName: "check_messages",
      graphId,
      taskId: "agent-a",
      response: "No messages.",
      ledger,
      discoveryStore: store,
    });

    expect(result).toBe("No messages.");
  });

  it("passes through unknown tool names without enrichment", async () => {
    await ledger.publishIntent(graphId, "agent-a", { files: ["src/redis.ts"], phase: "implementing" });
    await ledger.publishIntent(graphId, "agent-b", { files: ["src/redis.ts"], phase: "implementing" });

    const result = await enrichResponse({
      toolName: "some_other_tool",
      graphId,
      taskId: "agent-a",
      response: "Tool result.",
      ledger,
      discoveryStore: store,
    });

    expect(result).toBe("Tool result.");
  });
});

// ─── Test 7: Child graph isolation ────────────────────────────────────────

describe("child graph isolation", () => {
  let ledger: WorkspaceLedger;
  let parentGraphId: string;
  let childGraphId: string;

  beforeEach(() => {
    parentGraphId = uniqueGraph();
    childGraphId = `${parentGraphId}-child`;
    ledger = new WorkspaceLedger(redis);
  });

  afterEach(async () => {
    await cleanupGraph(parentGraphId);
    await cleanupGraph(childGraphId);
  });

  it("parent graph intents are not visible in child graph's getAllIntents", async () => {
    await ledger.publishIntent(parentGraphId, "agent-parent", {
      files: ["src/parent.ts"],
      description: "parent work",
      role: "implementer",
    });
    await ledger.publishIntent(childGraphId, "agent-child", {
      files: ["src/child.ts"],
      description: "child work",
      role: "reviewer",
    });

    const parentIntents = await ledger.getAllIntents(parentGraphId);
    const childIntents = await ledger.getAllIntents(childGraphId);

    expect(parentIntents.map((i) => i.taskId)).toEqual(["agent-parent"]);
    expect(childIntents.map((i) => i.taskId)).toEqual(["agent-child"]);
  });

  it("cleaning up child graph does not remove parent graph intents", async () => {
    await ledger.publishIntent(parentGraphId, "agent-parent", { files: ["src/parent.ts"] });
    await ledger.publishIntent(childGraphId, "agent-child", { files: ["src/child.ts"] });

    await ledger.cleanupGraph(childGraphId);

    const parentIntent = await ledger.getIntent(parentGraphId, "agent-parent");
    expect(parentIntent).not.toBeNull();
  });

  it("child graph conflict detection is scoped to child graph only", async () => {
    // Parent agent working on src/shared.ts
    await ledger.publishIntent(parentGraphId, "agent-parent", {
      files: ["src/shared.ts"],
      phase: "implementing",
    });
    // Child agent also working on src/shared.ts — but in different graph
    await ledger.publishIntent(childGraphId, "agent-child", {
      files: ["src/shared.ts"],
      phase: "implementing",
    });

    // Child graph conflict detection should not see parent's intents
    const childConflicts = await ledger.detectConflicts(childGraphId, "agent-child");
    expect(childConflicts).toHaveLength(0);

    // Parent graph conflict detection should not see child's intents
    const parentConflicts = await ledger.detectConflicts(parentGraphId, "agent-parent");
    expect(parentConflicts).toHaveLength(0);
  });
});

// ─── Test 8: Workspace summary on check_messages ──────────────────────────

describe("workspace summary on check_messages", () => {
  let ledger: WorkspaceLedger;
  let store: DiscoveryStore;
  let graphId: string;

  beforeEach(() => {
    graphId = uniqueGraph();
    ledger = new WorkspaceLedger(redis);
    store = new DiscoveryStore(redis);
  });

  afterEach(async () => {
    await cleanupGraph(graphId);
  });

  it("includes [WORKSPACE] summary with one line per active agent when enriching check_messages", async () => {
    await ledger.publishIntent(graphId, "api-tools", {
      files: ["src/mcp-server.ts"],
      description: "adding list_graphs tool",
      role: "implementer",
      phase: "implementing",
    });
    await ledger.publishIntent(graphId, "redis-layer", {
      files: ["src/redis.ts"],
      description: "XRANGE wrapper",
      role: "implementer",
      phase: "implementing",
    });
    await ledger.publishIntent(graphId, "tests", {
      files: ["tests/integration.ts"],
      description: "writing e2e tests",
      role: "tester",
      phase: "testing",
    });

    const result = await enrichResponse({
      toolName: "check_messages",
      graphId,
      taskId: "api-tools",
      response: "No new messages.",
      ledger,
      discoveryStore: store,
    });

    expect(result).toContain("[WORKSPACE]");
    expect(result).toContain("3 agents");
    expect(result).toContain("api-tools");
    expect(result).toContain("redis-layer");
    expect(result).toContain("tests");
  });

  it("workspace summary line includes role, file, and phase for each agent", async () => {
    await ledger.publishIntent(graphId, "agent-a", {
      files: ["src/redis.ts"],
      description: "redis work",
      role: "coder",
      phase: "implementing",
    });

    const result = await enrichResponse({
      toolName: "check_messages",
      graphId,
      taskId: "agent-a",
      response: "No new messages.",
      ledger,
      discoveryStore: store,
    });

    expect(result).toContain("coder");
    expect(result).toContain("src/redis.ts");
    expect(result).toContain("implementing");
  });

  it("workspace summary surfaces pending discoveries on check_messages", async () => {
    await ledger.publishIntent(graphId, "agent-b", {
      files: ["src/mcp-server.ts"],
      description: "adding redis-client integration",
      role: "coder",
      phase: "implementing",
      lastDiscoveryId: "0-0",
    });

    // Post a discovery that matches agent-b's intent
    await store.postDiscovery(graphId, {
      taskId: "agent-a",
      role: "coder",
      topic: "redis-client",
      content: "poolSize must be configured before connecting",
    });

    const result = await enrichResponse({
      toolName: "check_messages",
      graphId,
      taskId: "agent-b",
      response: "No new messages.",
      ledger,
      discoveryStore: store,
    });

    expect(result).toContain("[DISCOVERY]");
    expect(result).toContain("poolSize must be configured");
  });
});
