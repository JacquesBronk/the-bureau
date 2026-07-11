/**
 * tests/telemetry/domain/transcript.test.ts
 *
 * TDD tests for src/telemetry/domain/transcript.ts — the #313-B P1 visibility
 * counters bureau.transcript.read{consumer,result} and bureau.cost.source{source}.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR_LOW } from '../../../src/telemetry/schema.js';
import { _resetForTesting, _injectForTesting } from '../../../src/telemetry/core.js';
import {
  onTranscriptRead,
  onCostSource,
  type TranscriptConsumer,
} from '../../../src/telemetry/domain/transcript.js';

async function setup() {
  _resetForTesting();
  const harness = await createTelemetryHarness();
  await installHarnessGlobally(harness);
  _injectForTesting(harness.getMeter(), harness.getTracer());
  return harness;
}

async function teardown(harness: TelemetryHarness) {
  _resetForTesting();
  await uninstallHarnessGlobally();
  await harness.shutdown();
}

const CONSUMERS: TranscriptConsumer[] = [
  'usage',
  'interrogation',
  'retro_digest',
  'liveness',
  'get_agent_log',
];

describe('onTranscriptRead — bureau.transcript.read counter', () => {
  let harness: TelemetryHarness;
  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it.each(CONSUMERS)('records result=ok for consumer=%s', async (consumer) => {
    onTranscriptRead(consumer, 'ok');
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.TRANSCRIPT_READ);
    const m = metrics.find(
      r => r.attributes[ATTR_LOW.TRANSCRIPT_CONSUMER] === consumer &&
           r.attributes[ATTR_LOW.TRANSCRIPT_RESULT] === 'ok',
    );
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it.each(CONSUMERS)('records result=missing for consumer=%s', async (consumer) => {
    onTranscriptRead(consumer, 'missing');
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.TRANSCRIPT_READ);
    const m = metrics.find(
      r => r.attributes[ATTR_LOW.TRANSCRIPT_CONSUMER] === consumer &&
           r.attributes[ATTR_LOW.TRANSCRIPT_RESULT] === 'missing',
    );
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('is a no-op when the meter is not initialized', () => {
    _resetForTesting();
    expect(() => onTranscriptRead('usage', 'ok')).not.toThrow();
  });
});

describe('onCostSource — bureau.cost.source counter', () => {
  let harness: TelemetryHarness;
  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('records source=parsed', async () => {
    onCostSource('parsed');
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.COST_SOURCE);
    const m = metrics.find(r => r.attributes[ATTR_LOW.COST_SOURCE] === 'parsed');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('records source=missing', async () => {
    onCostSource('missing');
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.COST_SOURCE);
    const m = metrics.find(r => r.attributes[ATTR_LOW.COST_SOURCE] === 'missing');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('is a no-op when the meter is not initialized', () => {
    _resetForTesting();
    expect(() => onCostSource('parsed')).not.toThrow();
  });
});
