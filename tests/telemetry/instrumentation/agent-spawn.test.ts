/**
 * tests/telemetry/instrumentation/agent-spawn.test.ts
 *
 * Tests for src/telemetry/instrumentation/agent-spawn.ts.
 * Uses the in-memory harness — no Redis, no Docker required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR } from '../../../src/telemetry/schema.js';
import {
  beginAgentSpan,
  recordSpawnFailure,
  _initForTesting,
  _initFromCore,
  _resetForTesting,
  type SpawnedAgentInfo,
  type AgentEndResult,
} from '../../../src/telemetry/instrumentation/agent-spawn.js';
import { _injectForTesting as coreInject, _resetForTesting as coreReset } from '../../../src/telemetry/core.js';
import type { TurnUsageRecord, ToolCallRecord } from '../../../src/usage-parser.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TEST_INFO: SpawnedAgentInfo = {
  role: 'coder',
  taskId: 'task-abc',
  graphId: 'graph-xyz',
  model: 'claude-sonnet-4-6',
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('agent-spawn instrumentation', () => {
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

  // ── §4.4 beginAgentSpan — span creation ─────────────────────────────────

  describe('beginAgentSpan — span start attributes', () => {
    it('produces an invoke_agent span with the six start-time attributes', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});

      const spans = harness.getSpans('invoke_agent');
      expect(spans).toHaveLength(1);

      const attrs = spans[0].attributes;
      expect(attrs[ATTR.OPERATION_NAME]).toBe('invoke_agent');
      expect(attrs[ATTR.PROVIDER_NAME]).toBe('anthropic');
      expect(attrs[ATTR.REQUEST_MODEL]).toBe('claude-sonnet-4-6');
      expect(attrs[ATTR.ROLE]).toBe('coder');
      expect(attrs[ATTR.TASK_ID]).toBe('task-abc');
      expect(attrs[ATTR.GRAPH_ID]).toBe('graph-xyz');
    });

    it('omits gen_ai.request.model when info.model is undefined', async () => {
      const handle = await beginAgentSpan({ role: 'planner', taskId: 't1', graphId: 'g1' });
      handle.end({});

      const spans = harness.getSpans('invoke_agent');
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes[ATTR.REQUEST_MODEL]).toBeUndefined();
    });

    it('carries code.function.name="invoke_agent" for source-symbol linkage (#219)', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});

      const spans = harness.getSpans('invoke_agent');
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes[ATTR.CODE_FUNCTION_NAME]).toBe('invoke_agent');
    });

    it('sets bureau.task.attempt="2" as a low-cardinality string when info.attempt is present (#317)', async () => {
      const handle = await beginAgentSpan({ ...TEST_INFO, attempt: 2 });
      handle.end({});

      const spans = harness.getSpans('invoke_agent');
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[ATTR.TASK_ATTEMPT]).toBe('2');
      expect(typeof attrs[ATTR.TASK_ATTEMPT]).toBe('string');
      // Distinct concept from bureau.graph.id — attempt is bounded/low-cardinality,
      // graph.id is high-cardinality and must never leak into a low-cardinality attribute.
      expect(attrs[ATTR.TASK_ATTEMPT]).not.toBe(attrs[ATTR.GRAPH_ID]);
    });

    it('omits bureau.task.attempt when info.attempt is undefined', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});

      const spans = harness.getSpans('invoke_agent');
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes[ATTR.TASK_ATTEMPT]).toBeUndefined();
    });

    it('sets bureau.task.attempt="0" for the initial attempt (falsy but defined)', async () => {
      const handle = await beginAgentSpan({ ...TEST_INFO, attempt: 0 });
      handle.end({});

      const spans = harness.getSpans('invoke_agent');
      expect(spans[0].attributes[ATTR.TASK_ATTEMPT]).toBe('0');
    });
  });

  // ── §4.4 handle.end — span end-time attribute population ────────────────

  describe('handle.end — end-time attributes', () => {
    it('populates usage and cost attributes on span end', async () => {
      const result: AgentEndResult = {
        responseModel: 'claude-sonnet-4-6',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheCreationTokens: 100,
        costUsd: 0.0042,
        prefixHash: 'abc123',
        cacheHitRate: 0.333,
        exitCode: 0,
      };

      const handle = await beginAgentSpan(TEST_INFO);
      handle.end(result);

      const spans = harness.getSpans('invoke_agent');
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;

      expect(attrs[ATTR.RESPONSE_MODEL]).toBe('claude-sonnet-4-6');
      expect(attrs['gen_ai.usage.input_tokens']).toBe(1000);
      expect(attrs['gen_ai.usage.output_tokens']).toBe(200);
      expect(attrs['gen_ai.usage.cache_read_input_tokens']).toBe(500);
      expect(attrs['gen_ai.usage.cache_creation_input_tokens']).toBe(100);
      expect(attrs['bureau.agent.cost_usd']).toBe(0.0042);
      expect(attrs['bureau.agent.prefix_hash']).toBe('abc123');
      expect(attrs['bureau.agent.cache_hit_rate']).toBeCloseTo(0.333);
      expect(attrs['bureau.task.exit_code']).toBe(0);
    });

    it('partial result — only defined fields are set', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({ inputTokens: 50 });

      const spans = harness.getSpans('invoke_agent');
      const attrs = spans[0].attributes;
      expect(attrs['gen_ai.usage.input_tokens']).toBe(50);
      expect(attrs['gen_ai.usage.output_tokens']).toBeUndefined();
    });

    it('span is ended (durationMs >= 0)', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});
      const tree = harness.getSpanTree('invoke_agent');
      expect(tree).not.toBeNull();
      expect(tree!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('is idempotent — a second end() applies attrs and ends the span only once (#313)', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({ inputTokens: 111 });
      // Second end must be a mechanical no-op: OTel silently drops attrs set
      // after span.end(), so the guard must reject it before touching the span.
      handle.end({ inputTokens: 999, outputTokens: 42 });

      const spans = harness.getSpans('invoke_agent');
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs['gen_ai.usage.input_tokens']).toBe(111);
      expect(attrs['gen_ai.usage.output_tokens']).toBeUndefined();
    });
  });

  // ── #355 emitChildSpans — per-turn/per-tool child spans ─────────────────

  describe('handle.emitChildSpans — per-turn/per-tool child spans (#355)', () => {
    const TURN: TurnUsageRecord = {
      turnIndex: 0,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
      responseModel: 'claude-sonnet-4-6',
      timestamp: 1_700_000_000_000,
    };
    const TOOL: ToolCallRecord = {
      toolName: 'Bash',
      callIndex: 0,
      startTimestamp: 1_700_000_000_000,
      endTimestamp: 1_700_000_000_000,
    };
    const STAMP = { graphId: 'graph-xyz', taskId: 'task-abc', role: 'coder' };

    it('creates invoke_agent.turn and invoke_agent.tool:<name> as children of invoke_agent', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});
      handle.emitChildSpans?.([TURN], [TOOL], STAMP);

      const tree = harness.getSpanTree('invoke_agent');
      expect(tree).not.toBeNull();
      expect(tree!.children).toHaveLength(2);
      expect(tree!.children.map((c) => c.name).sort()).toEqual([
        'invoke_agent.tool:Bash',
        'invoke_agent.turn',
      ]);
    });

    it('stamps the pinned turn attributes, including re-stamped graph/task/role', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});
      handle.emitChildSpans?.([TURN], [], STAMP);

      const turnSpan = harness.getSpanTree('invoke_agent')!.children[0];
      expect(turnSpan.name).toBe('invoke_agent.turn');
      expect(turnSpan.attributes[ATTR.TURN_INDEX]).toBe(0);
      expect(turnSpan.attributes['gen_ai.usage.input_tokens']).toBe(100);
      expect(turnSpan.attributes['gen_ai.usage.output_tokens']).toBe(50);
      expect(turnSpan.attributes['gen_ai.usage.cache_read_input_tokens']).toBe(5);
      expect(turnSpan.attributes['gen_ai.usage.cache_creation_input_tokens']).toBe(10);
      expect(turnSpan.attributes[ATTR.RESPONSE_MODEL]).toBe('claude-sonnet-4-6');
      expect(turnSpan.attributes[ATTR.GRAPH_ID]).toBe('graph-xyz');
      expect(turnSpan.attributes[ATTR.TASK_ID]).toBe('task-abc');
      expect(turnSpan.attributes[ATTR.ROLE]).toBe('coder');
    });

    it('stamps the pinned tool attributes with source="worker-transcript" (disambiguates from execute_tool spans)', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});
      handle.emitChildSpans?.([], [TOOL], STAMP);

      const toolSpan = harness.getSpanTree('invoke_agent')!.children[0];
      expect(toolSpan.name).toBe('invoke_agent.tool:Bash');
      expect(toolSpan.attributes[ATTR.BUREAU_TOOL_NAME]).toBe('Bash');
      expect(toolSpan.attributes[ATTR.TOOL_SOURCE]).toBe('worker-transcript');
      expect(toolSpan.attributes[ATTR.TOOL_CALL_INDEX]).toBe(0);
      expect(toolSpan.attributes[ATTR.GRAPH_ID]).toBe('graph-xyz');
      expect(toolSpan.attributes[ATTR.TASK_ID]).toBe('task-abc');
      expect(toolSpan.attributes[ATTR.ROLE]).toBe('coder');
    });

    it('back-dates child spans to zero duration at the transcript timestamp', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});
      handle.emitChildSpans?.([TURN], [TOOL], STAMP);

      const tree = harness.getSpanTree('invoke_agent')!;
      for (const child of tree.children) {
        expect(child.durationMs).toBe(0);
      }
    });

    it('emits one child span per record, preserving turnIndex/callIndex ordering for multi-turn/multi-tool runs', async () => {
      const turn2: TurnUsageRecord = { ...TURN, turnIndex: 1, timestamp: TURN.timestamp + 5000 };
      const tool2: ToolCallRecord = { ...TOOL, toolName: 'Read', callIndex: 1 };

      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});
      handle.emitChildSpans?.([TURN, turn2], [TOOL, tool2], STAMP);

      const tree = harness.getSpanTree('invoke_agent')!;
      expect(tree.children).toHaveLength(4);
      const turnSpans = tree.children.filter((c) => c.name === 'invoke_agent.turn');
      expect(turnSpans.map((s) => s.attributes[ATTR.TURN_INDEX]).sort()).toEqual([0, 1]);
      const toolSpans = tree.children.filter((c) => c.name.startsWith('invoke_agent.tool:'));
      expect(toolSpans.map((s) => s.attributes[ATTR.TOOL_CALL_INDEX]).sort()).toEqual([0, 1]);
    });

    it('does not throw and emits nothing when both records arrays are empty', async () => {
      const handle = await beginAgentSpan(TEST_INFO);
      handle.end({});
      expect(() => handle.emitChildSpans?.([], [], STAMP)).not.toThrow();

      const tree = harness.getSpanTree('invoke_agent')!;
      expect(tree.children).toHaveLength(0);
    });
  });

  // ── §4.4 recordSpawnFailure ──────────────────────────────────────────────

  describe('recordSpawnFailure', () => {
    it('increments bureau.spawn.failures with reason=ptySpawn', async () => {
      recordSpawnFailure('ptySpawn', { role: 'coder', graphId: 'g1' });
      await harness.flush();

      const failures = harness.getMetrics(METRIC.SPAWN_FAILURES);
      expect(failures).toHaveLength(1);
      expect(failures[0].value).toBe(1);
      expect(failures[0].attributes[ATTR.REASON]).toBe('ptySpawn');
    });

    it('increments bureau.spawn.failures with reason=prepareWorktree', async () => {
      recordSpawnFailure('prepareWorktree', {});
      await harness.flush();

      const failures = harness.getMetrics(METRIC.SPAWN_FAILURES);
      expect(failures[0].attributes[ATTR.REASON]).toBe('prepareWorktree');
    });

    it('multiple failures accumulate', async () => {
      recordSpawnFailure('ptySpawn', {});
      recordSpawnFailure('ptySpawn', {});
      await harness.flush();

      const failures = harness.getMetrics(METRIC.SPAWN_FAILURES);
      const total = failures.reduce((s, m) => s + m.value, 0);
      expect(total).toBe(2);
    });
  });

});

// ---------------------------------------------------------------------------
// Disabled path — no harness installed
// ---------------------------------------------------------------------------

describe('agent-spawn instrumentation — disabled path', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
  });

  it('beginAgentSpan returns a no-op handle when OTel is not initialized', async () => {
    const handle = await beginAgentSpan(TEST_INFO);
    expect(() => handle.end({})).not.toThrow();
  });

  it('emitChildSpans on the no-op handle does not throw when OTel is not initialized (#355)', async () => {
    const handle = await beginAgentSpan(TEST_INFO);
    handle.end({});
    expect(() =>
      handle.emitChildSpans?.(
        [{ turnIndex: 0, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, timestamp: 0 }],
        [{ toolName: 'Bash', callIndex: 0, startTimestamp: 0, endTimestamp: 0 }],
        { graphId: 'g1', taskId: 't1', role: 'coder' },
      ),
    ).not.toThrow();
  });

  it('recordSpawnFailure does not throw when OTel is not initialized', () => {
    expect(() => recordSpawnFailure('ptySpawn', { role: 'coder' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fault isolation
// ---------------------------------------------------------------------------

describe('agent-spawn instrumentation — fault isolation', () => {
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

  it('multiple handle.end calls do not throw (span already ended)', async () => {
    const handle = await beginAgentSpan(TEST_INFO);
    handle.end({});
    expect(() => handle.end({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// _initFromCore — production initializer path
// ---------------------------------------------------------------------------

describe('_initFromCore', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    coreReset();
    _resetForTesting();
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
  });

  afterEach(async () => {
    _resetForTesting();
    coreReset();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('picks up meter and tracer from core, enabling spawn failure counter', async () => {
    coreInject(harness.getMeter(), harness.getTracer());
    _initFromCore();

    recordSpawnFailure('pty_spawn', { role: 'coder', taskId: 't1', graphId: 'g1' });
    await harness.flush();

    const failures = harness.getMetrics(METRIC.SPAWN_FAILURES);
    expect(failures).toHaveLength(1);
    expect(failures[0].value).toBe(1);
    expect(failures[0].attributes[ATTR.REASON]).toBe('pty_spawn');
  });

  it('is a no-op when core has no meter (OTel disabled)', () => {
    expect(() => _initFromCore()).not.toThrow();
    expect(() => recordSpawnFailure('pty_spawn', {})).not.toThrow();
  });
});
