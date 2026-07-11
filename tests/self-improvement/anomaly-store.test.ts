import { describe, it, expect, beforeEach, vi } from "vitest";
import { AnomalyStore } from "../../src/self-improvement/anomaly-store.js";
import type { AnomalyRecord } from "../../src/self-improvement/types.js";

function makeRecord(overrides: Partial<AnomalyRecord> = {}): AnomalyRecord {
  return {
    id: "test-id-1",
    type: "dead_pid",
    severity: "high",
    timestamp: Date.now(),
    sessionId: "session-123",
    graphId: "graph-456",
    context: { pid: 12345, exitCode: 1 },
    ...overrides,
  };
}

// Mock Redis client
function mockRedis() {
  const store: Record<string, string[]> = {};
  return {
    rpush: vi.fn(async (key: string, ...values: string[]) => {
      if (!store[key]) store[key] = [];
      store[key].push(...values);
      return store[key].length;
    }),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      return (store[key] ?? []).slice(start, stop === -1 ? undefined : stop + 1);
    }),
    del: vi.fn(async (key: string) => {
      delete store[key];
      return 1;
    }),
    expire: vi.fn(async () => 1),
    llen: vi.fn(async (key: string) => (store[key] ?? []).length),
    _store: store,
  };
}

describe("AnomalyStore", () => {
  let redis: ReturnType<typeof mockRedis>;
  let store: AnomalyStore;

  beforeEach(() => {
    redis = mockRedis();
    store = new AnomalyStore(redis as any);
  });

  it("records an anomaly and sets TTL", async () => {
    const record = makeRecord();
    await store.record("session-123", record);

    expect(redis.rpush).toHaveBeenCalledWith(
      "anomalies:session-123",
      JSON.stringify(record),
    );
    expect(redis.expire).toHaveBeenCalledWith("anomalies:session-123", 86400);
  });

  it("lists all anomalies for a session", async () => {
    const r1 = makeRecord({ id: "id-1", type: "dead_pid" });
    const r2 = makeRecord({ id: "id-2", type: "stuck_agent" });
    await store.record("session-123", r1);
    await store.record("session-123", r2);

    const results = await store.list("session-123");
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("id-1");
    expect(results[1].id).toBe("id-2");
  });

  it("returns empty array for unknown session", async () => {
    const results = await store.list("unknown");
    expect(results).toHaveLength(0);
  });

  it("clears anomalies for a session", async () => {
    await store.record("session-123", makeRecord());
    await store.clear("session-123");
    expect(redis.del).toHaveBeenCalledWith("anomalies:session-123");
  });

  it("counts anomalies for a session", async () => {
    await store.record("session-123", makeRecord({ id: "a" }));
    await store.record("session-123", makeRecord({ id: "b" }));
    const count = await store.count("session-123");
    expect(count).toBe(2);
  });
});
