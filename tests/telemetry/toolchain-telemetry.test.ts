/**
 * tests/telemetry/toolchain-telemetry.test.ts
 *
 * TDD tests for the bureau.toolchain telemetry dimension (#226 Phase 1, Task 5).
 * Asserts that:
 *   1. ATTR.TOOLCHAIN and ATTR.WORKER_IMAGE exist with the correct wire values.
 *   2. beginAgentSpan attaches bureau.toolchain to the invoke_agent span when set.
 *   3. bureau.toolchain is omitted cleanly when absent.
 *
 * Uses the in-memory telemetry harness — no Redis, no Docker required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../src/telemetry/testing.js';
import { ATTR, METRIC } from '../../src/telemetry/schema.js';
import {
  beginAgentSpan,
  recordSpawnFailure,
  _initForTesting,
  _resetForTesting,
} from '../../src/telemetry/instrumentation/agent-spawn.js';

// ---------------------------------------------------------------------------
// Schema pin — always runnable, no harness needed
// ---------------------------------------------------------------------------

describe('bureau.toolchain schema pins', () => {
  it('ATTR.TOOLCHAIN resolves to the correct wire key', () => {
    expect(ATTR.TOOLCHAIN).toBe('bureau.toolchain');
  });

  it('ATTR.WORKER_IMAGE resolves to the correct wire key', () => {
    expect(ATTR.WORKER_IMAGE).toBe('bureau.worker.image');
  });
});

// ---------------------------------------------------------------------------
// Span-capture assertions — require the in-memory harness
// ---------------------------------------------------------------------------

describe('bureau.toolchain telemetry dimension — span attributes', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    _resetForTesting();
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _initForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('beginAgentSpan attaches bureau.toolchain when toolchain is set', async () => {
    const handle = await beginAgentSpan({
      role: 'coder',
      taskId: 't-toolchain',
      graphId: 'g-toolchain',
      toolchain: 'python',
    });
    handle.end({});

    const spans = harness.getSpans('invoke_agent');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.TOOLCHAIN]).toBe('python');
  });

  it('beginAgentSpan omits bureau.toolchain when toolchain is absent', async () => {
    const handle = await beginAgentSpan({
      role: 'coder',
      taskId: 't-no-toolchain',
      graphId: 'g-no-toolchain',
    });
    handle.end({});

    const spans = harness.getSpans('invoke_agent');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.TOOLCHAIN]).toBeUndefined();
  });

  it('beginAgentSpan attaches bureau.toolchain for node toolchain', async () => {
    const handle = await beginAgentSpan({
      role: 'coder',
      taskId: 't-node',
      graphId: 'g-node',
      toolchain: 'node',
    });
    handle.end({});

    const spans = harness.getSpans('invoke_agent');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.TOOLCHAIN]).toBe('node');
  });

  it('beginAgentSpan attaches bureau.worker.image when workerImage is set', async () => {
    const handle = await beginAgentSpan({
      role: 'coder',
      taskId: 't-worker-image',
      graphId: 'g-worker-image',
      workerImage: 'img/py:latest',
    });
    handle.end({});

    const spans = harness.getSpans('invoke_agent');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.WORKER_IMAGE]).toBe('img/py:latest');
  });

  it('beginAgentSpan omits bureau.worker.image when workerImage is absent', async () => {
    const handle = await beginAgentSpan({
      role: 'coder',
      taskId: 't-no-worker-image',
      graphId: 'g-no-worker-image',
    });
    handle.end({});

    const spans = harness.getSpans('invoke_agent');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.WORKER_IMAGE]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordSpawnFailure — bureau.toolchain counter label
// ---------------------------------------------------------------------------

describe('bureau.toolchain telemetry dimension — spawn failure counter', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    _resetForTesting();
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _initForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('recordSpawnFailure attaches bureau.toolchain label when toolchain is present', async () => {
    recordSpawnFailure('toolchain_unknown', {
      role: 'coder',
      taskId: 't-fail-tc',
      graphId: 'g-fail-tc',
      toolchain: 'python',
    });
    await harness.flush();

    const failures = harness.getMetrics(METRIC.SPAWN_FAILURES);
    expect(failures).toHaveLength(1);
    expect(failures[0].value).toBe(1);
    expect(failures[0].attributes[ATTR.TOOLCHAIN]).toBe('python');
  });

  it('recordSpawnFailure omits bureau.toolchain label when toolchain is absent', async () => {
    recordSpawnFailure('image_not_approved', {
      role: 'coder',
      taskId: 't-fail-no-tc',
      graphId: 'g-fail-no-tc',
    });
    await harness.flush();

    const failures = harness.getMetrics(METRIC.SPAWN_FAILURES);
    expect(failures).toHaveLength(1);
    expect(failures[0].value).toBe(1);
    expect(failures[0].attributes[ATTR.TOOLCHAIN]).toBeUndefined();
  });
});
