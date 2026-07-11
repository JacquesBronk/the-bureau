import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR } from '../../../src/telemetry/schema.js';
import { _resetForTesting, _injectForTesting } from '../../../src/telemetry/core.js';
import {
  wrapMcpToolHandler,
  type McpToolHandler,
} from '../../../src/telemetry/instrumentation/mcp-tool.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Minimal test shapes — no real MCP server needed
// ---------------------------------------------------------------------------

function makeRequest(
  name: string,
  args?: Record<string, unknown>,
): CallToolRequest {
  return {
    method: 'tools/call',
    params: { name, arguments: args },
  } as unknown as CallToolRequest;
}

function makeResult(text = 'ok'): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

// ---------------------------------------------------------------------------
// Disabled path — must NOT require a harness or any OTel setup
// ---------------------------------------------------------------------------

describe('wrapMcpToolHandler — disabled path', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
  });

  it('returns the original handler unchanged when OTel is not initialized', () => {
    const h: McpToolHandler = () => Promise.resolve(makeResult());
    expect(wrapMcpToolHandler(h)).toBe(h);
  });
});

// ---------------------------------------------------------------------------
// Enabled path — all tests share a harness installed globally
// ---------------------------------------------------------------------------

describe('wrapMcpToolHandler — enabled path', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    _resetForTesting();
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    // Inject harness meter/tracer into core.ts so getMeter()/getTracer() return non-null
    _injectForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();
    // Restore env to clean state
    delete process.env.BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS;
  });

  // ── Span attributes ───────────────────────────────────────────────────────

  it('success call produces span named execute_tool:<toolName>', async () => {
    const handler: McpToolHandler = async () => makeResult();
    const wrapped = wrapMcpToolHandler(handler);

    await wrapped(makeRequest('ping'));

    const spans = harness.getSpans('execute_tool:ping');
    expect(spans).toHaveLength(1);
  });

  it('success span carries gen_ai.operation.name="execute_tool"', async () => {
    const handler: McpToolHandler = async () => makeResult();
    const wrapped = wrapMcpToolHandler(handler);

    await wrapped(makeRequest('get_status'));

    const spans = harness.getSpans('execute_tool:get_status');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.OPERATION_NAME]).toBe('execute_tool');
  });

  it('success span carries gen_ai.tool.name=<toolName>', async () => {
    const handler: McpToolHandler = async () => makeResult();
    const wrapped = wrapMcpToolHandler(handler);

    await wrapped(makeRequest('check_messages'));

    const spans = harness.getSpans('execute_tool:check_messages');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.TOOL_NAME]).toBe('check_messages');
  });

  it('success span carries code.function.name=<toolName> (#219 code provenance)', async () => {
    const handler: McpToolHandler = async () => makeResult();
    const wrapped = wrapMcpToolHandler(handler);

    await wrapped(makeRequest('declare_task_graph'));

    const spans = harness.getSpans('execute_tool:declare_task_graph');
    expect(spans).toHaveLength(1);
    // Non-empty code.function.name unblocks quipu's `{code.function.name=~".+"}`
    // Tempo query → source-symbol link (#219).
    expect(spans[0].attributes[ATTR.CODE_FUNCTION_NAME]).toBe('declare_task_graph');
  });

  // ── Duration histogram ────────────────────────────────────────────────────

  it('duration histogram records a value > 0 after a success call', async () => {
    const handler: McpToolHandler = async () => {
      // Small async work to ensure non-zero duration
      await new Promise((r) => setTimeout(r, 5));
      return makeResult();
    };
    const wrapped = wrapMcpToolHandler(handler);

    await wrapped(makeRequest('slow_tool'));
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.OPERATION_DURATION);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBeGreaterThan(0);
  });

  // ── Error path ────────────────────────────────────────────────────────────

  it('failure increments bureau.mcp_tool.errors with matching error.type', async () => {
    const boom = new Error('kaboom');
    boom.name = 'NetworkError'; // custom name
    const handler: McpToolHandler = async () => {
      throw boom;
    };
    const wrapped = wrapMcpToolHandler(handler);

    await expect(wrapped(makeRequest('flaky'))).rejects.toThrow('kaboom');
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.MCP_TOOL_ERRORS);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const errorMetric = metrics.find(
      (m) => m.attributes[ATTR.TOOL_NAME] === 'flaky',
    );
    expect(errorMetric).toBeDefined();
    expect(errorMetric!.attributes[ATTR.ERROR_TYPE]).toBe('NetworkError');
    expect(errorMetric!.value).toBe(1);
  });

  it('failure sets span status ERROR', async () => {
    const { SpanStatusCode } = await import('@opentelemetry/api');
    const handler: McpToolHandler = async () => {
      throw new Error('oops');
    };
    const wrapped = wrapMcpToolHandler(handler);

    await expect(wrapped(makeRequest('bad_tool'))).rejects.toThrow('oops');

    const spans = harness.getSpans('execute_tool:bad_tool');
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('failure re-throws the original error unchanged', async () => {
    const original = new TypeError('type mismatch');
    const handler: McpToolHandler = async () => {
      throw original;
    };
    const wrapped = wrapMcpToolHandler(handler);

    const caught = await wrapped(makeRequest('type_tool')).catch((e) => e);
    expect(caught).toBe(original);
  });

  // ── Tool argument capture ─────────────────────────────────────────────────

  it('tool arguments are NOT captured on the span by default', async () => {
    delete process.env.BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS;
    const handler: McpToolHandler = async () => makeResult();
    const wrapped = wrapMcpToolHandler(handler);

    await wrapped(makeRequest('secret_tool', { token: 'super-secret' }));

    const spans = harness.getSpans('execute_tool:secret_tool');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['bureau.mcp_tool.args_json']).toBeUndefined();
  });

  it('tool arguments are captured when BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS=1', async () => {
    process.env.BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS = '1';
    const args = { graph_id: 'abc123', depth: 3 };
    const handler: McpToolHandler = async () => makeResult();
    const wrapped = wrapMcpToolHandler(handler);

    await wrapped(makeRequest('declare_task_graph', args));

    const spans = harness.getSpans('execute_tool:declare_task_graph');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['bureau.mcp_tool.args_json']).toBe(
      JSON.stringify(args),
    );

    // Clean up so it doesn't leak into subsequent tests
    delete process.env.BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS;
  });

  it('captured args are truncated to 1024 chars', async () => {
    process.env.BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS = '1';
    const longString = 'x'.repeat(2000);
    const handler: McpToolHandler = async () => makeResult();
    const wrapped = wrapMcpToolHandler(handler);

    await wrapped(makeRequest('big_tool', { data: longString }));

    const spans = harness.getSpans('execute_tool:big_tool');
    expect(spans).toHaveLength(1);
    const captured = spans[0].attributes['bureau.mcp_tool.args_json'] as string;
    expect(captured.length).toBeLessThanOrEqual(1024);

    delete process.env.BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS;
  });

  // ── Child spans ───────────────────────────────────────────────────────────

  it('child spans from inner handler are parented to execute_tool span', async () => {
    const handler: McpToolHandler = async () => {
      const { trace } = await import('@opentelemetry/api');
      const innerTracer = trace.getTracer('the-bureau');
      return new Promise<CallToolResult>((resolve) => {
        innerTracer.startActiveSpan('inner-op', (span) => {
          span.end();
          resolve(makeResult());
        });
      });
    };

    const wrapped = wrapMcpToolHandler(handler);
    await wrapped(makeRequest('nested_tool'));

    const tree = harness.getSpanTree('execute_tool:nested_tool');
    expect(tree).not.toBeNull();
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0].name).toBe('inner-op');
  });
});
