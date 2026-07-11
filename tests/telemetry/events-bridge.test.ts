/**
 * tests/telemetry/events-bridge.test.ts
 *
 * Unit/integration tests for the events-bridge safety-net subscriber (§5.7).
 * Uses a real Redis instance (REDIS_URL env, defaults to redis://localhost:6379).
 * Each test gets a unique project name → unique stream key → no cross-test pollution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisClient } from '../../src/redis.js';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../src/telemetry/testing.js';
import { METRIC, ATTR } from '../../src/telemetry/schema.js';
import { _injectForTesting, _resetForTesting } from '../../src/telemetry/core.js';
import {
  startEventsBridge,
  type EventsBridgeHandle,
} from '../../src/telemetry/events-bridge.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Accumulate bureau.event counter metrics across repeated flushes until the
 * accumulated totals satisfy the check function or timeout expires.
 *
 * DELTA temporality means each flush() only returns emissions since the last
 * flush, so we must sum across poll iterations to get running totals.
 */
async function waitForCounts(
  harness: TelemetryHarness,
  check: (totals: Map<string, number>) => boolean,
  ms = 5000,
  interval = 100,
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const deadline = Date.now() + ms;
  while (!check(totals)) {
    if (Date.now() > deadline) throw new Error('waitForCounts: timed out');
    await harness.flush();
    for (const m of harness.getMetrics(METRIC.EVENT)) {
      const key = String(m.attributes[ATTR.EVENT_TYPE] ?? '');
      totals.set(key, (totals.get(key) ?? 0) + m.value);
    }
    if (!check(totals)) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Happy-path: publishes events, bridge increments counter per event type
// ---------------------------------------------------------------------------

describe('startEventsBridge — counter increment', () => {
  let harness: TelemetryHarness;
  let bridge: EventsBridgeHandle;
  let project: string;

  beforeEach(async () => {
    project = `eb-test-${randomUUID()}`;
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    // Wire core.ts getMeter() to return the harness meter so domain code can emit.
    _injectForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    if (bridge) await bridge.stop();
    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();

    // Clean up stream
    const redis = createRedisClient(REDIS_URL);
    await redis.del(`events:${project}`);
    await redis.quit();
  });

  it('increments bureau.event counter once per event with correct event.type label', async () => {
    const redis = createRedisClient(REDIS_URL);

    bridge = await startEventsBridge({
      projects: [project],
      getRedis: () => Promise.resolve(createRedisClient(REDIS_URL)),
    });

    // Publish events AFTER bridge starts (bridge reads from '>' — new entries only)
    const streamKey = `events:${project}`;
    await redis.xadd(streamKey, '*', 'type', 'task_started', 'graphId', 'g1', 'timestamp', '1000');
    await redis.xadd(streamKey, '*', 'type', 'task_completed', 'graphId', 'g1', 'timestamp', '2000');
    await redis.xadd(streamKey, '*', 'type', 'task_started', 'graphId', 'g1', 'timestamp', '3000');

    // Accumulate across flushes: 2× task_started + 1× task_completed
    const totals = await waitForCounts(
      harness,
      (t) => (t.get('task_started') ?? 0) >= 2 && (t.get('task_completed') ?? 0) >= 1,
    );

    expect(totals.get('task_started')).toBe(2);
    expect(totals.get('task_completed')).toBe(1);

    await redis.quit();
  });

  it('handles events across multiple projects', async () => {
    const project2 = `eb-test-${randomUUID()}`;
    const redis = createRedisClient(REDIS_URL);

    bridge = await startEventsBridge({
      projects: [project, project2],
      getRedis: () => Promise.resolve(createRedisClient(REDIS_URL)),
    });

    await redis.xadd(`events:${project}`, '*', 'type', 'graph_started', 'graphId', 'g1', 'timestamp', '1000');
    await redis.xadd(`events:${project2}`, '*', 'type', 'graph_completed', 'graphId', 'g2', 'timestamp', '2000');

    const totals = await waitForCounts(
      harness,
      (t) => (t.get('graph_started') ?? 0) >= 1 && (t.get('graph_completed') ?? 0) >= 1,
    );

    expect(totals.get('graph_started')).toBe(1);
    expect(totals.get('graph_completed')).toBe(1);

    // Clean up project2 stream
    await redis.del(`events:${project2}`);
    await redis.quit();
  });
});

// ---------------------------------------------------------------------------
// Fault isolation: malformed entry (no type field) — bridge keeps running
// ---------------------------------------------------------------------------

describe('startEventsBridge — fault isolation', () => {
  let harness: TelemetryHarness;
  let bridge: EventsBridgeHandle;
  let project: string;

  beforeEach(async () => {
    project = `eb-test-${randomUUID()}`;
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _injectForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    if (bridge) await bridge.stop();
    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();

    const redis = createRedisClient(REDIS_URL);
    await redis.del(`events:${project}`);
    await redis.quit();
  });

  it('skips entry with no type field and keeps running — subsequent events still counted', async () => {
    const redis = createRedisClient(REDIS_URL);

    bridge = await startEventsBridge({
      projects: [project],
      getRedis: () => Promise.resolve(createRedisClient(REDIS_URL)),
    });

    const streamKey = `events:${project}`;
    // Malformed: no 'type' field
    await redis.xadd(streamKey, '*', 'graphId', 'g1', 'timestamp', '1000');
    // Valid: should still be counted
    await redis.xadd(streamKey, '*', 'type', 'task_failed', 'graphId', 'g1', 'timestamp', '2000');

    const totals = await waitForCounts(
      harness,
      (t) => (t.get('task_failed') ?? 0) >= 1,
    );

    expect(totals.get('task_failed')).toBe(1);

    // Malformed entry should not produce a counter point — no undefined/empty type key
    expect(totals.has(undefined as unknown as string)).toBe(false);
    expect(totals.has('')).toBe(false);

    await redis.quit();
  });
});

// ---------------------------------------------------------------------------
// stop() — shuts down the consume loop within a reasonable timeout
// ---------------------------------------------------------------------------

describe('startEventsBridge — stop()', () => {
  it('stop() completes within 3 seconds', async () => {
    const project = `eb-test-${randomUUID()}`;
    const harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _injectForTesting(harness.getMeter(), harness.getTracer());

    const bridge = await startEventsBridge({
      projects: [project],
      getRedis: () => Promise.resolve(createRedisClient(REDIS_URL)),
    });

    const start = Date.now();
    await bridge.stop();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);

    // Clean up
    const redis = createRedisClient(REDIS_URL);
    await redis.del(`events:${project}`);
    await redis.quit();

    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('stop() is idempotent — calling twice does not throw', async () => {
    const project = `eb-test-${randomUUID()}`;
    const harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _injectForTesting(harness.getMeter(), harness.getTracer());

    const bridge = await startEventsBridge({
      projects: [project],
      getRedis: () => Promise.resolve(createRedisClient(REDIS_URL)),
    });

    await bridge.stop();
    await expect(bridge.stop()).resolves.not.toThrow();

    const redis = createRedisClient(REDIS_URL);
    await redis.del(`events:${project}`);
    await redis.quit();

    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });
});
