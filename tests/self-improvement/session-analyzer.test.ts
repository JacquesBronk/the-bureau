import { describe, it, expect, vi } from "vitest";
import {
  shouldTriggerAnalysis,
  buildAnalyzerTask,
} from "../../src/self-improvement/session-analyzer.js";
import { DEFAULT_ANALYZER_TRIGGER_CONFIG } from "../../src/self-improvement/types.js";
import { triggerAnalysis, resolveReviewDecision } from "../../src/self-improvement/index.js";
import type { SelfImprovementConfig } from "../../src/self-improvement/types.js";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("shouldTriggerAnalysis", () => {
  const config = DEFAULT_ANALYZER_TRIGGER_CONFIG;

  it("triggers when duration exceeds threshold", () => {
    const result = shouldTriggerAnalysis(config, {
      durationMs: 600_000,
      taskCount: 5,
      anomalyCount: 0,
    });
    expect(result).toBe(true);
  });

  it("triggers when task count exceeds threshold", () => {
    const result = shouldTriggerAnalysis(config, {
      durationMs: 60_000,
      taskCount: 25,
      anomalyCount: 0,
    });
    expect(result).toBe(true);
  });

  it("triggers when anomalies exist and triggerOnAnomalies is true", () => {
    const result = shouldTriggerAnalysis(config, {
      durationMs: 10_000,
      taskCount: 2,
      anomalyCount: 3,
    });
    expect(result).toBe(true);
  });

  it("does not trigger when anomalies exist but triggerOnAnomalies is false", () => {
    const result = shouldTriggerAnalysis(
      { ...config, triggerOnAnomalies: false },
      { durationMs: 10_000, taskCount: 2, anomalyCount: 3 },
    );
    expect(result).toBe(false);
  });

  it("does not trigger when no thresholds are met", () => {
    const result = shouldTriggerAnalysis(config, {
      durationMs: 60_000,
      taskCount: 5,
      anomalyCount: 0,
    });
    expect(result).toBe(false);
  });
});

describe("buildAnalyzerTask", () => {
  it("includes session context in task string", () => {
    const task = buildAnalyzerTask({
      logPath: "/tmp/bureau/orchestrator-999.log",
      sessionId: "session-abc",
      graphId: "graph-xyz",
      durationMs: 600_000,
      anomalies: [{id:"a1",type:"d",severity:"critical"as const,timestamp:0,sessionId:"s1",context:{}},{id:"a2",type:"s",severity:"medium"as const,timestamp:0,sessionId:"s1",context:{}}],
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });

    expect(task).toContain("/tmp/bureau/orchestrator-999.log");
    expect(task).toContain("session-abc");
    expect(task).toContain("graph-xyz");
    expect(task).toContain("600000");
    expect(task).toContain("claude");
    expect(task).toContain("the-bureau");
  });

  it("includes log path verbatim when non-empty", () => {
    const task = buildAnalyzerTask({
      logPath: "/tmp/bureau/orchestrator-999.log",
      sessionId: "session-abc",
      graphId: "graph-xyz",
      durationMs: 300_000,
      anomalies: [],
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });
    expect(task).toContain("- **Log file:** /tmp/bureau/orchestrator-999.log");
  });

  it("emits fallback instruction when logPath is empty", () => {
    const task = buildAnalyzerTask({
      logPath: "",
      sessionId: "session-abc",
      graphId: "graph-xyz",
      durationMs: 300_000,
      anomalies: [],
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });
    expect(task).not.toContain("- **Log file:** \n");
    expect(task).toContain("path not resolved");
    expect(task).toContain("graph-xyz");
    expect(task).toContain("session-abc");
  });

  it("includes Claude transcript path hint in empty-logPath fallback (#280)", () => {
    const task = buildAnalyzerTask({
      logPath: "",
      sessionId: "session-abc",
      graphId: "graph-xyz",
      durationMs: 300_000,
      anomalies: [],
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });
    expect(task).toContain(".claude/projects");
    expect(task).toContain("session-abc.jsonl");
  });

  it("includes early-pivot instruction in task (#279)", () => {
    const task = buildAnalyzerTask({
      logPath: "",
      sessionId: "session-abc",
      graphId: "graph-xyz",
      durationMs: 300_000,
      anomalies: [],
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });
    expect(task).toContain("STOP searching");
    expect(task).toContain("git log");
  });

  it("includes early-pivot instruction even when logPath is non-empty (#279)", () => {
    const task = buildAnalyzerTask({
      logPath: "/tmp/some.log",
      sessionId: "session-abc",
      graphId: "graph-xyz",
      durationMs: 300_000,
      anomalies: [],
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });
    expect(task).toContain("STOP searching");
    expect(task).toContain("git log");
  });

  it("includes anomaly count in task", () => {
    const task = buildAnalyzerTask({
      logPath: "/tmp/log.log",
      sessionId: "s1",
      graphId: "g1",
      durationMs: 300_000,
      anomalies: [{id:"1",type:"t",severity:"medium"as const,timestamp:0,sessionId:"s",context:{}},{id:"2",type:"t",severity:"medium"as const,timestamp:0,sessionId:"s",context:{}},{id:"3",type:"t",severity:"medium"as const,timestamp:0,sessionId:"s",context:{}},{id:"4",type:"t",severity:"medium"as const,timestamp:0,sessionId:"s",context:{}},{id:"5",type:"t",severity:"medium"as const,timestamp:0,sessionId:"s",context:{}}],
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });

    expect(task).toContain("5");
  });
});

// Task 6: digest-present / fallback tests
it("embeds ## Session Digest when a digest is provided", () => {
  const out = buildAnalyzerTask({ logPath: "", sessionId: "s", graphId: "g", durationMs: 1, anomalies: [], forgejoOwner: "claude", forgejoRepo: "the-bureau", digest: "### Task impl\n[ERROR Bash boom]" } as never);
  expect(out).toContain("## Session Digest");
  expect(out).toContain("[ERROR Bash boom]");
  expect(out).toContain("reason over the digest");
  expect(out).not.toContain("Read the session log file");
});

it("falls back to the log-hint + git-pivot when no digest", () => {
  const out = buildAnalyzerTask({ logPath: "", sessionId: "s", graphId: "g", durationMs: 1, anomalies: [], forgejoOwner: "claude", forgejoRepo: "the-bureau" });
  expect(out).not.toContain("## Session Digest");
  expect(out).toContain("git"); // existing #279 pivot text
});

describe("triggerAnalysis depth limit", () => {
  const baseConfig: SelfImprovementConfig = {
    enabled: true,
    analyzerModel: "sonnet",
    maxIssuesPerRun: 5,
    autoApprove: false,
    depthLimit: 1,
    analyzerTrigger: { ...DEFAULT_ANALYZER_TRIGGER_CONFIG, minDurationMs: 0, minToolCalls: 0, triggerOnAnomalies: true },
    maxAutoFixTasks: 3,
    deferredTtlDays: 7,
  };

  const baseMetrics = { durationMs: 600_000, taskCount: 25, anomalyCount: 1 };

  it("returns a task string when depth is below the limit", () => {
    const result = triggerAnalysis({
      config: baseConfig,
      metrics: baseMetrics,
      anomalies: [{id:"a",type:"t",severity:"medium"as const,timestamp:0,sessionId:"s",context:{}}],
      logPath: "/tmp/test.log",
      sessionId: "s1",
      graphId: "g1",
      graphDepth: 0,
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });
    expect(result).not.toBeNull();
  });

  it("returns null when depth equals depthLimit", () => {
    const result = triggerAnalysis({
      config: baseConfig,
      metrics: baseMetrics,
      anomalies: [{id:"a",type:"t",severity:"medium"as const,timestamp:0,sessionId:"s",context:{}}],
      logPath: "/tmp/test.log",
      sessionId: "s1",
      graphId: "g1",
      graphDepth: 1,
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });
    expect(result).toBeNull();
  });

  it("returns null when depth exceeds depthLimit", () => {
    const result = triggerAnalysis({
      config: baseConfig,
      metrics: baseMetrics,
      anomalies: [{id:"a",type:"t",severity:"medium"as const,timestamp:0,sessionId:"s",context:{}}],
      logPath: "/tmp/test.log",
      sessionId: "s1",
      graphId: "g1",
      graphDepth: 5,
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });
    expect(result).toBeNull();
  });

  it("allows trigger when graphDepth is omitted (defaults to 0)", () => {
    const result = triggerAnalysis({
      config: baseConfig,
      metrics: baseMetrics,
      anomalies: [{id:"a",type:"t",severity:"medium"as const,timestamp:0,sessionId:"s",context:{}}],
      logPath: "/tmp/test.log",
      sessionId: "s1",
      graphId: "g1",
      forgejoOwner: "claude",
      forgejoRepo: "the-bureau",
    });
    expect(result).not.toBeNull();
  });
});

// Task 7: resolveReviewDecision
describe("resolveReviewDecision", () => {
  it("graph flag wins, then config default, then thresholds", () => {
    expect(resolveReviewDecision(true, false, false)).toBe(true);   // graph true forces on
    expect(resolveReviewDecision(false, true, true)).toBe(false);   // graph false forces off
    expect(resolveReviewDecision(undefined, true, false)).toBe(true);   // config default on
    expect(resolveReviewDecision(undefined, false, true)).toBe(false);  // config default off
    expect(resolveReviewDecision(undefined, undefined, true)).toBe(true);   // fall to thresholds
    expect(resolveReviewDecision(undefined, undefined, false)).toBe(false);
  });
});
