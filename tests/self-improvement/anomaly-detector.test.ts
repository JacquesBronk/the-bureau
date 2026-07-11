import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnomalyDetector } from "../../src/self-improvement/anomaly-detector.js";
import { PatternStore } from "../../src/self-improvement/pattern-store.js";
import type { AnomalyStore } from "../../src/self-improvement/anomaly-store.js";
import type { AnomalyPattern } from "../../src/self-improvement/pattern-types.js";
import type { TaskEvent } from "../../src/types.js";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock AnomalyStore
function mockAnomalyStore(): AnomalyStore {
  return {
    record: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    clear: vi.fn(async () => {}),
  } as unknown as AnomalyStore;
}

// Mock PatternStore that returns configured patterns
function mockPatternStore(patterns: AnomalyPattern[]): PatternStore {
  const store = {
    load: vi.fn(() => patterns.length),
    getPatterns: vi.fn(() => patterns),
    getForEventType: vi.fn((eventType: string) =>
      patterns.filter((p) => p.detection.eventTypes.includes(eventType)),
    ),
  };
  return store as unknown as PatternStore;
}

function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    type: "task_failed",
    graphId: "graph-1",
    taskId: "task-1",
    timestamp: Date.now(),
    ...overrides,
  } as TaskEvent;
}

function makePattern(overrides: Partial<AnomalyPattern> = {}): AnomalyPattern {
  return {
    id: "test-pattern",
    name: "Test Pattern",
    description: "test",
    enabled: true,
    detection: { mode: "structured" as const, eventTypes: ["task_failed"], conditions: {} },
    anomalyType: "test_anomaly",
    severity: "high" as const,
    escalation: null,
    window: null,
    ...overrides,
  };
}

describe("AnomalyDetector", () => {
  let store: AnomalyStore;

  beforeEach(() => {
    store = mockAnomalyStore();
  });

  describe("structured detection", () => {
    it("matches event with empty conditions (always matches)", async () => {
      const pattern = makePattern();
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const results = await detector.evaluate(makeEvent());
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("test_anomaly");
      expect(store.record).toHaveBeenCalledOnce();
    });

    it("matches $in operator", async () => {
      const pattern = makePattern({
        detection: {
          mode: "structured",
          eventTypes: ["task_failed"],
          conditions: { exitCode: { $in: [137, 139] } },
        },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      // Matching event
      const results = await detector.evaluate(makeEvent({ exitCode: 137 } as any));
      expect(results).toHaveLength(1);

      // Non-matching event
      const results2 = await detector.evaluate(makeEvent({ exitCode: 1 } as any));
      expect(results2).toHaveLength(0);
    });

    it("matches $gt operator", async () => {
      const pattern = makePattern({
        detection: {
          mode: "structured",
          eventTypes: ["task_completed"],
          conditions: { durationMultiplier: { $gt: 2.0 } },
        },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const results = await detector.evaluate(
        makeEvent({ type: "task_completed", durationMultiplier: 3.0 } as any),
      );
      expect(results).toHaveLength(1);

      const results2 = await detector.evaluate(
        makeEvent({ type: "task_completed", durationMultiplier: 1.5 } as any),
      );
      expect(results2).toHaveLength(0);
    });

    it("does not match when event type doesn't match pattern", async () => {
      const pattern = makePattern({
        detection: { mode: "structured", eventTypes: ["task_completed"], conditions: {} },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const results = await detector.evaluate(makeEvent({ type: "task_failed" } as any));
      expect(results).toHaveLength(0);
    });
  });

  describe("keyword detection", () => {
    it("matches keywords case-insensitively", async () => {
      const pattern = makePattern({
        id: "kw-test",
        detection: {
          mode: "keyword",
          eventTypes: ["task_progress"],
          keywords: ["error", "fail"],
          field: "detail",
        },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const results = await detector.evaluate(
        makeEvent({ type: "task_progress", detail: "Something ERROR happened" } as any),
      );
      expect(results).toHaveLength(1);
    });

    it("does not match when no keywords found", async () => {
      const pattern = makePattern({
        detection: {
          mode: "keyword",
          eventTypes: ["task_progress"],
          keywords: ["error"],
          field: "detail",
        },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const results = await detector.evaluate(
        makeEvent({ type: "task_progress", detail: "All good here" } as any),
      );
      expect(results).toHaveLength(0);
    });

    it("returns empty when field is not a string", async () => {
      const pattern = makePattern({
        detection: {
          mode: "keyword",
          eventTypes: ["task_progress"],
          keywords: ["error"],
          field: "detail",
        },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const results = await detector.evaluate(
        makeEvent({ type: "task_progress" } as any), // no detail field
      );
      expect(results).toHaveLength(0);
    });
  });

  describe("regex detection", () => {
    it("matches regex pattern", async () => {
      const pattern = makePattern({
        detection: {
          mode: "regex",
          eventTypes: ["task_progress"],
          pattern: "(error|exception|failed)",
          field: "detail",
        },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const results = await detector.evaluate(
        makeEvent({ type: "task_progress", detail: "Task FAILED with exception" } as any),
      );
      expect(results).toHaveLength(1);
    });

    it("handles invalid regex gracefully", async () => {
      const pattern = makePattern({
        detection: {
          mode: "regex",
          eventTypes: ["task_progress"],
          pattern: "[invalid((",
          field: "detail",
        },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const results = await detector.evaluate(
        makeEvent({ type: "task_progress", detail: "anything" } as any),
      );
      expect(results).toHaveLength(0);
    });
  });

  describe("windowing", () => {
    it("only fires after threshold is reached", async () => {
      const pattern = makePattern({
        window: { durationMs: 60000, threshold: 3, groupBy: "graphId" },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });
      const now = Date.now();

      // Events 1 and 2: below threshold
      expect(await detector.evaluate(makeEvent({ timestamp: now }))).toHaveLength(0);
      expect(await detector.evaluate(makeEvent({ timestamp: now + 100 }))).toHaveLength(0);

      // Event 3: threshold reached, fires
      expect(await detector.evaluate(makeEvent({ timestamp: now + 200 }))).toHaveLength(1);
    });

    it("resets window after firing", async () => {
      const pattern = makePattern({
        window: { durationMs: 60000, threshold: 2, groupBy: "graphId" },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });
      const now = Date.now();

      expect(await detector.evaluate(makeEvent({ timestamp: now }))).toHaveLength(0);
      expect(await detector.evaluate(makeEvent({ timestamp: now + 100 }))).toHaveLength(1);

      // After reset, need threshold again
      expect(await detector.evaluate(makeEvent({ timestamp: now + 200 }))).toHaveLength(0);
      expect(await detector.evaluate(makeEvent({ timestamp: now + 300 }))).toHaveLength(1);
    });

    it("resets window when duration expires", async () => {
      const pattern = makePattern({
        window: { durationMs: 1000, threshold: 2, groupBy: "graphId" },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });
      const now = Date.now();

      expect(await detector.evaluate(makeEvent({ timestamp: now }))).toHaveLength(0);
      // Window expired — resets counter
      expect(await detector.evaluate(makeEvent({ timestamp: now + 2000 }))).toHaveLength(0);
      expect(await detector.evaluate(makeEvent({ timestamp: now + 2100 }))).toHaveLength(1);
    });
  });

  describe("escalation", () => {
    it("escalates severity after afterCount matches", async () => {
      const pattern = makePattern({
        severity: "medium",
        escalation: { afterCount: 2, newSeverity: "critical" },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const r1 = await detector.evaluate(makeEvent());
      expect(r1[0].severity).toBe("medium");

      const r2 = await detector.evaluate(makeEvent({ timestamp: Date.now() + 1 }));
      expect(r2[0].severity).toBe("critical");

      const r3 = await detector.evaluate(makeEvent({ timestamp: Date.now() + 2 }));
      expect(r3[0].severity).toBe("critical");
    });
  });

  describe("anomaly record", () => {
    it("includes correct context fields", async () => {
      const pattern = makePattern({ id: "ctx-test", name: "Context Test" });
      const detector = new AnomalyDetector({
        sessionId: "session-abc",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      const results = await detector.evaluate(
        makeEvent({ graphId: "g1", taskId: "t1", detail: "some detail" } as any),
      );
      expect(results).toHaveLength(1);
      const anomaly = results[0];
      expect(anomaly.sessionId).toBe("session-abc");
      expect(anomaly.graphId).toBe("g1");
      expect(anomaly.taskId).toBe("t1");
      expect(anomaly.context).toMatchObject({
        patternId: "ctx-test",
        patternName: "Context Test",
        eventType: "task_failed",
        detail: "some detail",
      });
    });
  });

  describe("multi-graph detection", () => {
    it("tracks session graph count for sessionGraphCount field", async () => {
      const pattern = makePattern({
        detection: {
          mode: "structured",
          eventTypes: ["graph_completed"],
          conditions: { sessionGraphCount: { $gt: 1 } },
        },
      });
      const detector = new AnomalyDetector({
        sessionId: "s1",
        anomalyStore: store,
        patternStore: mockPatternStore([pattern]),
      });

      // Simulate graph declarations (increments internal counter)
      await detector.evaluate({ type: "graph_completed" as any, graphId: "g1", timestamp: Date.now() } as any);
      await detector.evaluate({ type: "graph_completed" as any, graphId: "g2", timestamp: Date.now() + 1 } as any);

      // Now graph_completed with sessionGraphCount > 1 should match
      const results = await detector.evaluate(
        makeEvent({ type: "graph_completed", timestamp: Date.now() + 2 } as any),
      );
      expect(results).toHaveLength(1);
    });
  });
});
