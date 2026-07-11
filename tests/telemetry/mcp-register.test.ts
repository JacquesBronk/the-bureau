/**
 * tests/telemetry/mcp-register.test.ts
 *
 * Unit tests for registerInstrumentedTool — the registerTool-shaped
 * instrumentation helper (§4.3 of the telemetry architecture spec).
 *
 * Mirrors the coverage of mcp-tool.test.ts but adapted to the
 * (args, extra) => result callback shape used by McpServer.registerTool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../src/telemetry/testing.js';
import { METRIC, ATTR } from '../../src/telemetry/schema.js';
import { _resetForTesting, _injectForTesting } from '../../src/telemetry/core.js';
import { registerInstrumentedTool } from '../../src/telemetry/instrumentation/mcp-register.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal McpServer mock that captures the callback passed to registerTool.
 * The captured callback can then be invoked directly to exercise telemetry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCallback = (...args: any[]) => any;

function makeMockServer(): {
  server: McpServer;
  getCallback(name: string): AnyCallback | undefined;
} {
  const callbacks = new Map<string, AnyCallback>();
  const server = {
    registerTool(_name: string, _def: unknown, cb: AnyCallback) {
      callbacks.set(_name, cb);
    },
  } as unknown as McpServer;
  return {
    server,
    getCallback: (name) => callbacks.get(name),
  };
}

// ---------------------------------------------------------------------------
// Identity fast-path — OTel disabled
// ---------------------------------------------------------------------------

describe('registerInstrumentedTool — identity fast-path (OTel disabled)', () => {
  beforeEach(() => _resetForTesting());
  afterEach(() => _resetForTesting());

  it('passes the exact same callback reference to registerTool when meter is null', () => {
    // getMeter() / getTracer() return null because _resetForTesting was called
    const { server, getCallback } = makeMockServer();
    const originalCb: AnyCallback = async () => ({ content: [{ type: 'text', text: 'ok' }] });

    registerInstrumentedTool(server, 'test_tool', {}, originalCb);

    expect(getCallback('test_tool')).toBe(originalCb);
  });

  it('does not create any spans when OTel is disabled', async () => {
    const harness = await createTelemetryHarness();
    // harness is isolated — NOT installed globally, so getMeter()/getTracer() remain null

    const { server, getCallback } = makeMockServer();
    registerInstrumentedTool(server, 'no_otel_tool', {}, async () => ({
      content: [{ type: 'text', text: 'result' }],
    }));

    const cb = getCallback('no_otel_tool')!;
    await cb({});

    // harness was never installed, no spans should appear in it
    expect(harness.getSpans()).toHaveLength(0);
    await harness.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Success path — OTel enabled
// ---------------------------------------------------------------------------

describe('registerInstrumentedTool — success path', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _injectForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    await uninstallHarnessGlobally();
    _resetForTesting();
    await harness.shutdown();
  });

  it('invokes the original callback with forwarded args and returns its result', async () => {
    const { server, getCallback } = makeMockServer();
    let receivedArgs: unknown;
    const expectedResult = { content: [{ type: 'text', text: 'hello' }] };

    registerInstrumentedTool(server, 'echo_tool', {}, async (args: unknown) => {
      receivedArgs = args;
      return expectedResult;
    });

    const cb = getCallback('echo_tool')!;
    const result = await cb({ msg: 'hello' });

    expect(receivedArgs).toEqual({ msg: 'hello' });
    expect(result).toEqual(expectedResult);
  });

  it('creates a span named execute_tool:<toolName>', async () => {
    const { server, getCallback } = makeMockServer();
    registerInstrumentedTool(server, 'my_tool', {}, async () => ({
      content: [{ type: 'text', text: 'done' }],
    }));

    await getCallback('my_tool')!({});

    const spans = harness.getSpans('execute_tool:my_tool');
    expect(spans).toHaveLength(1);
  });

  it('sets gen_ai.tool.name attribute on the span', async () => {
    const { server, getCallback } = makeMockServer();
    registerInstrumentedTool(server, 'attr_tool', {}, async () => ({
      content: [],
    }));

    await getCallback('attr_tool')!({});

    const spans = harness.getSpans('execute_tool:attr_tool');
    expect(spans[0].attributes[ATTR.TOOL_NAME]).toBe('attr_tool');
  });

  it('sets code.function.name=<toolName> on the span (#219 code provenance)', async () => {
    const { server, getCallback } = makeMockServer();
    registerInstrumentedTool(server, 'provenance_tool', {}, async () => ({
      content: [],
    }));

    await getCallback('provenance_tool')!({});

    const spans = harness.getSpans('execute_tool:provenance_tool');
    expect(spans[0].attributes[ATTR.CODE_FUNCTION_NAME]).toBe('provenance_tool');
  });

  it('sets gen_ai.operation.name attribute on the span', async () => {
    const { server, getCallback } = makeMockServer();
    registerInstrumentedTool(server, 'opname_tool', {}, async () => ({
      content: [],
    }));

    await getCallback('opname_tool')!({});

    const spans = harness.getSpans('execute_tool:opname_tool');
    expect(spans[0].attributes[ATTR.OPERATION_NAME]).toBe('execute_tool');
  });

  it('records a duration histogram sample on success', async () => {
    const { server, getCallback } = makeMockServer();
    registerInstrumentedTool(server, 'hist_tool', {}, async () => ({
      content: [],
    }));

    await getCallback('hist_tool')!({});
    await harness.flush();

    const samples = harness.getMetrics(METRIC.OPERATION_DURATION);
    expect(samples.length).toBeGreaterThan(0);

    const sample = samples[0];
    expect(sample.attributes[ATTR.OPERATION_NAME]).toBe('execute_tool');
    expect(sample.attributes[ATTR.TOOL_NAME]).toBe('hist_tool');
    expect(sample.value).toBeGreaterThanOrEqual(0);
  });

  it('does NOT increment error counter on success', async () => {
    const { server, getCallback } = makeMockServer();
    registerInstrumentedTool(server, 'clean_tool', {}, async () => ({
      content: [],
    }));

    await getCallback('clean_tool')!({});
    await harness.flush();

    const errors = harness.getMetrics(METRIC.MCP_TOOL_ERRORS);
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error path — OTel enabled
// ---------------------------------------------------------------------------

describe('registerInstrumentedTool — error path', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _injectForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    await uninstallHarnessGlobally();
    _resetForTesting();
    await harness.shutdown();
  });

  it('re-throws the original error unchanged', async () => {
    const { server, getCallback } = makeMockServer();
    const originalError = new TypeError('bad input');

    registerInstrumentedTool(server, 'fail_tool', {}, async () => {
      throw originalError;
    });

    await expect(getCallback('fail_tool')!({})).rejects.toThrow(originalError);
  });

  it('increments bureau.mcp_tool.errors counter with tool name and error.type', async () => {
    const { server, getCallback } = makeMockServer();

    registerInstrumentedTool(server, 'err_counter_tool', {}, async () => {
      throw new RangeError('out of range');
    });

    await expect(getCallback('err_counter_tool')!({})).rejects.toThrow();
    await harness.flush();

    const errors = harness.getMetrics(METRIC.MCP_TOOL_ERRORS);
    expect(errors).toHaveLength(1);
    expect(errors[0].value).toBe(1);
    expect(errors[0].attributes[ATTR.TOOL_NAME]).toBe('err_counter_tool');
    expect(errors[0].attributes[ATTR.ERROR_TYPE]).toBe('RangeError');
  });

  it('sets span status to ERROR on failure', async () => {
    const { server, getCallback } = makeMockServer();

    registerInstrumentedTool(server, 'status_tool', {}, async () => {
      throw new Error('boom');
    });

    await expect(getCallback('status_tool')!({})).rejects.toThrow();

    const { SpanStatusCode } = await import('@opentelemetry/api');
    const spans = harness.getSpans('execute_tool:status_tool');
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records exception event on the span', async () => {
    const { server, getCallback } = makeMockServer();

    registerInstrumentedTool(server, 'exc_tool', {}, async () => {
      throw new Error('exception recorded');
    });

    await expect(getCallback('exc_tool')!({})).rejects.toThrow();

    const spans = harness.getSpans('execute_tool:exc_tool');
    const hasException = spans[0].events.some((e) => e.name === 'exception');
    expect(hasException).toBe(true);
  });

  it('uses "Error" as error.type for non-Error throwables', async () => {
    const { server, getCallback } = makeMockServer();

    registerInstrumentedTool(server, 'string_throw_tool', {}, async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain string error';
    });

    await expect(getCallback('string_throw_tool')!({})).rejects.toBe('plain string error');
    await harness.flush();

    const errors = harness.getMetrics(METRIC.MCP_TOOL_ERRORS);
    expect(errors[0].attributes[ATTR.ERROR_TYPE]).toBe('Error');
  });
});

// ---------------------------------------------------------------------------
// Fault isolation — telemetry errors must not affect callback result/error
// ---------------------------------------------------------------------------

describe('registerInstrumentedTool — fault isolation', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _injectForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    await uninstallHarnessGlobally();
    _resetForTesting();
    await harness.shutdown();
  });

  it('returns the original result even when histogram.record throws', async () => {
    // Poison the meter's histogram
    const meter = harness.getMeter();
    const badHistogram = meter.createHistogram(METRIC.OPERATION_DURATION, { unit: 's' });
    const origRecord = badHistogram.record.bind(badHistogram);
    // Override the method to throw on the next call
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (badHistogram as any).record = () => { throw new Error('histogram exploded'); };
    // Restore after poisoning so other tests aren't affected
    // (We just need the wrapper to survive it — no restore needed here since
    //  each test gets a fresh harness)
    void origRecord;

    const expectedResult = { content: [{ type: 'text', text: 'survived' }] };
    const { server, getCallback } = makeMockServer();

    registerInstrumentedTool(server, 'resilient_tool', {}, async () => expectedResult);

    // Even with a poisoned histogram, the result must come through
    const result = await getCallback('resilient_tool')!({});
    expect(result).toEqual(expectedResult);
  });

  it('re-throws original error even when error-path telemetry throws', async () => {
    // Poison the error counter to throw
    const meter = harness.getMeter();
    const badCounter = meter.createCounter(METRIC.MCP_TOOL_ERRORS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (badCounter as any).add = () => { throw new Error('counter exploded'); };

    const originalError = new Error('original failure');
    const { server, getCallback } = makeMockServer();

    registerInstrumentedTool(server, 'err_resilient_tool', {}, async () => {
      throw originalError;
    });

    // The original error must still propagate, not the counter error
    await expect(getCallback('err_resilient_tool')!({})).rejects.toThrow(originalError);
  });
});
