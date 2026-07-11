/**
 * Projection tests for the list_peers handler (additive guard + new fields).
 *
 * Uses a fake registry (duck-typed) to control PeerInfo without Redis.
 */

import { describe, it, expect } from "vitest";
import { registerListPeers } from "../tools/list-peers.js";
import type { PeerInfo } from "../types/peer.js";

// Captures the handler registered by registerListPeers using a fake MCP server.
function captureHandler(
  register: (server: any) => void,
): (...args: any[]) => Promise<any> {
  let captured: ((...args: any[]) => Promise<any>) | undefined;
  const fakeServer: any = {
    registerTool: (
      _name: string,
      _cfg: unknown,
      handler: (...args: any[]) => Promise<any>,
    ) => {
      captured = handler;
    },
  };
  register(fakeServer);
  if (!captured) throw new Error("Handler not captured — registerTool was not called");
  return captured;
}

function makeRegistry(peers: PeerInfo[]) {
  return { listPeers: async () => peers };
}

function makeBasePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    id: "test-session-id",
    role: "coder",
    host: "localhost",
    cwd: "/workspace",
    project: "test-project",
    pid: process.pid,
    spawnedBy: null,
    phase: "implementing",
    description: "test peer",
    startedAt: Date.now(),
    lastActivity: Date.now(),
    ...overrides,
  };
}

describe("list_peers projection", () => {
  it("includes graphId and logFile when present on PeerInfo", async () => {
    const peer = makeBasePeer({
      graphId: "graph-abc-123",
      logFile: "/tmp/agent-abc.log",
    });
    const handler = captureHandler((s) =>
      registerListPeers(s, makeRegistry([peer]) as any),
    );
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text) as any[];

    expect(parsed.length).toBe(1);
    expect(parsed[0].graphId).toBe("graph-abc-123");
    expect(parsed[0].logFile).toBe("/tmp/agent-abc.log");
  });

  it("sets graphId and logFile to null when absent on PeerInfo", async () => {
    const peer = makeBasePeer(); // no graphId, no logFile
    const handler = captureHandler((s) =>
      registerListPeers(s, makeRegistry([peer]) as any),
    );
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text) as any[];

    expect(parsed.length).toBe(1);
    expect(parsed[0].graphId).toBeNull();
    expect(parsed[0].logFile).toBeNull();
  });

  it("sets logFile to k8s placeholder string (not null) when logFile is k8s://", async () => {
    const peer = makeBasePeer({
      logFile: "k8s://namespace/pod-name",
    });
    const handler = captureHandler((s) =>
      registerListPeers(s, makeRegistry([peer]) as any),
    );
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text) as any[];

    expect(parsed[0].logFile).toBe("k8s://namespace/pod-name");
  });

  it("preserves all pre-existing PeerSummary fields (additive guard)", async () => {
    const peer = makeBasePeer({
      branch: "feature/foo",
      taskId: "task-xyz",
      graphId: "g1",
      logFile: "/tmp/log",
    });
    const handler = captureHandler((s) =>
      registerListPeers(s, makeRegistry([peer]) as any),
    );
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text) as any[];
    const p = parsed[0];

    // All pre-existing fields must still be present with correct types
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

    // New fields also present
    expect(typeof p.graphId).toBe("string");
    expect(typeof p.logFile).toBe("string");
  });
});
