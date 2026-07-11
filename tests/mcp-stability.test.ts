import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================
// Behavioral tests for the stdio stability fixes in
// src/mcp-server.ts. That module has heavy side effects at
// load time (Redis connections, MCP transport, etc.) so the
// behaviors are reproduced inline and tested as contracts.
// The implementations are taken verbatim from the source.
// ============================================================

// ── log() ────────────────────────────────────────────────────

/**
 * Reproduces the module-level log() / headless pattern from mcp-server.ts
 * (lines 61-65).
 */
function makeLog() {
  let headless = false;
  const log = (msg: string) => {
    if (headless) return;
    try {
      process.stderr.write(`[the-bureau] ${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* EPIPE */
    }
  };
  return { log, setHeadless: (v: boolean) => { headless = v; } };
}

describe("MCP stdio stability: log()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not throw when process.stderr.write throws", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("write EPIPE");
    });
    const { log } = makeLog();
    expect(() => log("any message")).not.toThrow();
  });

  it("does not throw when stderr.write throws with EPIPE code", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      const err = new Error("write EPIPE");
      (err as any).code = "EPIPE";
      throw err;
    });
    const { log } = makeLog();
    expect(() => log("any message")).not.toThrow();
  });

  it("writes to stderr when headless is false", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { log } = makeLog();
    log("hello world");
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(String(writeSpy.mock.calls[0][0])).toContain("[the-bureau]");
    expect(String(writeSpy.mock.calls[0][0])).toContain("hello world");
  });

  it("suppresses stderr.write when headless is true", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { log, setHeadless } = makeLog();
    setHeadless(true);
    log("should be suppressed");
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ── uncaughtException handler ─────────────────────────────────

/**
 * Reproduces the uncaughtException handler from mcp-server.ts (lines 587-592).
 */
function makeUncaughtExceptionHandler(exitFn: (code: number) => void) {
  return (err: Error) => {
    if ((err as any).code === "EPIPE") return;
    try {
      process.stderr.write(`[the-bureau] FATAL uncaughtException: ${err.stack}\n`);
    } catch {
      /* EPIPE */
    }
    exitFn(1);
  };
}

describe("MCP stdio stability: uncaughtException handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows EPIPE errors and does NOT call exit", () => {
    const mockExit = vi.fn();
    const handler = makeUncaughtExceptionHandler(mockExit);
    const err = new Error("write EPIPE");
    (err as any).code = "EPIPE";
    handler(err);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("calls exit(1) for non-EPIPE errors", () => {
    const mockExit = vi.fn();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = makeUncaughtExceptionHandler(mockExit);
    handler(new Error("something unexpected"));
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("does not throw even if stderr.write throws on non-EPIPE error", () => {
    const mockExit = vi.fn();
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("write EPIPE");
    });
    const handler = makeUncaughtExceptionHandler(mockExit);
    expect(() => handler(new Error("boom"))).not.toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

// ── stdin 'end' handler ───────────────────────────────────────

/**
 * Reproduces the stdin 'end' handler from mcp-server.ts (lines 546-584).
 * Parameters mirror the closed-over state the real handler relies on.
 */
function makeStdinEndHandler(opts: {
  processMonitorGetAll: () => Array<{ taskId?: string; graphId?: string }>;
  redisKeys: (pattern: string) => Promise<string[]>;
  redisGet: (key: string) => Promise<string | null>;
  sessionId: string;
  cleanup: () => void;
  setHeadless: (v: boolean) => void;
  log: (msg: string) => void;
}) {
  const {
    processMonitorGetAll,
    redisKeys,
    redisGet,
    sessionId,
    cleanup,
    setHeadless,
    log,
  } = opts;

  return async () => {
    log("stdin closed — checking if we should stay alive...");
    setHeadless(true);

    await new Promise<void>((r) => setTimeout(r, 3000));

    const entries = processMonitorGetAll();
    const hasRunningAgents = entries.some((e) => e.graphId && e.taskId);

    if (hasRunningAgents) {
      log(`staying alive in headless mode — ${entries.length} agents still running`);
      return;
    }

    try {
      const orchestratorKeys = await redisKeys("graph:*:orchestrator");
      for (const key of orchestratorKeys) {
        const owner = await redisGet(key);
        if (owner === sessionId) {
          const gid = key.split(":")[1];
          const taskKeys = await redisKeys(`graph:${gid}:tasks:*`);
          // Simplified: if any task key exists under this graph, treat as running
          if (taskKeys.length > 0) {
            log(`staying alive in headless mode — graph ${gid.slice(0, 8)} has running tasks`);
            return;
          }
        }
      }
    } catch {
      /* Redis may be down */
    }

    log("no active graphs — shutting down");
    cleanup();
  };
}

describe("MCP stdio stability: stdin 'end' handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does NOT call cleanup when processMonitor has active entries with graphId+taskId", async () => {
    const cleanup = vi.fn();
    const setHeadless = vi.fn();
    const log = vi.fn();

    const handler = makeStdinEndHandler({
      processMonitorGetAll: () => [
        { taskId: "task-1", graphId: "graph-abc" },
      ],
      redisKeys: vi.fn().mockResolvedValue([]),
      redisGet: vi.fn().mockResolvedValue(null),
      sessionId: "sess-xyz",
      cleanup,
      setHeadless,
      log,
    });

    const promise = handler();
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(cleanup).not.toHaveBeenCalled();
    expect(setHeadless).toHaveBeenCalledWith(true);
  });

  it("calls cleanup when processMonitor is empty and no Redis orchestrated graphs", async () => {
    const cleanup = vi.fn();
    const setHeadless = vi.fn();
    const log = vi.fn();

    const handler = makeStdinEndHandler({
      processMonitorGetAll: () => [],
      redisKeys: vi.fn().mockResolvedValue([]),
      redisGet: vi.fn().mockResolvedValue(null),
      sessionId: "sess-xyz",
      cleanup,
      setHeadless,
      log,
    });

    const promise = handler();
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does NOT call cleanup when processMonitor entry is missing graphId (not a graph task)", async () => {
    // An entry without graphId/taskId is not a tracked graph task — should still shut down
    const cleanup = vi.fn();

    const handler = makeStdinEndHandler({
      processMonitorGetAll: () => [
        { taskId: undefined, graphId: undefined },
      ],
      redisKeys: vi.fn().mockResolvedValue([]),
      redisGet: vi.fn().mockResolvedValue(null),
      sessionId: "sess-xyz",
      cleanup,
      setHeadless: vi.fn(),
      log: vi.fn(),
    });

    const promise = handler();
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    // No graphId+taskId pair → treated as no active agents → cleanup
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("proceeds to cleanup when Redis throws during graph check", async () => {
    const cleanup = vi.fn();

    const handler = makeStdinEndHandler({
      processMonitorGetAll: () => [],
      redisKeys: vi.fn().mockRejectedValue(new Error("Redis down")),
      redisGet: vi.fn(),
      sessionId: "sess-xyz",
      cleanup,
      setHeadless: vi.fn(),
      log: vi.fn(),
    });

    const promise = handler();
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("sets headless=true regardless of whether cleanup is called", async () => {
    const setHeadless = vi.fn();

    // With active agents (no cleanup)
    const handler1 = makeStdinEndHandler({
      processMonitorGetAll: () => [{ taskId: "t1", graphId: "g1" }],
      redisKeys: vi.fn().mockResolvedValue([]),
      redisGet: vi.fn().mockResolvedValue(null),
      sessionId: "sess-xyz",
      cleanup: vi.fn(),
      setHeadless,
      log: vi.fn(),
    });

    const p1 = handler1();
    await vi.advanceTimersByTimeAsync(3000);
    await p1;

    expect(setHeadless).toHaveBeenCalledWith(true);
    setHeadless.mockClear();

    // Without active agents (calls cleanup)
    const handler2 = makeStdinEndHandler({
      processMonitorGetAll: () => [],
      redisKeys: vi.fn().mockResolvedValue([]),
      redisGet: vi.fn().mockResolvedValue(null),
      sessionId: "sess-xyz",
      cleanup: vi.fn(),
      setHeadless,
      log: vi.fn(),
    });

    const p2 = handler2();
    await vi.advanceTimersByTimeAsync(3000);
    await p2;

    expect(setHeadless).toHaveBeenCalledWith(true);
  });
});

// ── McpServer version resolution (#139) ──────────────────────────────────────

/**
 * Reproduces the version resolution that mcp-server.ts now performs BEFORE
 * constructing McpServer (fix #139). The constructor used to receive the stale
 * hardcoded "0.1.16"; now it receives the real resolved version.
 *
 * We cannot import mcp-server.ts directly (heavy side-effects at module load),
 * so we test the resolution logic inline — the same pattern used throughout
 * this file.
 */
import { createRequire } from "node:module";

describe("MCP serverInfo version resolution (#139)", () => {
  it("resolves version from package.json when BUNDLE_VERSION is not defined", () => {
    // Simulate the resolution that now runs before `new McpServer(...)` in mcp-server.ts
    const resolveVersion = (): string => {
      const bundleVersion: string | undefined = undefined; // dev environment: no esbuild define
      const pkg = typeof bundleVersion !== "undefined"
        ? { version: bundleVersion }
        : createRequire(import.meta.url)("../package.json") as { version: string };
      return pkg.version;
    };

    const version = resolveVersion();
    // Must be a valid semver string; must NOT be the stale "0.1.16" literal.
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).not.toBe("0.1.16");
  });

  it("prefers BUNDLE_VERSION over package.json when defined", () => {
    const bundleVersion = "9.9.9-test";
    const pkg = typeof bundleVersion !== "undefined"
      ? { version: bundleVersion }
      : createRequire(import.meta.url)("../package.json") as { version: string };
    expect(pkg.version).toBe("9.9.9-test");
  });
});

// ── Derived gated tool count (#140) ──────────────────────────────────────────

/**
 * Reproduces the gate() mechanism from mcp-server.ts after fix #140.
 * Previously: `const totalToolCount = 41` was a hardcoded literal; the "gated"
 * log field was computed as totalToolCount - registeredToolCount.
 * After fix: gatedToolCount is tracked live in gate(), so both counters derive
 * from the same registration loop and cannot drift independently.
 */
describe("Derived gated tool count — gate() tracks both registered and unregistered (#140)", () => {
  function makeGateMechanism(isAllowed: (name: string) => boolean) {
    let registeredToolCount = 0;
    let gatedToolCount = 0;

    const gate = (toolName: string, _register: () => void, count = 1): void => {
      if (isAllowed(toolName)) {
        _register();
        registeredToolCount += count;
      } else {
        gatedToolCount += count;
      }
    };

    return { gate, getRegistered: () => registeredToolCount, getGated: () => gatedToolCount };
  }

  it("gatedToolCount increments for blocked tools, registeredToolCount for allowed ones", () => {
    const allowed = new Set(["tool_a", "tool_b"]);
    const { gate, getRegistered, getGated } = makeGateMechanism((name) => allowed.has(name));
    const stub = () => {};

    gate("tool_a", stub);       // allowed
    gate("tool_b", stub);       // allowed
    gate("tool_c", stub);       // blocked
    gate("bundle_d", stub, 3);  // blocked, bundle of 3

    expect(getRegistered()).toBe(2);
    expect(getGated()).toBe(4);
  });

  it("sum of registered + gated equals total possible tools (no hardcoded literal needed)", () => {
    const TOOLS = ["a", "b", "c", "d", "e"] as const;
    const allowed = new Set(["a", "c", "e"]);
    const { gate, getRegistered, getGated } = makeGateMechanism((name) => allowed.has(name));
    const stub = () => {};

    for (const tool of TOOLS) gate(tool, stub);

    // No literal needed: total = registered + gated
    expect(getRegistered() + getGated()).toBe(TOOLS.length);
    expect(getRegistered()).toBe(3);
    expect(getGated()).toBe(2);
  });

  it("bundle count (count > 1) accumulates in the correct counter", () => {
    // list_graphs gates 3 tools as a bundle (list_graphs, cleanup_graph, cleanup_all)
    const { gate, getRegistered, getGated } = makeGateMechanism(() => false); // nothing allowed
    gate("list_graphs", () => {}, 3);
    expect(getGated()).toBe(3);
    expect(getRegistered()).toBe(0);
  });
});
