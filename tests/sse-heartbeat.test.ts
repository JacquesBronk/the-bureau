/**
 * Tests for the SSE keep-alive heartbeat injected by startSseHeartbeat().
 *
 * Root cause: during await_graph_event's Redis XREADGROUP BLOCK (≤30 s per
 * iteration), the MCP Streamable-HTTP transport writes zero bytes to the
 * ServerResponse.  Reverse-proxies (Traefik, nginx, ALB) apply idle timeouts
 * (~60-180 s) and drop the connection.  startSseHeartbeat() writes an SSE
 * comment line (': ping\n\n') every 15 s so the connection is never idle.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  startSseHeartbeat,
  SSE_HEARTBEAT_INTERVAL_MS,
} from "../src/runtime/http-transport.js";

/** Minimal mock matching the ServerResponse subset startSseHeartbeat touches. */
function makeMockRes(overrides: Partial<{
  writableEnded: boolean;
  destroyed: boolean;
}> = {}) {
  const writes: string[] = [];
  return {
    writableEnded: overrides.writableEnded ?? false,
    destroyed: overrides.destroyed ?? false,
    write(data: string) { writes.push(data); },
    _writes: writes,
  };
}

describe("startSseHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports a positive SSE_HEARTBEAT_INTERVAL_MS constant", () => {
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    expect(typeof SSE_HEARTBEAT_INTERVAL_MS).toBe("number");
  });

  it("writes ': ping\\n\\n' at each interval tick", () => {
    vi.useFakeTimers();
    const res = makeMockRes();

    const stop = startSseHeartbeat(res, 1000);

    vi.advanceTimersByTime(999);
    expect(res._writes).toHaveLength(0); // not yet

    vi.advanceTimersByTime(1);
    expect(res._writes).toEqual([": ping\n\n"]);

    vi.advanceTimersByTime(1000);
    expect(res._writes).toEqual([": ping\n\n", ": ping\n\n"]);

    stop();
  });

  it("stops writing after the stop function is called", () => {
    vi.useFakeTimers();
    const res = makeMockRes();

    const stop = startSseHeartbeat(res, 1000);

    vi.advanceTimersByTime(1000);
    expect(res._writes).toHaveLength(1);

    stop();

    vi.advanceTimersByTime(5000);
    expect(res._writes).toHaveLength(1); // no new writes after stop
  });

  it("does not write to an already-ended response", () => {
    vi.useFakeTimers();
    const res = makeMockRes({ writableEnded: true });

    const stop = startSseHeartbeat(res, 1000);

    vi.advanceTimersByTime(3000);
    expect(res._writes).toHaveLength(0);

    stop();
  });

  it("does not write to a destroyed response", () => {
    vi.useFakeTimers();
    const res = makeMockRes({ destroyed: true });

    const stop = startSseHeartbeat(res, 1000);

    vi.advanceTimersByTime(3000);
    expect(res._writes).toHaveLength(0);

    stop();
  });

  it("stops writing once writableEnded becomes true mid-stream", () => {
    vi.useFakeTimers();
    const res = makeMockRes();

    const stop = startSseHeartbeat(res, 1000);

    vi.advanceTimersByTime(1000);
    expect(res._writes).toHaveLength(1);

    // Simulate response ending between ticks
    res.writableEnded = true;

    vi.advanceTimersByTime(2000);
    expect(res._writes).toHaveLength(1); // no new writes after end

    stop();
  });

  it("uses SSE_HEARTBEAT_INTERVAL_MS as the default interval", () => {
    vi.useFakeTimers();
    const res = makeMockRes();

    const stop = startSseHeartbeat(res);

    vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS - 1);
    expect(res._writes).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(res._writes).toHaveLength(1);

    stop();
  });
});
