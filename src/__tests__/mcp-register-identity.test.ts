/**
 * Tests for §4.3 caller-identity enrichment on tool-call spans (#227 Part 1).
 *
 * Verifies that `registerInstrumentedTool` attaches `bureau.graph.id`,
 * `bureau.task.id`, and `bureau.role` to the span when a `getContext`
 * resolver is provided.
 *
 * Uses the in-memory telemetry harness so no real OTel provider is touched.
 * Follows the setup pattern of tests/telemetry/mcp-register.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../telemetry/testing.js';
import { _resetForTesting, _injectForTesting } from '../telemetry/core.js';
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { ContextResolver, ConnectionContext } from '../runtime/connection-context.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Minimal McpServer stub
// ---------------------------------------------------------------------------

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
  return { server, getCallback: (name) => callbacks.get(name) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolver(ctx: Partial<ConnectionContext>): ContextResolver {
  const full: ConnectionContext = {
    sessionId: ctx.sessionId ?? 'test-session',
    graphId: ctx.graphId,
    taskId: ctx.taskId,
    role: ctx.role,
    loadout: 'full',
  };
  return () => full;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerInstrumentedTool — caller-identity span attributes (#227 Part 1)', () => {
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

  it('attaches graphId, taskId, and role to the span when getContext is provided', async () => {
    const { server, getCallback } = makeMockServer();

    const resolver = makeResolver({
      graphId: 'graph-abc-123',
      taskId: 'task-xyz-789',
      role: 'coder',
    });

    registerInstrumentedTool(
      server,
      'test_tool',
      { description: 'A test tool' },
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      resolver,
    );

    await getCallback('test_tool')!({}, { sessionId: 'test-session' });

    const spans = harness.getSpans('execute_tool:test_tool');
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.attributes['bureau.graph.id']).toBe('graph-abc-123');
    expect(span.attributes['bureau.task.id']).toBe('task-xyz-789');
    expect(span.attributes['bureau.role']).toBe('coder');
    // Standard attrs must still be present
    expect(span.attributes['gen_ai.tool.name']).toBe('test_tool');
    expect(span.attributes['gen_ai.operation.name']).toBe('execute_tool');
  });

  it('does NOT set graphId/taskId/role on span when getContext is absent', async () => {
    const { server, getCallback } = makeMockServer();

    // No getContext passed — 5th arg omitted
    registerInstrumentedTool(
      server,
      'anon_tool',
      { description: 'Tool without context' },
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    );

    await getCallback('anon_tool')!({}, { sessionId: 'test-session' });

    const spans = harness.getSpans('execute_tool:anon_tool');
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.attributes['bureau.graph.id']).toBeUndefined();
    expect(span.attributes['bureau.task.id']).toBeUndefined();
    expect(span.attributes['bureau.role']).toBeUndefined();
    // Standard attrs still present
    expect(span.attributes['gen_ai.tool.name']).toBe('anon_tool');
  });

  it('omits graphId/taskId attributes when the context does not have them', async () => {
    const { server, getCallback } = makeMockServer();

    // Resolver that returns a context without graphId/taskId (orchestrator in stdio mode)
    const resolver = makeResolver({ role: 'coder' });

    registerInstrumentedTool(
      server,
      'orch_tool',
      { description: 'Orchestrator tool' },
      async () => ({ content: [{ type: 'text' as const, text: 'done' }] }),
      resolver,
    );

    await getCallback('orch_tool')!({}, { sessionId: 'orch-session' });

    const spans = harness.getSpans('execute_tool:orch_tool');
    expect(spans).toHaveLength(1);

    const span = spans[0];
    // graphId/taskId absent from context → must not appear on span
    expect(span.attributes['bureau.graph.id']).toBeUndefined();
    expect(span.attributes['bureau.task.id']).toBeUndefined();
    // role IS present
    expect(span.attributes['bureau.role']).toBe('coder');
  });

  it('graphId and taskId are span-only — NOT present as metric labels on the duration histogram', async () => {
    const { server, getCallback } = makeMockServer();

    const resolver = makeResolver({
      graphId: 'graph-metric-test',
      taskId: 'task-metric-test',
      role: 'tester',
    });

    registerInstrumentedTool(
      server,
      'metric_tool',
      { description: 'Metric cardinality test tool' },
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      resolver,
    );

    await getCallback('metric_tool')!({}, { sessionId: 'test-session' });

    await harness.flush();
    const metrics = harness.getMetrics('gen_ai.client.operation.duration');
    expect(metrics.length).toBeGreaterThan(0);

    for (const m of metrics) {
      // High-cardinality IDs must NOT appear on metric label sets
      expect(Object.keys(m.attributes)).not.toContain('bureau.graph.id');
      expect(Object.keys(m.attributes)).not.toContain('bureau.task.id');
    }
  });
});
