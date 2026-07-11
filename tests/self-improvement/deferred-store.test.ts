import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeferredStore } from "../../src/self-improvement/deferred-store.js";
import type { AnalysisFinding } from "../../src/self-improvement/types.js";

function makeFinding(overrides: Partial<AnalysisFinding> = {}): AnalysisFinding {
  return {
    id: "finding-1",
    category: "auto-improve",
    title: "Optimize graph status output",
    description: "Verbose output wastes tokens",
    evidence: "500+ token responses observed",
    estimatedImpact: "high",
    suggestedAction: "Pre-format the response",
    ...overrides,
  };
}

function mockRedis() {
  const store: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  return {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      store[key] = value;
      return "OK";
    }),
    get: vi.fn(async (key: string) => store[key] ?? null),
    del: vi.fn(async (key: string) => {
      delete store[key];
      delete lists[key];
      return 1;
    }),
    rpush: vi.fn(async (key: string, ...values: string[]) => {
      if (!lists[key]) lists[key] = [];
      lists[key].push(...values);
      return lists[key].length;
    }),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      return (lists[key] ?? []).slice(start, stop === -1 ? undefined : stop + 1);
    }),
    expire: vi.fn(async () => 1),
    scan: vi.fn(async (cursor: string, _match: string, pattern: string) => {
      const prefix = pattern.replace("*", "");
      const keys = Object.keys(lists).filter((k) => k.startsWith(prefix));
      return ["0", keys];
    }),
    _store: store,
    _lists: lists,
  };
}

describe("DeferredStore", () => {
  let redis: ReturnType<typeof mockRedis>;
  let deferredStore: DeferredStore;

  beforeEach(() => {
    redis = mockRedis();
    deferredStore = new DeferredStore(redis as any, 7);
  });

  it("saves deferred findings with TTL", async () => {
    const findings = [makeFinding({ id: "f1" }), makeFinding({ id: "f2" })];
    await deferredStore.save("session-123", findings);
    expect(redis.rpush).toHaveBeenCalled();
    expect(redis.expire).toHaveBeenCalledWith(
      expect.stringContaining("self-improvement:deferred:session-123"),
      7 * 86400,
    );
  });

  it("loads deferred findings for a session", async () => {
    const findings = [makeFinding({ id: "f1" })];
    await deferredStore.save("session-123", findings);
    const loaded = await deferredStore.load("session-123");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("f1");
  });

  it("returns empty array for no deferred work", async () => {
    const loaded = await deferredStore.load("nonexistent");
    expect(loaded).toHaveLength(0);
  });

  it("lists all sessions with deferred work", async () => {
    await deferredStore.save("session-a", [makeFinding()]);
    await deferredStore.save("session-b", [makeFinding()]);
    const sessions = await deferredStore.listSessions();
    expect(sessions).toContain("session-a");
    expect(sessions).toContain("session-b");
  });

  it("uses SCAN not KEYS to list sessions", async () => {
    await deferredStore.save("session-x", [makeFinding()]);
    await deferredStore.listSessions();
    expect(redis.scan).toHaveBeenCalled();
  });

  it("collects sessions across multiple SCAN pages", async () => {
    // Simulate two-page scan: first call returns cursor "42" with one key,
    // second call returns cursor "0" with another key.
    redis.scan
      .mockResolvedValueOnce(["42", ["self-improvement:deferred:page1-session"]])
      .mockResolvedValueOnce(["0", ["self-improvement:deferred:page2-session"]]);
    const sessions = await deferredStore.listSessions();
    expect(sessions).toEqual(["page1-session", "page2-session"]);
    expect(redis.scan).toHaveBeenCalledTimes(2);
  });

  it("dismisses deferred work for a session", async () => {
    await deferredStore.save("session-123", [makeFinding()]);
    await deferredStore.dismiss("session-123");
    expect(redis.del).toHaveBeenCalledWith(
      expect.stringContaining("self-improvement:deferred:session-123"),
    );
  });
});
