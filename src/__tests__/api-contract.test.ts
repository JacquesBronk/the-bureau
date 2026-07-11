/**
 * Wire-shape contract tests for read-surface MCP tools (issue #263).
 *
 * For each tool: seed Redis state, invoke the handler, parse output with
 * parseToolOutput, and structurally assert that required fields are present
 * with the correct types.  A test fails if the tool's emitted JSON stops
 * matching its published *Output type from src/types/api.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRedisClient } from "../redis.js";
import type { RedisClient } from "../redis.js";
import { PeerRegistry } from "../registry.js";
import { ProcessMonitor } from "../process-monitor.js";
import { TaskGraphManager } from "../task-graph.js";
import { WorkspaceLedger } from "../workspace/ledger.js";
import { FileLockManager } from "../file-locks.js";
import { GraphRegistry } from "../workspace/graph-registry.js";

import { registerBureauHealth } from "../tools/bureau-health.js";
import { registerCheckHealth } from "../tools/check-health.js";
import { registerGetVersion } from "../tools/get-version.js";
import { registerListPeers } from "../tools/list-peers.js";
import { registerListTemplates } from "../tools/list-templates.js";
import { registerGetWorkspaceState } from "../tools/get-workspace-state.js";
import { registerMonitorGraph } from "../tools/monitor-graph.js";
import { registerGetTaskGraph } from "../tools/get-task-graph.js";
import { registerListGraphs } from "../tools/cleanup.js";

import { parseToolOutput } from "../types/parse-tool-output.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Capture the handler registered by each tool's register function.
function captureHandler(register: (server: any) => void): (...args: any[]) => Promise<any> {
  let captured: ((...args: any[]) => Promise<any>) | undefined;
  const fakeServer: any = {
    registerTool: (_name: string, _cfg: unknown, handler: (...args: any[]) => Promise<any>) => {
      captured = handler;
    },
  };
  register(fakeServer);
  if (!captured) throw new Error("Handler not captured — registerTool was not called");
  return captured;
}

// Get the text content from a tool result.
function getText(result: any): string {
  return result.content[0].text as string;
}

describe("api-contract: read-surface tool wire shapes", () => {
  let redis: RedisClient;

  beforeEach(async () => {
    redis = createRedisClient(REDIS_URL);
    await redis.flushdb();
  });

  afterEach(async () => {
    await redis.quit();
  });

  // ── bureau_health ─────────────────────────────────────────────────────────

  it("bureau_health emits BureauHealthOutput", async () => {
    const selfPeer = makePeer("test-engine");
    const registry = new PeerRegistry(redis as any, selfPeer);
    const handler = captureHandler((s) => registerBureauHealth(s, registry, redis as any));

    const result = await handler({});
    const parsed = parseToolOutput(getText(result)) as any;

    expect(typeof parsed.version).toBe("string");
    expect(typeof parsed.uptime).toBe("number");
    expect(typeof parsed.memory).toBe("object");
    expect(typeof parsed.memory.rss).toBe("number");
    expect(typeof parsed.memory.heapUsed).toBe("number");
    expect(typeof parsed.activePeers).toBe("number");
    expect(typeof parsed.activeGraphs).toBe("number");
    expect(typeof parsed.redis).toBe("object");
    // pingMs is number or null
    expect(parsed.redis.pingMs === null || typeof parsed.redis.pingMs === "number").toBe(true);
  });

  // ── check_health (peers-exist branch) ─────────────────────────────────────

  it("check_health emits CheckHealthOutput when peers exist", async () => {
    const selfPeer = makePeer("test-health-peer");
    const registry = new PeerRegistry(redis as any, selfPeer);
    await registry.register();

    const processMonitor = new ProcessMonitor({ onCompleted: async () => {}, onFailed: async () => {} });
    const handler = captureHandler((s) =>
      registerCheckHealth(s, registry, processMonitor, redis as any),
    );

    const result = await handler({});
    const parsed = parseToolOutput(getText(result)) as any;

    expect(typeof parsed.redis).toBe("object");
    expect(typeof parsed.redis.connected).toBe("boolean");
    expect(typeof parsed.system).toBe("object");
    expect(typeof parsed.system.freeMemGB).toBe("number");
    expect(typeof parsed.system.totalMemGB).toBe("number");
    expect(typeof parsed.system.usagePercent).toBe("number");
    expect(Array.isArray(parsed.system.loadAvg)).toBe(true);
    expect(Array.isArray(parsed.peers)).toBe(true);
    expect(parsed.peers.length).toBeGreaterThan(0);

    const peer = parsed.peers[0];
    expect(typeof peer.id).toBe("string");
    expect(typeof peer.role).toBe("string");
    expect(typeof peer.phase).toBe("string");
    expect(typeof peer.description).toBe("string");
    expect(typeof peer.pid).toBe("number");
    expect(typeof peer.isAlive).toBe("boolean");
    expect(typeof peer.idleSeconds).toBe("number");
    expect(typeof peer.project).toBe("string");
    expect(peer.branch === null || typeof peer.branch === "string").toBe(true);
    expect(peer.logFile === null || typeof peer.logFile === "string").toBe(true);
    expect(peer.taskId === null || typeof peer.taskId === "string").toBe(true);
  });

  // ── check_health (zero-peers branch) ──────────────────────────────────────

  it("check_health returns plain text when no peers registered", async () => {
    const selfPeer = makePeer("test-empty-health");
    const registry = new PeerRegistry(redis as any, selfPeer);
    const processMonitor = new ProcessMonitor({ onCompleted: async () => {}, onFailed: async () => {} });
    const handler = captureHandler((s) =>
      registerCheckHealth(s, registry, processMonitor, redis as any),
    );

    const result = await handler({});
    const parsed = parseToolOutput(getText(result));
    expect(typeof parsed).toBe("string");
  });

  // ── get_version ───────────────────────────────────────────────────────────

  it("get_version emits GetVersionOutput after `---`", async () => {
    const handler = captureHandler((s) => registerGetVersion(s, redis as any));
    const result = await handler({});
    const parsed = parseToolOutput(getText(result)) as any;

    expect(typeof parsed.name).toBe("string");
    expect(typeof parsed.version).toBe("string");
    expect(typeof parsed.node).toBe("string");
    expect(typeof parsed.redis).toBe("string");
    expect(typeof parsed.pid).toBe("number");
    expect(typeof parsed.uptime).toBe("number");
    expect(typeof parsed.platform).toBe("string");
    expect(typeof parsed.cwd).toBe("string");
    expect(typeof parsed.otel).toBe("object");
    expect(typeof parsed.otel.enabled).toBe("boolean");
    expect(typeof parsed.otel.hasMeter).toBe("boolean");
    expect(typeof parsed.otel.protocol).toBe("string");
    expect(typeof parsed.otel.endpoint).toBe("string");
  });

  // ── list_peers ────────────────────────────────────────────────────────────

  it("list_peers emits ListPeersOutput (array of PeerSummary)", async () => {
    const selfPeer = makePeer("test-list-peer");
    const registry = new PeerRegistry(redis as any, selfPeer);
    await registry.register();

    const handler = captureHandler((s) => registerListPeers(s, registry));
    const result = await handler({});
    const parsed = parseToolOutput(getText(result)) as any;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    const p = parsed[0];
    expect(typeof p.id).toBe("string");
    expect(typeof p.role).toBe("string");
    expect(typeof p.host).toBe("string");
    expect(typeof p.cwd).toBe("string");
    expect(typeof p.project).toBe("string");
    expect(typeof p.phase).toBe("string");
    expect(typeof p.description).toBe("string");
    expect(typeof p.spawnedBy).toBe("string");
    expect(p.branch === null || typeof p.branch === "string").toBe(true);
    expect(p.taskId === null || typeof p.taskId === "string").toBe(true);
    expect(typeof p.idleSeconds).toBe("number");
    expect(typeof p.isAlive).toBe("boolean");
    expect(p.graphId === null || typeof p.graphId === "string").toBe(true);
    expect(p.logFile === null || typeof p.logFile === "string").toBe(true);
  });

  // ── list_templates ────────────────────────────────────────────────────────

  it("list_templates emits ListTemplatesOutput (array of TemplateSummary)", async () => {
    const handler = captureHandler((s) => registerListTemplates(s));
    const result = await handler({});
    const parsed = parseToolOutput(getText(result)) as any;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    const t = parsed[0];
    expect(typeof t.id).toBe("string");
    expect(typeof t.name).toBe("string");
    expect(typeof t.description).toBe("string");
    expect(typeof t.whenToUse).toBe("string");
    expect(Array.isArray(t.aliases)).toBe(true);
    expect(typeof t.parameters).toBe("object");
    expect(typeof t.taskCount).toBe("number");
  });

  // ── get_workspace_state ───────────────────────────────────────────────────

  it("get_workspace_state emits GetWorkspaceStateOutput", async () => {
    const ledger = new WorkspaceLedger(redis as any);
    const fileLockManager = new FileLockManager(redis as any);
    const graphRegistry = new GraphRegistry(redis as any);

    const handler = captureHandler((s) =>
      registerGetWorkspaceState(s, ledger, fileLockManager, graphRegistry),
    );
    const result = await handler({ project: "test-project" });
    const parsed = parseToolOutput(getText(result)) as any;

    expect(Array.isArray(parsed.intents)).toBe(true);
    expect(Array.isArray(parsed.conflicts)).toBe(true);
    expect(Array.isArray(parsed.locks)).toBe(true);
    expect(Array.isArray(parsed.activeGraphs)).toBe(true);
  });

  // ── monitor_graph (dashboard) ─────────────────────────────────────────────

  it("monitor_graph dashboard emits MonitorGraphDashboardOutput after `---`", async () => {
    const mgr = makeGraphManager(redis);
    const { graphId } = await mgr.declareGraph("test-proj", "/tmp", [
      { id: "task-a", role: "coder", task: "do something" },
    ]);

    const handler = captureHandler((s) => registerMonitorGraph(s, mgr, redis as any));
    const result = await handler({ graphId, format: "dashboard" });
    const parsed = parseToolOutput(getText(result)) as any;

    expect(typeof parsed.graphId).toBe("string");
    expect(typeof parsed.project).toBe("string");
    expect(typeof parsed.status).toBe("string");
    expect(typeof parsed.completed).toBe("number");
    expect(typeof parsed.running).toBe("number");
    expect(typeof parsed.pending).toBe("number");
    expect(typeof parsed.failed).toBe("number");
    expect(typeof parsed.total).toBe("number");
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(Array.isArray(parsed.recentEvents)).toBe(true);

    const task = parsed.tasks[0];
    expect(typeof task.id).toBe("string");
    expect(typeof task.role).toBe("string");
    expect(typeof task.status).toBe("string");
    expect(task.startedAt === null || typeof task.startedAt === "number").toBe(true);
    expect(task.completedAt === null || typeof task.completedAt === "number").toBe(true);
    expect(Array.isArray(task.dependsOn)).toBe(true);
    expect(task.sessionId === null || typeof task.sessionId === "string").toBe(true);
  });

  // ── monitor_graph (compact) ───────────────────────────────────────────────

  it("monitor_graph compact emits MonitorGraphCompactOutput after `---`", async () => {
    const mgr = makeGraphManager(redis);
    const { graphId } = await mgr.declareGraph("test-proj", "/tmp", [
      { id: "task-b", role: "coder", task: "do something else" },
    ]);

    const handler = captureHandler((s) => registerMonitorGraph(s, mgr, redis as any));
    const result = await handler({ graphId, format: "compact" });
    const parsed = parseToolOutput(getText(result)) as any;

    expect(typeof parsed.graphId).toBe("string");
    expect(typeof parsed.project).toBe("string");
    expect(typeof parsed.status).toBe("string");
    expect(typeof parsed.total).toBe("number");
    expect(Array.isArray(parsed.tasks)).toBe(true);
    // compact tasks only have id, role, status
    const task = parsed.tasks[0];
    expect(typeof task.id).toBe("string");
    expect(typeof task.role).toBe("string");
    expect(typeof task.status).toBe("string");
  });

  // ── get_task_graph ────────────────────────────────────────────────────────

  it("get_task_graph emits TaskGraphTaskSummary[] in Detailed: block", async () => {
    const mgr = makeGraphManager(redis);
    const { graphId } = await mgr.declareGraph("test-proj", "/tmp", [
      { id: "task-c", role: "coder", task: "implement feature" },
    ]);

    const handler = captureHandler((s) => registerGetTaskGraph(s, mgr, redis as any));
    const result = await handler({ graphId });
    const parsed = parseToolOutput(getText(result)) as any;

    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed.detailed)).toBe(true);
    expect(parsed.detailed.length).toBeGreaterThan(0);

    const task = parsed.detailed[0];
    expect(typeof task.id).toBe("string");
    expect(typeof task.role).toBe("string");
    expect(typeof task.status).toBe("string");
    expect(Array.isArray(task.dependsOn)).toBe(true);
    expect(task.sessionId === null || typeof task.sessionId === "string").toBe(true);
    expect(task.exitCode === null || typeof task.exitCode === "number").toBe(true);
    expect(typeof task.retries).toBe("number");

    // graph meta is undefined when no orchestration fields are set
    expect(parsed.graph === undefined || typeof parsed.graph === "object").toBe(true);
  });

  it("get_task_graph emits a Graph: block (TaskGraphMeta) when orchestration fields are set", async () => {
    const mgr = makeGraphManager(redis);
    const { graphId } = await mgr.declareGraph("test-proj", "/tmp", [
      { id: "task-c2", role: "coder", task: "implement feature" },
    ]);
    // Seed an orchestration field so the handler emits the optional `Graph:` block —
    // this exercises parseToolOutput's labelled two-block (Detailed: + Graph:) path.
    await redis.set(`graph:${graphId}:orchestrator`, "orchestrator-session-xyz");

    const handler = captureHandler((s) => registerGetTaskGraph(s, mgr, redis as any));
    const result = await handler({ graphId });
    const parsed = parseToolOutput(getText(result)) as any;

    // Both blocks parsed out of the single text payload.
    expect(Array.isArray(parsed.detailed)).toBe(true);
    expect(parsed.detailed.length).toBeGreaterThan(0);
    expect(typeof parsed.graph).toBe("object");
    expect(parsed.graph).not.toBeNull();
    expect(parsed.graph.orchestrator).toBe("orchestrator-session-xyz");
  });

  // ── list_graphs ───────────────────────────────────────────────────────────

  it("list_graphs emits ListGraphsOutput (bare array of GraphListItem)", async () => {
    // Seed a graph record directly (simulates a declared graph)
    const mgr = makeGraphManager(redis);
    await mgr.declareGraph("test-proj", "/tmp", [
      { id: "task-d", role: "coder", task: "build thing" },
    ]);

    const handler = captureHandler((s) => registerListGraphs(s, redis as any));
    const result = await handler({});
    const parsed = parseToolOutput(getText(result)) as any;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    const g = parsed[0];
    expect(typeof g.graphId).toBe("string");
    expect(g.project === null || typeof g.project === "string").toBe(true);
    expect(g.status === null || typeof g.status === "string").toBe(true);
    // taskCount: number or null (null only when graph record is unreadable)
    expect(g.taskCount === null || typeof g.taskCount === "number").toBe(true);
    expect(g.createdAt === null || typeof g.createdAt === "number").toBe(true);
    expect(g.age === null || typeof g.age === "number").toBe(true);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePeer(id: string) {
  return {
    id,
    role: "test-agent",
    host: "localhost",
    cwd: "/tmp",
    project: "test-project",
    pid: process.pid,
    spawnedBy: null as null,
    phase: "implementing" as const,
    description: "contract test peer",
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function makeGraphManager(redis: RedisClient): TaskGraphManager {
  return new TaskGraphManager(
    redis as any,
    { onDispatch: async () => {}, onEvent: async () => {} },
    "test-session",
  );
}
