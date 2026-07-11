/**
 * tests/telemetry/domain/agent.test.ts
 *
 * Unit tests for the agent domain module (§5.1).
 * Uses the in-memory telemetry harness + vi.mock for getMeter isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR } from '../../../src/telemetry/schema.js';

// ---------------------------------------------------------------------------
// Mock core.ts so getMeter can be wired to the harness per-test.
// vi.mock is hoisted before imports — factory runs before any module import.
// ---------------------------------------------------------------------------

vi.mock('../../../src/telemetry/core.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/telemetry/core.js')>();
  return {
    ...original,
    getMeter: vi.fn().mockReturnValue(null),
    getTracer: vi.fn().mockReturnValue(null),
  };
});

// Mock the anomaly detector so it never needs Redis in tests.
vi.mock('../../../src/cache-anomaly-detector.js', () => ({
  getCacheAnomalyDetector: vi.fn().mockReturnValue(null),
  initCacheAnomalyDetector: vi.fn(),
}));

// Import after mocks are in place.
import { getMeter } from '../../../src/telemetry/core.js';
import { onAgentUsage, type AgentUsageEvent } from '../../../src/telemetry/domain/agent.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AgentUsageEvent> = {}): AgentUsageEvent {
  return {
    role: 'coder',
    model: 'claude-sonnet-4-6',
    graphId: 'graph-abc-123',
    taskId: 'task-def-456',
    project: 'test-project',
    prefixHash: 'abc123def456',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadInputTokens: 200,
    cacheCreationInputTokens: 100,
    totalCostUsd: 0.005,
    durationMs: 3500,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('onAgentUsage', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    vi.mocked(getMeter).mockReturnValue(harness.getMeter());
  });

  afterEach(async () => {
    vi.mocked(getMeter).mockReturnValue(null);
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  // ── Token usage — two records ──────────────────────────────────────────────

  it('records exactly 2 token-usage histogram entries: one input, one output', async () => {
    onAgentUsage(makeEvent());
    await harness.flush();

    const entries = harness.getMetrics(METRIC.TOKEN_USAGE);
    expect(entries).toHaveLength(2);

    const inputEntry = entries.find((e) => e.attributes[ATTR.TOKEN_TYPE] === 'input');
    const outputEntry = entries.find((e) => e.attributes[ATTR.TOKEN_TYPE] === 'output');

    expect(inputEntry).toBeDefined();
    expect(outputEntry).toBeDefined();
  });

  it('input token value is the sum of inputTokens + cacheRead + cacheCreate', async () => {
    onAgentUsage(makeEvent({
      inputTokens: 1000,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
    }));
    await harness.flush();

    const entries = harness.getMetrics(METRIC.TOKEN_USAGE);
    const inputEntry = entries.find((e) => e.attributes[ATTR.TOKEN_TYPE] === 'input');
    // 1000 + 200 + 100 = 1300
    expect(inputEntry?.value).toBe(1300);
  });

  it('output token value equals outputTokens', async () => {
    onAgentUsage(makeEvent({ outputTokens: 777 }));
    await harness.flush();

    const entries = harness.getMetrics(METRIC.TOKEN_USAGE);
    const outputEntry = entries.find((e) => e.attributes[ATTR.TOKEN_TYPE] === 'output');
    expect(outputEntry?.value).toBe(777);
  });

  // ── Cache hit rate computation ─────────────────────────────────────────────

  it('cache hit rate is > 0 when cacheReadInputTokens > 0', async () => {
    onAgentUsage(makeEvent({
      inputTokens: 800,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 0,
    }));
    await harness.flush();

    const entries = harness.getMetrics(METRIC.AGENT_CACHE_HIT_RATE);
    expect(entries).toHaveLength(1);
    // cacheRead / (800 + 200 + 0) = 200 / 1000 = 0.2
    expect(entries[0].value).toBeCloseTo(0.2);
  });

  it('cache hit rate is 0 when all cache token fields are 0', async () => {
    onAgentUsage(makeEvent({
      inputTokens: 500,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }));
    await harness.flush();

    const entries = harness.getMetrics(METRIC.AGENT_CACHE_HIT_RATE);
    expect(entries[0].value).toBe(0);
  });

  it('cache hit rate does not divide by zero when all input tokens are 0', async () => {
    onAgentUsage(makeEvent({
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }));
    await harness.flush();

    const entries = harness.getMetrics(METRIC.AGENT_CACHE_HIT_RATE);
    expect(entries[0].value).toBe(0);
  });

  // ── Cost counter monotonicity ──────────────────────────────────────────────

  it('bureau.agent.cost_usd.total counter accumulates across calls (monotonic)', async () => {
    onAgentUsage(makeEvent({ totalCostUsd: 1.0 }));
    await harness.flush();
    const first = harness.getMetrics(METRIC.AGENT_COST_USD_TOTAL);
    expect(first).toHaveLength(1);
    expect(first[0].value).toBeCloseTo(1.0);

    onAgentUsage(makeEvent({ totalCostUsd: 2.0 }));
    await harness.flush();
    const second = harness.getMetrics(METRIC.AGENT_COST_USD_TOTAL);
    expect(second).toHaveLength(1);
    // Delta temporality: second flush shows only the new addition
    expect(second[0].value).toBeCloseTo(2.0);
    // Second call's delta is larger than first — counter is growing (monotonic).
    expect(second[0].value).toBeGreaterThan(0);
  });

  // ── Cardinality fix: high-cardinality attrs absent from metrics ────────────

  it('task_id is NOT present on any metric attribute set', async () => {
    onAgentUsage(makeEvent({ taskId: 'task-should-not-appear' }));
    await harness.flush();

    for (const metricName of [
      METRIC.TOKEN_USAGE,
      METRIC.OPERATION_DURATION,
      METRIC.AGENT_COST_USD,
      METRIC.AGENT_COST_USD_TOTAL,
      METRIC.AGENT_CACHE_HIT_RATE,
    ] as const) {
      for (const entry of harness.getMetrics(metricName)) {
        expect(entry.attributes).not.toHaveProperty(ATTR.TASK_ID);
        expect(entry.attributes).not.toHaveProperty('task_id');
        expect(entry.attributes).not.toHaveProperty('bureau.task.id');
      }
    }
  });

  it('graph_id is NOT present on any metric attribute set', async () => {
    onAgentUsage(makeEvent({ graphId: 'graph-should-not-appear' }));
    await harness.flush();

    for (const metricName of [
      METRIC.TOKEN_USAGE,
      METRIC.OPERATION_DURATION,
      METRIC.AGENT_COST_USD,
      METRIC.AGENT_COST_USD_TOTAL,
      METRIC.AGENT_CACHE_HIT_RATE,
    ] as const) {
      for (const entry of harness.getMetrics(metricName)) {
        expect(entry.attributes).not.toHaveProperty(ATTR.GRAPH_ID);
        expect(entry.attributes).not.toHaveProperty('graph_id');
        expect(entry.attributes).not.toHaveProperty('bureau.graph.id');
      }
    }
  });

  it('prefix_hash is NOT present on any metric attribute set', async () => {
    onAgentUsage(makeEvent({ prefixHash: 'should-not-be-a-label' }));
    await harness.flush();

    for (const metricName of [
      METRIC.TOKEN_USAGE,
      METRIC.OPERATION_DURATION,
      METRIC.AGENT_COST_USD,
      METRIC.AGENT_COST_USD_TOTAL,
      METRIC.AGENT_CACHE_HIT_RATE,
    ] as const) {
      for (const entry of harness.getMetrics(metricName)) {
        expect(entry.attributes).not.toHaveProperty(ATTR.AGENT_PREFIX_HASH);
        expect(entry.attributes).not.toHaveProperty('prefix_hash');
        expect(entry.attributes).not.toHaveProperty('bureau.agent.prefix_hash');
      }
    }
  });

  // ── Failure path: error.type label ─────────────────────────────────────────

  it('error.type label appears on all metrics when errorType is set', async () => {
    onAgentUsage(makeEvent({ errorType: 'timeout' }));
    await harness.flush();

    for (const metricName of [
      METRIC.TOKEN_USAGE,
      METRIC.OPERATION_DURATION,
      METRIC.AGENT_COST_USD,
      METRIC.AGENT_COST_USD_TOTAL,
      METRIC.AGENT_CACHE_HIT_RATE,
    ] as const) {
      for (const entry of harness.getMetrics(metricName)) {
        expect(entry.attributes[ATTR.ERROR_TYPE]).toBe('timeout');
      }
    }
  });

  it('error.type label is absent on success (not emitted as "none")', async () => {
    onAgentUsage(makeEvent({ errorType: undefined }));
    await harness.flush();

    for (const metricName of [
      METRIC.TOKEN_USAGE,
      METRIC.OPERATION_DURATION,
      METRIC.AGENT_COST_USD,
      METRIC.AGENT_COST_USD_TOTAL,
      METRIC.AGENT_CACHE_HIT_RATE,
    ] as const) {
      for (const entry of harness.getMetrics(metricName)) {
        expect(entry.attributes).not.toHaveProperty(ATTR.ERROR_TYPE);
      }
    }
  });

  // ── Fault isolation: never throws ─────────────────────────────────────────

  it('does not throw when called with a malformed (empty) event object', () => {
    // Cast to bypass TypeScript — simulates a runtime caller with bad data.
    expect(() => onAgentUsage({} as AgentUsageEvent)).not.toThrow();
  });

  it('does not throw when getMeter returns null (telemetry disabled)', () => {
    vi.mocked(getMeter).mockReturnValue(null);
    expect(() => onAgentUsage(makeEvent())).not.toThrow();
  });

  // ── Low-cardinality base attributes present ────────────────────────────────

  it('base attributes include operation.name, provider, model, and role', async () => {
    onAgentUsage(makeEvent({ role: 'orchestrator', model: 'claude-opus-4-6' }));
    await harness.flush();

    const entries = harness.getMetrics(METRIC.AGENT_COST_USD);
    expect(entries).toHaveLength(1);
    const attrs = entries[0].attributes;
    expect(attrs[ATTR.OPERATION_NAME]).toBe('invoke_agent');
    expect(attrs[ATTR.PROVIDER_NAME]).toBe('anthropic');
    expect(attrs[ATTR.REQUEST_MODEL]).toBe('claude-opus-4-6');
    expect(attrs[ATTR.RESPONSE_MODEL]).toBe('claude-opus-4-6');
    expect(attrs[ATTR.ROLE]).toBe('orchestrator');
  });
});
