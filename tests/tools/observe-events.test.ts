import { describe, it, expect, vi } from "vitest";
import { registerObserveEvents, compareStreamIds } from "../../src/tools/observe-events.js";

/** Capture the handler registerInstrumentedTool would wire up. */
function fakeServer() {
  const reg: { name?: string; handler?: Function } = {};
  const server = { registerTool: (name: string, _cfg: any, handler: Function) => { reg.name = name; reg.handler = handler; } } as any;
  return { server, reg };
}
const ctx = () => ({ sessionId: "s1" });
const parseEnvelope = (r: any) => JSON.parse(r.content[0].text);

describe("observe_events", () => {
  // --- Task 1: skeleton ---

  it("registers and returns an empty envelope for an empty stream snapshot", async () => {
    const { server, reg } = fakeServer();
    const redis = { xrange: vi.fn().mockResolvedValue([]), xrevrange: vi.fn().mockResolvedValue([]) } as any;
    registerObserveEvents(server, () => redis, redis, ctx as any);
    expect(reg.name).toBe("observe_events");
    const res = await reg.handler!({ projects: "p", timeoutSeconds: 0 }, {});
    const env = parseEnvelope(res);
    // Empty SNAPSHOT (timeoutSeconds 0) → timedOut false (snapshots never time out).
    expect(env).toEqual({ events: [], cursor: "0-0", gapDetected: false, timedOut: false });
  });

  // --- Task 2: snapshot read ---

  it("snapshot: enriches events with streamId+project, advances cursor, excludes the cursor entry", async () => {
    const entries = [
      ["5-0", ["type", "task_started", "graphId", "G", "timestamp", "5"]],
      ["6-0", ["type", "task_completed", "graphId", "G", "timestamp", "6"]],
    ];
    // cursor "4-0" is explicit → detectGap probes earliest FIRST, then the snapshot reads.
    const xrange = vi.fn()
      .mockResolvedValueOnce([["4-0", []]]) // detectGap: earliest survivor == cursor → no gap
      .mockResolvedValueOnce(entries);      // snapshot read
    const redis = { xrange, xrevrange: vi.fn().mockResolvedValue([["6-0", []]]) } as any;
    const { server, reg } = fakeServer();
    registerObserveEvents(server, () => redis, redis, (() => ({ sessionId: "s1" })) as any);
    const res = await reg.handler!({ projects: "p", cursor: "4-0", timeoutSeconds: 0, maxEvents: 100 }, {});
    const env = parseEnvelope(res);
    expect(env.events.map((e: any) => e.streamId)).toEqual(["5-0", "6-0"]);
    expect(env.events[0].project).toBe("p");
    expect(env.cursor).toBe("6-0");
    expect(env.timedOut).toBe(false);
    expect(env.gapDetected).toBe(false);
    expect(xrange).toHaveBeenNthCalledWith(1, "events:p", "-", "+", "COUNT", 1);       // detectGap probe
    expect(xrange).toHaveBeenNthCalledWith(2, "events:p", "(4-0", "+", "COUNT", 100);  // exclusive snapshot read
  });

  // --- Task 3: blocking read ---

  it("blocking: multi-project XREAD with all keys then all ids; disconnects on abort", async () => {
    const xreadResult = [
      ["events:a", [["10-0", ["type", "task_started", "graphId", "GA", "timestamp", "10"]]]],
      ["events:b", [["11-0", ["type", "task_completed", "graphId", "GB", "timestamp", "11"]]]],
    ];
    const blocking = { xread: vi.fn().mockResolvedValue(xreadResult), disconnect: vi.fn(), quit: vi.fn() } as any;
    const redis = { xrevrange: vi.fn().mockResolvedValue([]), xrange: vi.fn().mockResolvedValue([]) } as any;
    const { server, reg } = fakeServer();
    registerObserveEvents(server, () => blocking, redis, (() => ({ sessionId: "s1" })) as any);
    const res = await reg.handler!({ projects: ["a", "b"], timeoutSeconds: 30, maxEvents: 50 }, {});
    const env = parseEnvelope(res);
    expect(blocking.xread).toHaveBeenCalledWith("COUNT", 50, "BLOCK", 30000, "STREAMS", "events:a", "events:b", expect.any(String), expect.any(String));
    expect(env.events.map((e: any) => `${e.project}:${e.streamId}`)).toEqual(["a:10-0", "b:11-0"]);
    expect(env.cursor).toEqual({ "events:a": "10-0", "events:b": "11-0" });
  });

  it("caps each XREAD BLOCK at OBSERVE_EVENTS_MAX_BLOCK_MS (env), smaller of env-cap and requested", async () => {
    const prev = process.env.OBSERVE_EVENTS_MAX_BLOCK_MS;
    process.env.OBSERVE_EVENTS_MAX_BLOCK_MS = "5000";
    try {
      // returns on the first iteration so the loop exits immediately (no real-time wait)
      const xread = vi.fn().mockResolvedValue([["events:p", [["1-0", ["type", "x", "graphId", "G", "timestamp", "1"]]]]]);
      const blocking = { xread, disconnect: vi.fn(), quit: vi.fn() } as any;
      const redis = { xrevrange: vi.fn().mockResolvedValue([]), xrange: vi.fn().mockResolvedValue([]) } as any;
      const { server, reg } = fakeServer();
      registerObserveEvents(server, () => blocking, redis, (() => ({ sessionId: "s1" })) as any);
      await reg.handler!({ projects: "p", timeoutSeconds: 30 }, {}); // 30s requested, 5s env cap wins per iteration
      expect(xread).toHaveBeenCalledWith("COUNT", 100, "BLOCK", 5000, "STREAMS", "events:p", expect.any(String));
    } finally {
      if (prev === undefined) delete process.env.OBSERVE_EVENTS_MAX_BLOCK_MS;
      else process.env.OBSERVE_EVENTS_MAX_BLOCK_MS = prev;
    }
  });

  // --- Task 4: graphId filter + gap detection + cursor-omitted seeding ---

  it("filters to graphId in memory (non-destructive), keeps others out", async () => {
    const entries = [
      ["7-0", ["type", "task_started", "graphId", "G1", "timestamp", "7"]],
      ["8-0", ["type", "task_started", "graphId", "G2", "timestamp", "8"]],
    ];
    const redis = { xrange: vi.fn().mockResolvedValue(entries), xrevrange: vi.fn().mockResolvedValue([]) } as any;
    const { server, reg } = fakeServer();
    registerObserveEvents(server, () => redis, redis, (() => ({ sessionId: "s1" })) as any);
    const env = parseEnvelope(await reg.handler!({ projects: "p", cursor: "0", timeoutSeconds: 0, graphId: "G2" }, {}));
    expect(env.events.map((e: any) => e.graphId)).toEqual(["G2"]);
  });

  it("gapDetected=true when cursor precedes the earliest surviving entry", async () => {
    // requested cursor 2-0, but earliest surviving is 5-0 → gap
    const redis = {
      xrange: vi.fn()
        .mockResolvedValueOnce([["5-0", []]])                                   // detectGap: earliest = 5-0
        .mockResolvedValueOnce([["5-0", ["type", "x", "graphId", "G", "timestamp", "5"]]]), // snapshot read
      xrevrange: vi.fn().mockResolvedValue([]),
    } as any;
    const { server, reg } = fakeServer();
    registerObserveEvents(server, () => redis, redis, (() => ({ sessionId: "s1" })) as any);
    const env = parseEnvelope(await reg.handler!({ projects: "p", cursor: "2-0", timeoutSeconds: 0 }, {}));
    expect(env.gapDetected).toBe(true);
  });

  it("cursor omitted → seeds each stream to its head via xrevrange (tail only)", async () => {
    const xrevrange = vi.fn().mockResolvedValue([["99-0", []]]);
    const redis = { xrange: vi.fn().mockResolvedValue([]), xrevrange } as any;
    const { server, reg } = fakeServer();
    registerObserveEvents(server, () => redis, redis, (() => ({ sessionId: "s1" })) as any);
    const env = parseEnvelope(await reg.handler!({ projects: "p", timeoutSeconds: 0 }, {}));
    expect(xrevrange).toHaveBeenCalledWith("events:p", "+", "-", "COUNT", 1);
    expect(env.cursor).toBe("99-0"); // no new events past head → cursor unchanged at head
  });

  it("multi-project: a cursor-map MISSING a stream key seeds that stream to its head, not history", async () => {
    const xrevrange = vi.fn().mockResolvedValue([["50-0", []]]); // events:b head
    const redis = { xrange: vi.fn().mockResolvedValue([]), xrevrange } as any;
    const { server, reg } = fakeServer();
    registerObserveEvents(server, () => redis, redis, (() => ({ sessionId: "s1" })) as any);
    // cursor provided for events:a only; events:b omitted → programmatically seeded to head
    const env = parseEnvelope(await reg.handler!({ projects: ["a", "b"], cursor: { "events:a": "3-0" }, timeoutSeconds: 0 }, {}));
    expect(xrevrange).toHaveBeenCalledWith("events:b", "+", "-", "COUNT", 1); // seeded events:b to head
    expect(xrevrange).not.toHaveBeenCalledWith("events:a", "+", "-", "COUNT", 1); // events:a used its provided cursor
    expect(env.cursor).toEqual({ "events:a": "3-0", "events:b": "50-0" });
  });

  it("compareStreamIds orders by ms then seq", () => {
    expect(compareStreamIds("5-0", "5-1")).toBeLessThan(0);
    expect(compareStreamIds("6-0", "5-9")).toBeGreaterThan(0);
    expect(compareStreamIds("5-2", "5-2")).toBe(0);
  });

  // --- Task 5: read-only safety guard ---

  it("SAFETY: completes using only xread/xrange — group methods throw if touched", async () => {
    const boom = () => { throw new Error("consumer-group call is forbidden in observe_events"); };
    const redis = {
      xrange: vi.fn().mockResolvedValue([["1-0", ["type", "x", "graphId", "G", "timestamp", "1"]]]),
      xrevrange: vi.fn().mockResolvedValue([]),
      xgroup: boom, xreadgroup: boom, xack: boom,
    } as any;
    const blocking = { xread: vi.fn().mockResolvedValue(null), disconnect: vi.fn(), quit: vi.fn(), xgroup: boom, xreadgroup: boom, xack: boom } as any;
    const { server, reg } = fakeServer();
    registerObserveEvents(server, () => blocking, redis, (() => ({ sessionId: "s1" })) as any);
    // snapshot (uses redis.xrange) and blocking (uses blocking.xread) — neither may touch group methods
    await expect(reg.handler!({ projects: "p", cursor: "0", timeoutSeconds: 0 }, {})).resolves.toBeDefined();
    await expect(reg.handler!({ projects: "p", timeoutSeconds: 5 }, {})).resolves.toBeDefined();
  });
});
