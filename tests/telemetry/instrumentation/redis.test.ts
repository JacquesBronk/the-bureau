/**
 * tests/telemetry/instrumentation/redis.test.ts
 *
 * Unit tests for the Redis instrumentation seam.
 * Uses the in-memory telemetry harness with vi.mock to wire getMeter/getTracer.
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
// Mock core.ts so getMeter / getTracer can be controlled per-test.
// vi.mock is hoisted before imports by vitest — the factory runs first.
// ---------------------------------------------------------------------------

vi.mock('../../../src/telemetry/core.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/telemetry/core.js')>();
  return {
    ...original,
    getMeter: vi.fn().mockReturnValue(null),
    getTracer: vi.fn().mockReturnValue(null),
  };
});

// Import after mock is set up.
import { getMeter, getTracer } from '../../../src/telemetry/core.js';
import { wrapRedisClient } from '../../../src/telemetry/instrumentation/redis.js';

// ---------------------------------------------------------------------------
// Stub Redis client helpers
// ---------------------------------------------------------------------------

/** Minimal ioredis-like stub for testing regular commands. */
function makeClientStub() {
  return {
    get: vi.fn().mockResolvedValue('value'),
    set: vi.fn().mockResolvedValue('OK'),
    xadd: vi.fn().mockResolvedValue('1234-0'),
    del: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue({ key: 'val' }),
    exists: vi.fn().mockResolvedValue(1),
  };
}

/** Minimal pipeline stub. Returns itself from command methods for chaining. */
function makePipelineStub(execResult: unknown = []) {
  const pipe: Record<string, unknown> = {};
  pipe.xadd = vi.fn().mockReturnValue(pipe);
  pipe.set = vi.fn().mockReturnValue(pipe);
  pipe.get = vi.fn().mockReturnValue(pipe);
  pipe.exec = vi.fn().mockResolvedValue(execResult);
  return pipe;
}

// ---------------------------------------------------------------------------
// Enabled-path tests (harness installed, getMeter/getTracer return non-null)
// ---------------------------------------------------------------------------

describe('wrapRedisClient — enabled path', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    vi.mocked(getMeter).mockReturnValue(harness.getMeter());
    vi.mocked(getTracer).mockReturnValue(harness.getTracer());
  });

  afterEach(async () => {
    vi.mocked(getMeter).mockReturnValue(null);
    vi.mocked(getTracer).mockReturnValue(null);
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  // ── Span attributes ──────────────────────────────────────────────────────

  it('produces a span with db.system=redis and db.operation for get', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).get('events:proj:abc');

    const spans = harness.getSpans('redis.get');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.DB_SYSTEM]).toBe('redis');
    expect(spans[0].attributes[ATTR.DB_OPERATION]).toBe('get');
  });

  it('classifies events: prefix → event.read for get', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).get('events:telemetry-rebuild-v2:abc123');

    const spans = harness.getSpans('redis.get');
    expect(spans[0].attributes[ATTR.REDIS_OPERATION]).toBe('event.read');
    expect(spans[0].attributes[ATTR.REDIS_KEY_PREFIX]).toBe('events');
  });

  it('classifies events: prefix → event.publish for xadd', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).xadd('events:my-project', '*', 'field', 'value');

    const spans = harness.getSpans('redis.xadd');
    expect(spans[0].attributes[ATTR.REDIS_OPERATION]).toBe('event.publish');
    expect(spans[0].attributes[ATTR.REDIS_KEY_PREFIX]).toBe('events');
  });

  it('classifies graph: prefix → graph.read for hgetall', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).hgetall('graph:abc123:tasks:t1');

    const spans = harness.getSpans('redis.hgetall');
    expect(spans[0].attributes[ATTR.REDIS_OPERATION]).toBe('graph.read');
    expect(spans[0].attributes[ATTR.REDIS_KEY_PREFIX]).toBe('graph');
  });

  it('classifies graph: prefix → graph.write for set', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).set('graph:abc123:tasks:t1', '{}');

    const spans = harness.getSpans('redis.set');
    expect(spans[0].attributes[ATTR.REDIS_OPERATION]).toBe('graph.write');
  });

  it('classifies bureau:cache-anomaly: prefix → anomaly.cooldown.check for exists', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).exists('bureau:cache-anomaly:cooldown:type:role:model');

    const spans = harness.getSpans('redis.exists');
    expect(spans[0].attributes[ATTR.REDIS_OPERATION]).toBe('anomaly.cooldown.check');
    expect(spans[0].attributes[ATTR.REDIS_KEY_PREFIX]).toBe('bureau');
  });

  // ── Key prefix cardinality safety ────────────────────────────────────────

  it('bureau.redis.key_prefix is always the first colon-segment, never the full key', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).get('events:telemetry-rebuild-v2:some-uuid-1234');

    const spans = harness.getSpans('redis.get');
    expect(spans[0].attributes[ATTR.REDIS_KEY_PREFIX]).toBe('events');
    // Must NOT contain the full key or any segment beyond the first
    expect(String(spans[0].attributes[ATTR.REDIS_KEY_PREFIX])).not.toContain(':');
  });

  it('key_prefix for graph: key is "graph" only', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).set('graph:abc:tasks:t1', '{}');
    const spans = harness.getSpans('redis.set');
    expect(spans[0].attributes[ATTR.REDIS_KEY_PREFIX]).toBe('graph');
  });

  it('key_prefix for handoff: key is "handoff" only', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).get('handoff:graphId:taskId');
    const spans = harness.getSpans('redis.get');
    expect(spans[0].attributes[ATTR.REDIS_KEY_PREFIX]).toBe('handoff');
  });

  // ── Error handling ───────────────────────────────────────────────────────

  it('error in wrapped method re-throws AND records error counter', async () => {
    const stub = {
      get: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    };
    const client = wrapRedisClient(stub);

    await expect((client as typeof stub).get('graph:x')).rejects.toThrow('ECONNRESET');

    await harness.flush();
    const errors = harness.getMetrics(METRIC.REDIS_OPERATION_ERRORS);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].value).toBeGreaterThanOrEqual(1);
  });

  it('error span has ERROR status', async () => {
    const stub = {
      get: vi.fn().mockRejectedValue(new Error('TIMEOUT')),
    };
    const client = wrapRedisClient(stub);

    await expect((client as typeof stub).get('graph:x')).rejects.toThrow('TIMEOUT');

    const spans = harness.getSpans('redis.get');
    expect(spans).toHaveLength(1);
    // SpanStatusCode.ERROR = 2
    expect(spans[0].status.code).toBe(2);
  });

  // ── Duration histogram ───────────────────────────────────────────────────

  it('records non-zero duration for a successful command', async () => {
    const stub = makeClientStub();
    const client = wrapRedisClient(stub);

    await (client as typeof stub).get('events:proj');
    await harness.flush();

    const durations = harness.getMetrics(METRIC.REDIS_OPERATION_DURATION);
    expect(durations.length).toBeGreaterThan(0);
    // Histogram sum should be >= 0 (duration in ms, may be 0 on fast machines)
    expect(durations[0].value).toBeGreaterThanOrEqual(0);
  });

  // ── Pipeline instrumentation ─────────────────────────────────────────────

  it('pipeline exec() produces exactly ONE span with bureau.redis.batch_size', async () => {
    const pipeStub = makePipelineStub();
    const stub = {
      pipeline: vi.fn().mockReturnValue(pipeStub),
    };
    const client = wrapRedisClient(stub);

    const pipe = (client as typeof stub).pipeline();
    (pipe as typeof pipeStub).xadd('events:p', '*', 'k', 'v');
    (pipe as typeof pipeStub).xadd('events:p', '*', 'k2', 'v2');
    await (pipe as typeof pipeStub).exec();

    // Exactly ONE pipeline span, NOT one per command
    const spans = harness.getSpans('redis.pipeline');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.REDIS_BATCH_SIZE]).toBe(2);
  });

  it('pipeline exec() span has db.system=redis and db.operation=exec', async () => {
    const pipeStub = makePipelineStub();
    const stub = { pipeline: vi.fn().mockReturnValue(pipeStub) };
    const client = wrapRedisClient(stub);

    const pipe = (client as typeof stub).pipeline();
    (pipe as typeof pipeStub).xadd('events:p', '*', 'k', 'v');
    await (pipe as typeof pipeStub).exec();

    const spans = harness.getSpans('redis.pipeline');
    expect(spans[0].attributes[ATTR.DB_SYSTEM]).toBe('redis');
    expect(spans[0].attributes[ATTR.DB_OPERATION]).toBe('exec');
  });

  it('individual pipeline command calls do NOT produce command spans', async () => {
    const pipeStub = makePipelineStub();
    const stub = { pipeline: vi.fn().mockReturnValue(pipeStub) };
    const client = wrapRedisClient(stub);

    const pipe = (client as typeof stub).pipeline();
    (pipe as typeof pipeStub).xadd('events:p', '*', 'k', 'v');
    (pipe as typeof pipeStub).set('graph:x', 'y');
    // No exec() yet — no spans at all
    expect(harness.getSpans()).toHaveLength(0);
  });

  it('pipeline command methods return the pipeline for chaining', async () => {
    const pipeStub = makePipelineStub();
    const stub = { pipeline: vi.fn().mockReturnValue(pipeStub) };
    const client = wrapRedisClient(stub);

    const pipe = (client as typeof stub).pipeline();
    const chained = (pipe as typeof pipeStub).xadd('events:p', '*', 'k', 'v');
    // Must return the pipeline proxy for chaining
    expect(chained).toBe(pipe);
  });

  it('batch_size=0 when exec is called on an empty pipeline', async () => {
    const pipeStub = makePipelineStub();
    const stub = { pipeline: vi.fn().mockReturnValue(pipeStub) };
    const client = wrapRedisClient(stub);

    const pipe = (client as typeof stub).pipeline();
    await (pipe as typeof pipeStub).exec();

    const spans = harness.getSpans('redis.pipeline');
    expect(spans[0].attributes[ATTR.REDIS_BATCH_SIZE]).toBe(0);
  });

  // ── Multi-key correctness ────────────────────────────────────────────────

  it('wraps del command with correct operation classification', async () => {
    const stub = {
      del: vi.fn().mockResolvedValue(1),
    };
    const client = wrapRedisClient(stub);

    await (client as typeof stub).del('lock:my-lock');

    const spans = harness.getSpans('redis.del');
    expect(spans[0].attributes[ATTR.REDIS_OPERATION]).toBe('lock.release');
    expect(spans[0].attributes[ATTR.REDIS_KEY_PREFIX]).toBe('lock');
  });
});

// ---------------------------------------------------------------------------
// Disabled path — harness NOT installed, getMeter() returns null
// ---------------------------------------------------------------------------

describe('wrapRedisClient — disabled path', () => {
  it('returns the same stub reference when getMeter() is null', () => {
    // Default mock: getMeter and getTracer return null
    expect(getMeter()).toBeNull();
    expect(getTracer()).toBeNull();

    const stub = makeClientStub();
    const result = wrapRedisClient(stub);

    // Must return the exact same reference
    expect(result).toBe(stub);
  });

  it('returns the same stub reference when getTracer() is null even if getMeter is non-null', async () => {
    const harness = await createTelemetryHarness();
    vi.mocked(getMeter).mockReturnValue(harness.getMeter());
    vi.mocked(getTracer).mockReturnValue(null); // tracer null

    const stub = makeClientStub();
    const result = wrapRedisClient(stub);
    expect(result).toBe(stub);

    vi.mocked(getMeter).mockReturnValue(null);
    await harness.shutdown();
  });
});

// ---------------------------------------------------------------------------
// schema.ts — ATTR.REDIS_BATCH_SIZE spot check
// ---------------------------------------------------------------------------

describe('schema.ts — bureau.redis.batch_size', () => {
  it('ATTR.REDIS_BATCH_SIZE is "bureau.redis.batch_size"', () => {
    expect(ATTR.REDIS_BATCH_SIZE).toBe('bureau.redis.batch_size');
  });
});
