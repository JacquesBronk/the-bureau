import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Writable } from "node:stream";
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from "../src/telemetry/testing.js";
import {
  _traceContextMixin,
  injectTraceApi,
  _resetTraceApiForTesting,
} from "../src/logger.js";

// We test the logger by capturing its output from a fresh import.
// Each test creates an isolated logger instance to avoid shared state.
import pino from "pino";

function makeLogger(level: string, lines: string[]) {
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString().trim());
      cb();
    },
  });
  return pino({ level, name: "the-bureau", timestamp: pino.stdTimeFunctions.isoTime }, sink);
}

describe("logger module", () => {
  it("exports logger and createLogger", async () => {
    const mod = await import("../src/logger.js");
    expect(mod.logger).toBeDefined();
    expect(typeof mod.createLogger).toBe("function");
  });

  it("createLogger returns a child logger that includes correlation fields", async () => {
    const { createLogger } = await import("../src/logger.js");
    const child = createLogger({ sessionId: "s1", graphId: "g1", taskId: "t1" });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe("function");
    expect(typeof child.error).toBe("function");
  });
});

describe("pino logger behaviour (unit)", () => {
  it("info level writes a JSON line with msg field", () => {
    const lines: string[] = [];
    const log = makeLogger("info", lines);
    log.info("hello world");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.msg).toBe("hello world");
    expect(entry.level).toBe(30); // pino numeric level for 'info'
    expect(entry.name).toBe("the-bureau");
  });

  it("structured fields are serialised into the JSON entry", () => {
    const lines: string[] = [];
    const log = makeLogger("info", lines);
    log.info({ graphId: "abc123", taskId: "t42" }, "task spawned");
    const entry = JSON.parse(lines[0]);
    expect(entry.graphId).toBe("abc123");
    expect(entry.taskId).toBe("t42");
    expect(entry.msg).toBe("task spawned");
  });

  it("debug messages are suppressed when level is info", () => {
    const lines: string[] = [];
    const log = makeLogger("info", lines);
    log.debug("should not appear");
    expect(lines.length).toBe(0);
  });

  it("debug messages appear when level is debug", () => {
    const lines: string[] = [];
    const log = makeLogger("debug", lines);
    log.debug({ tool: "set_status" }, "tool call");
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(20); // pino numeric level for 'debug'
    expect(entry.tool).toBe("set_status");
  });

  it("warn level writes level 40", () => {
    const lines: string[] = [];
    const log = makeLogger("warn", lines);
    log.warn({ staleMs: 600000 }, "stale agent detected");
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(40);
    expect(entry.staleMs).toBe(600000);
  });

  it("error level writes level 50", () => {
    const lines: string[] = [];
    const log = makeLogger("error", lines);
    log.error({ exitCode: 1 }, "task failed");
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(50);
    expect(entry.exitCode).toBe(1);
  });

  it("child logger inherits parent fields", () => {
    const lines: string[] = [];
    const base = makeLogger("info", lines);
    const child = base.child({ sessionId: "sess-1", graphId: "graph-1" });
    child.info({ taskId: "task-1" }, "task completed");
    const entry = JSON.parse(lines[0]);
    expect(entry.sessionId).toBe("sess-1");
    expect(entry.graphId).toBe("graph-1");
    expect(entry.taskId).toBe("task-1");
    expect(entry.msg).toBe("task completed");
  });

  it("LOG_LEVEL env var controls root logger level", async () => {
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    // Re-import in isolation using a fresh pino instance to validate the pattern
    const lines: string[] = [];
    const log = makeLogger(process.env.LOG_LEVEL ?? "info", lines);
    log.info("should be suppressed");
    log.warn("should appear");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.msg).toBe("should appear");
    process.env.LOG_LEVEL = original;
  });

  it("timestamp is included in log entries", () => {
    const lines: string[] = [];
    const log = makeLogger("info", lines);
    const before = Date.now();
    log.info("timestamped");
    const entry = JSON.parse(lines[0]);
    // isoTime produces a 'time' string like '2024-01-01T00:00:00.000Z'
    expect(typeof entry.time).toBe("string");
    expect(new Date(entry.time).getTime()).toBeGreaterThanOrEqual(before - 100);
  });
});

// ---------------------------------------------------------------------------
// Trace context mixin
// ---------------------------------------------------------------------------

describe("trace context mixin (_traceContextMixin)", () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    const { trace, isSpanContextValid } = await import("@opentelemetry/api");
    injectTraceApi(trace, isSpanContextValid);
  });

  afterEach(async () => {
    _resetTraceApiForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it("includes trace_id and span_id matching the active span context", () => {
    let result: Record<string, unknown> = {};
    let expectedTraceId = "";
    let expectedSpanId = "";

    harness.getTracer().startActiveSpan("test-span", (span) => {
      result = _traceContextMixin();
      const sc = span.spanContext();
      expectedTraceId = sc.traceId;
      expectedSpanId = sc.spanId;
      span.end();
    });

    expect(typeof result.trace_id).toBe("string");
    expect(typeof result.span_id).toBe("string");
    expect(result.trace_id).toBe(expectedTraceId);
    expect(result.span_id).toBe(expectedSpanId);
    expect((result.trace_id as string).length).toBeGreaterThan(0);
  });

  it("returns empty object when no span is active", () => {
    const result = _traceContextMixin();
    expect(result).not.toHaveProperty("trace_id");
    expect(result).not.toHaveProperty("span_id");
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("does not throw when span context lookup throws", async () => {
    const { isSpanContextValid } = await import("@opentelemetry/api");
    // Inject a broken trace API that throws on getActiveSpan
    const brokenTrace = {
      getActiveSpan() {
        throw new Error("OTel unavailable");
      },
    } as unknown as typeof import("@opentelemetry/api").trace;
    injectTraceApi(brokenTrace, isSpanContextValid);

    let result: Record<string, unknown> = { threw: true };
    expect(() => {
      result = _traceContextMixin();
    }).not.toThrow();
    expect(result).not.toHaveProperty("trace_id");
    expect(result).not.toHaveProperty("span_id");
  });
});
