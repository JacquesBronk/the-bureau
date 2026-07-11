import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PatternStore } from "../../src/self-improvement/pattern-store.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `pattern-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, ".bureau"), { recursive: true });
  return dir;
}

function writePatterns(cwd: string, data: unknown): void {
  writeFileSync(join(cwd, ".bureau", "anomaly-patterns.json"), JSON.stringify(data));
}

const validPatternFile = {
  version: 1,
  patterns: [
    {
      id: "test-structured",
      name: "Test Structured",
      description: "Tests structured detection",
      enabled: true,
      detection: { mode: "structured", eventTypes: ["task_failed"], conditions: {} },
      anomalyType: "test_type",
      severity: "high",
      escalation: null,
      window: null,
    },
    {
      id: "test-keyword",
      name: "Test Keyword",
      description: "Tests keyword detection",
      enabled: true,
      detection: { mode: "keyword", eventTypes: ["task_progress"], keywords: ["error", "fail"], field: "detail" },
      anomalyType: "keyword_type",
      severity: "medium",
      escalation: null,
      window: null,
    },
    {
      id: "test-disabled",
      name: "Disabled Pattern",
      description: "Should be filtered out",
      enabled: false,
      detection: { mode: "structured", eventTypes: ["task_failed"], conditions: {} },
      anomalyType: "disabled_type",
      severity: "low",
      escalation: null,
      window: null,
    },
  ],
};

describe("PatternStore", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmpDir();
  });

  it("loads valid patterns and filters disabled ones", () => {
    writePatterns(cwd, validPatternFile);
    const store = new PatternStore(cwd);
    const count = store.load();
    expect(count).toBe(2); // 3 patterns, 1 disabled
    expect(store.getPatterns()).toHaveLength(2);
  });

  it("returns 0 and empty set when file is missing", () => {
    const store = new PatternStore(cwd);
    // Don't write the file
    const count = store.load();
    expect(count).toBe(0);
    expect(store.getPatterns()).toHaveLength(0);
  });

  it("returns 0 and empty set when file has invalid JSON", () => {
    writeFileSync(join(cwd, ".bureau", "anomaly-patterns.json"), "not json{{{");
    const store = new PatternStore(cwd);
    const count = store.load();
    expect(count).toBe(0);
  });

  it("returns 0 when file fails zod validation", () => {
    writePatterns(cwd, { version: 1, patterns: [{ id: 123 }] }); // id should be string
    const store = new PatternStore(cwd);
    const count = store.load();
    expect(count).toBe(0);
  });

  it("getForEventType filters by event type", () => {
    writePatterns(cwd, validPatternFile);
    const store = new PatternStore(cwd);
    store.load();

    const failedPatterns = store.getForEventType("task_failed");
    expect(failedPatterns).toHaveLength(1);
    expect(failedPatterns[0].id).toBe("test-structured");

    const progressPatterns = store.getForEventType("task_progress");
    expect(progressPatterns).toHaveLength(1);
    expect(progressPatterns[0].id).toBe("test-keyword");

    const nonePatterns = store.getForEventType("nonexistent_event");
    expect(nonePatterns).toHaveLength(0);
  });

  it("reload replaces patterns", () => {
    writePatterns(cwd, validPatternFile);
    const store = new PatternStore(cwd);
    store.load();
    expect(store.getPatterns()).toHaveLength(2);

    // Overwrite with fewer patterns
    writePatterns(cwd, { version: 1, patterns: [validPatternFile.patterns[0]] });
    store.load();
    expect(store.getPatterns()).toHaveLength(1);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });
});
