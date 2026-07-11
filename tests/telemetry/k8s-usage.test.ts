/**
 * tests/telemetry/k8s-usage.test.ts
 *
 * Unit tests for emitK8sUsageTelemetry (issue #202) and the retry helpers
 * parseUsageOnce / readUsageWithRetry (issue #287).
 * Proves the new wiring: given a pod-mode stream-json transcript containing
 * usage events, emitK8sUsageTelemetry parses it and calls onAgentUsage with
 * correctly-mapped fields (role/model/graphId/taskId/token counts/cost).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock onAgentUsage so we can inspect calls without hitting OTel machinery.
// vi.mock is hoisted — must appear before any import that transitively uses it.
// ---------------------------------------------------------------------------
vi.mock('../../src/telemetry/domain/agent.js', () => ({
  onAgentUsage: vi.fn(),
}));

// #313-B P1 visibility counters — mock so we can assert the ok/missing +
// parsed/missing transitions without touching OTel machinery.
vi.mock('../../src/telemetry/domain/transcript.js', () => ({
  onTranscriptRead: vi.fn(),
  onCostSource: vi.fn(),
}));

// #313 gap-2 rollup feed — partial mock so the ownership-guard test can assert
// the graph accumulator is never fed on a lost claim; everything else real.
vi.mock('../../src/telemetry/domain/graph.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  onGraphAgentCost: vi.fn(),
}));

// Import the function under test AFTER the mock.
import { emitK8sUsageTelemetry, parseUsageOnce, readUsageWithRetry } from '../../src/telemetry/k8s-usage.js';
import { onAgentUsage } from '../../src/telemetry/domain/agent.js';
import { onTranscriptRead, onCostSource } from '../../src/telemetry/domain/transcript.js';
import { onGraphAgentCost } from '../../src/telemetry/domain/graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResultLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.042,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
    },
    ...overrides,
  });
}

/** A `type: "assistant"` stream-json event carrying nested message.usage + tool_use (#355). */
function makeAssistantLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_01',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }],
      usage: {
        input_tokens: 400,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function baseParams(transcriptPath: string) {
  return {
    transcriptPath,
    startedAt: Date.now() - 5000,
    taskSessionId: 'sess-abc-123',
    taskId: 'task-xyz',
    graphId: 'graph-abc',
    role: 'backend-dev',
    model: 'claude-sonnet-4-6',
    project: 'test-project',
    prefixHash: 'cafebabe1234',
  };
}

/** Instant no-op sleep for injecting into tests that expect no-usage paths. */
const noSleep = async (_ms: number) => {};

// ---------------------------------------------------------------------------
// Tests — pure helpers: parseUsageOnce / readUsageWithRetry (issue #287)
// ---------------------------------------------------------------------------

describe('parseUsageOnce', () => {
  it('returns aggregated usage when transcript contains a result event', () => {
    const content = makeResultLine() + '\n';
    const readFile = () => content;
    const result = parseUsageOnce(readFile, '/any/path', 'sess-1');
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(1000);
    expect(result!.outputTokens).toBe(500);
    expect(result!.cacheCreationInputTokens).toBe(200);
    expect(result!.cacheReadInputTokens).toBe(100);
    expect(result!.totalCostUsd).toBeCloseTo(0.042);
  });

  it('returns null when transcript has no usage events', () => {
    const readFile = () => JSON.stringify({ type: 'content_block_delta' }) + '\n';
    expect(parseUsageOnce(readFile, '/any', 'sess-1')).toBeNull();
  });

  it('returns null and does not throw when readFile throws', () => {
    const readFile = () => { throw new Error('ENOENT'); };
    expect(() => parseUsageOnce(readFile, '/missing', 'sess-1')).not.toThrow();
    expect(parseUsageOnce(readFile, '/missing', 'sess-1')).toBeNull();
  });

  it('aggregates multiple result events', () => {
    const line1 = makeResultLine({
      total_cost_usd: 0.010,
      usage: { input_tokens: 400, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const line2 = makeResultLine({
      total_cost_usd: 0.020,
      usage: { input_tokens: 600, output_tokens: 300, cache_creation_input_tokens: 50, cache_read_input_tokens: 25 },
    });
    const readFile = () => line1 + '\n' + line2 + '\n';
    const result = parseUsageOnce(readFile, '/any', 'sess-1');
    expect(result!.inputTokens).toBe(1000);
    expect(result!.cacheReadInputTokens).toBe(25);
    expect(result!.totalCostUsd).toBeCloseTo(0.030);
  });
});

describe('readUsageWithRetry', () => {
  it('fast path: returns usage immediately when transcript is complete on first call', async () => {
    const content = makeResultLine() + '\n';
    let callCount = 0;
    const readFile = () => { callCount++; return content; };
    const sleepSpy = vi.fn(noSleep);

    const result = await readUsageWithRetry(readFile, sleepSpy, '/path', 'sess-1', { maxAttempts: 5, intervalMs: 0 });

    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(1000);
    expect(callCount).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('race resolved: returns usage after N incomplete reads then one complete read', async () => {
    const incompleteContent = JSON.stringify({ type: 'system', subtype: 'init' }) + '\n';
    const completeContent = makeResultLine({
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }) + '\n';

    let callCount = 0;
    const readFile = () => {
      callCount++;
      return callCount <= 3 ? incompleteContent : completeContent;
    };
    const sleepSpy = vi.fn(noSleep);

    const result = await readUsageWithRetry(readFile, sleepSpy, '/path', 'sess-1', { maxAttempts: 10, intervalMs: 50 });

    expect(result).not.toBeNull();
    expect(result!.totalCostUsd).toBeCloseTo(0.5);
    expect(result!.inputTokens).toBe(10);
    expect(result!.outputTokens).toBe(20);
    expect(callCount).toBe(4);
    expect(sleepSpy).toHaveBeenCalledTimes(3);
  });

  it('deadline give-up: returns null after exactly maxAttempts when usage never appears', async () => {
    let callCount = 0;
    const readFile = () => { callCount++; return JSON.stringify({ type: 'system' }) + '\n'; };
    const sleepSpy = vi.fn(noSleep);

    const result = await readUsageWithRetry(readFile, sleepSpy, '/path', 'sess-1', { maxAttempts: 5, intervalMs: 10 });

    expect(result).toBeNull();
    expect(callCount).toBe(5);
    // Sleep is called between attempts: maxAttempts-1 times
    expect(sleepSpy).toHaveBeenCalledTimes(4);
  });

  it('read error tolerated: treats thrown readFile as no-usage-yet and retries', async () => {
    let callCount = 0;
    const completeContent = makeResultLine() + '\n';
    const readFile = () => {
      callCount++;
      if (callCount < 3) throw new Error('not flushed yet');
      return completeContent;
    };
    const sleepSpy = vi.fn(noSleep);

    const result = await readUsageWithRetry(readFile, sleepSpy, '/path', 'sess-1', { maxAttempts: 5, intervalMs: 0 });

    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(1000);
    expect(callCount).toBe(3);
  });

  it('read error tolerated: never throws even when readFile always throws', async () => {
    const readFile = () => { throw new Error('always broken'); };
    await expect(
      readUsageWithRetry(readFile, noSleep, '/path', 'sess-1', { maxAttempts: 3, intervalMs: 0 })
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — emitK8sUsageTelemetry (issue #202): correct field mapping
// ---------------------------------------------------------------------------

describe('emitK8sUsageTelemetry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bureau-k8s-usage-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
  });

  // ── Core wiring: correct field mapping ────────────────────────────────────

  // ── #313-B P1 visibility counters ────────────────────────────────────────

  it('emits transcript.read=usage/ok + cost.source=parsed when usage is found', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, makeResultLine() + '\n');

    await emitK8sUsageTelemetry(baseParams(transcriptPath));

    expect(onTranscriptRead).toHaveBeenCalledWith('usage', 'ok');
    expect(onCostSource).toHaveBeenCalledWith('parsed');
    expect(onTranscriptRead).not.toHaveBeenCalledWith('usage', 'missing');
    expect(onCostSource).not.toHaveBeenCalledWith('missing');
  });

  it('emits transcript.read=usage/missing + cost.source=missing when no usage is found', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }) + '\n');

    await emitK8sUsageTelemetry(baseParams(transcriptPath), { maxAttempts: 1, sleep: noSleep });

    expect(onTranscriptRead).toHaveBeenCalledWith('usage', 'missing');
    expect(onCostSource).toHaveBeenCalledWith('missing');
    expect(onCostSource).not.toHaveBeenCalledWith('parsed');
  });

  it('emits transcript.read=usage/missing when the transcript file is absent', async () => {
    await emitK8sUsageTelemetry(
      { ...baseParams('/nonexistent/path/session.log') },
      { maxAttempts: 1, sleep: noSleep },
    );

    expect(onTranscriptRead).toHaveBeenCalledWith('usage', 'missing');
    expect(onCostSource).toHaveBeenCalledWith('missing');
  });

  it('calls onAgentUsage with correctly-mapped fields from a usage event in the transcript', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, makeResultLine() + '\n');

    await emitK8sUsageTelemetry(baseParams(transcriptPath));

    expect(onAgentUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(onAgentUsage).mock.calls[0][0];
    expect(call.role).toBe('backend-dev');
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.graphId).toBe('graph-abc');
    expect(call.taskId).toBe('task-xyz');
    expect(call.project).toBe('test-project');
    expect(call.prefixHash).toBe('cafebabe1234');
    expect(call.inputTokens).toBe(1000);
    expect(call.outputTokens).toBe(500);
    expect(call.cacheCreationInputTokens).toBe(200);
    expect(call.cacheReadInputTokens).toBe(100);
    expect(call.totalCostUsd).toBeCloseTo(0.042);
    expect(call.durationMs).toBeGreaterThan(0);
  });

  it('durationMs reflects wall-clock elapsed since startedAt (not parse time)', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, makeResultLine() + '\n');

    const startedAt = Date.now() - 12_000; // 12 seconds ago
    await emitK8sUsageTelemetry({ ...baseParams(transcriptPath), startedAt });

    const call = vi.mocked(onAgentUsage).mock.calls[0][0];
    // Must be at least 12 000ms
    expect(call.durationMs).toBeGreaterThanOrEqual(12_000);
  });

  // ── Aggregation of multiple usage events ─────────────────────────────────

  it('aggregates multiple usage events from a multi-invocation transcript', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    // Two separate Claude invocations inside one agent task
    const line1 = makeResultLine({
      total_cost_usd: 0.010,
      usage: { input_tokens: 400, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const line2 = makeResultLine({
      total_cost_usd: 0.020,
      usage: { input_tokens: 600, output_tokens: 300, cache_creation_input_tokens: 50, cache_read_input_tokens: 25 },
    });
    writeFileSync(transcriptPath, line1 + '\n' + line2 + '\n');

    await emitK8sUsageTelemetry(baseParams(transcriptPath));

    expect(onAgentUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(onAgentUsage).mock.calls[0][0];
    expect(call.inputTokens).toBe(1000);          // 400 + 600
    expect(call.outputTokens).toBe(500);           // 200 + 300
    expect(call.cacheCreationInputTokens).toBe(50);
    expect(call.cacheReadInputTokens).toBe(25);
    expect(call.totalCostUsd).toBeCloseTo(0.030);  // 0.010 + 0.020
  });

  // ── Mixed-content transcripts (realistic stream-json output) ─────────────

  it('ignores non-usage lines and fires only on result events with a top-level usage key', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    const systemInit = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' });
    const textDelta = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } });
    // message_start has nested usage — should NOT trigger (no top-level "usage" key)
    const msgStart = JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 999 } } });
    const resultLine = makeResultLine({ total_cost_usd: 0.007, usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    const content = [systemInit, textDelta, msgStart, resultLine].join('\n') + '\n';
    writeFileSync(transcriptPath, content);

    await emitK8sUsageTelemetry(baseParams(transcriptPath));

    expect(onAgentUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(onAgentUsage).mock.calls[0][0];
    expect(call.inputTokens).toBe(50);
    expect(call.totalCostUsd).toBeCloseTo(0.007);
  });

  // ── Edge cases: absent / empty / no-usage transcript ─────────────────────
  // Use maxAttempts:1 + instant sleep so these tests stay fast — behavior is
  // identical (no usage found → no call), just without 20s of real sleeps.

  it('does not call onAgentUsage when transcript has no usage events', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }) + '\n');

    await emitK8sUsageTelemetry(baseParams(transcriptPath), { maxAttempts: 1, sleep: noSleep });

    expect(onAgentUsage).not.toHaveBeenCalled();
  });

  it('does not call onAgentUsage when transcript file is missing', async () => {
    await emitK8sUsageTelemetry(
      { ...baseParams('/nonexistent/path/session.log') },
      { maxAttempts: 1, sleep: noSleep },
    );

    expect(onAgentUsage).not.toHaveBeenCalled();
  });

  it('does not call onAgentUsage for an empty transcript file', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, '');

    await emitK8sUsageTelemetry(baseParams(transcriptPath), { maxAttempts: 1, sleep: noSleep });

    expect(onAgentUsage).not.toHaveBeenCalled();
  });

  // ── Fault isolation ───────────────────────────────────────────────────────

  it('never throws — resolves cleanly even for a malformed transcript', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, '{"usage": broken json\n');

    await expect(
      emitK8sUsageTelemetry(baseParams(transcriptPath), { maxAttempts: 1, sleep: noSleep })
    ).resolves.toBeUndefined();

    expect(onAgentUsage).not.toHaveBeenCalled();
  });

  // ── prefixHash is optional ────────────────────────────────────────────────

  it('passes prefixHash as undefined when not provided', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, makeResultLine() + '\n');

    const params = baseParams(transcriptPath);
    delete (params as any).prefixHash;
    await emitK8sUsageTelemetry(params);

    const call = vi.mocked(onAgentUsage).mock.calls[0][0];
    expect(call.prefixHash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// invoke_agent span ownership (#313-A)
//
// The single authoritative invoke_agent span is opened by graph-dispatch and
// handed to emitK8sUsageTelemetry, which now OWNS ending it exactly once:
//   - parse-success → end({ exitCode, cost fields })
//   - no-usage / throw → end({ exitCode }) only (costless twin)
// emitK8sUsageTelemetry no longer creates a span itself (emitCompletedAgentSpan
// is deleted).
// ---------------------------------------------------------------------------

describe('emitK8sUsageTelemetry — agent span handle ownership (#313-A)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bureau-k8s-span-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
  });

  it('ends the passed handle exactly once with cost fields on parse-success', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, makeResultLine() + '\n');

    const end = vi.fn().mockReturnValue(true);
    await emitK8sUsageTelemetry({
      ...baseParams(transcriptPath),
      agentSpanHandle: { end },
      exitCode: 0,
    });

    expect(end).toHaveBeenCalledTimes(1);
    const result = end.mock.calls[0][0];
    expect(result.exitCode).toBe(0);
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(result.cacheReadTokens).toBe(100);
    expect(result.cacheCreationTokens).toBe(200);
    expect(result.costUsd).toBeCloseTo(0.042);
    expect(result.prefixHash).toBe('cafebabe1234');
    // cacheHitRate = cacheRead / (input + cacheRead + cacheCreation) = 100 / 1300
    expect(result.cacheHitRate).toBeCloseTo(100 / 1300);

    // Metric path (#202) still fires exactly once on success.
    expect(onAgentUsage).toHaveBeenCalledTimes(1);
  });

  it('ends the handle exactly once with only exitCode when transcript has no usage', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'content_block_delta' }) + '\n');

    const end = vi.fn().mockReturnValue(true);
    await emitK8sUsageTelemetry(
      { ...baseParams(transcriptPath), agentSpanHandle: { end }, exitCode: 3 },
      { maxAttempts: 1, sleep: noSleep },
    );

    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0][0]).toEqual({ exitCode: 3 });
    expect(onAgentUsage).not.toHaveBeenCalled();
  });

  it('ends the handle exactly once with only exitCode when the parse throws', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'system' }) + '\n');

    // A throwing sleep bubbles out of readUsageWithRetry into the outer catch,
    // before any cost is computed — the finally must still end the span once.
    const badSleep = async () => { throw new Error('boom'); };
    const end = vi.fn().mockReturnValue(true);
    await emitK8sUsageTelemetry(
      { ...baseParams(transcriptPath), agentSpanHandle: { end }, exitCode: 7 },
      { maxAttempts: 2, sleep: badSleep },
    );

    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0][0]).toEqual({ exitCode: 7 });
    expect(onAgentUsage).not.toHaveBeenCalled();
  });

  it('skips ALL metric emission when the span end was lost to the cancel path (ownership guard, review-313)', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, makeResultLine() + '\n');

    // end() returning false = recordCanceledAgentUsage already ended this span
    // and accounted the agent (parsed or lost_canceled). The in-flight poll
    // resolving afterwards must not double-count anything.
    const end = vi.fn().mockReturnValue(false);
    await emitK8sUsageTelemetry({
      ...baseParams(transcriptPath),
      agentSpanHandle: { end },
      exitCode: 0,
    });

    expect(end).toHaveBeenCalledTimes(1);
    expect(onAgentUsage).not.toHaveBeenCalled();
    expect(onCostSource).not.toHaveBeenCalled();
    expect(onGraphAgentCost).not.toHaveBeenCalled();
  });

  it('resolves cleanly when no agentSpanHandle is provided (handle is optional)', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, makeResultLine() + '\n');

    await expect(
      emitK8sUsageTelemetry({ ...baseParams(transcriptPath), exitCode: 0 }),
    ).resolves.toBeUndefined();
    expect(onAgentUsage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// #355: back-dated invoke_agent.turn / invoke_agent.tool:<name> child spans
//
// emitK8sUsageTelemetry re-stamps graph/task/role from params and forwards
// the parser's turn/tool records to agentSpanHandle.emitChildSpans — purely
// additive, gated behind the same ownership claim as the rest of accounting.
// ---------------------------------------------------------------------------

describe('emitK8sUsageTelemetry — emitChildSpans wiring (#355)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bureau-k8s-childspans-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
  });

  it('calls emitChildSpans with turn/tool records extracted from the transcript, re-stamped with graph/task/role from params', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, [makeAssistantLine(), makeResultLine()].join('\n') + '\n');

    const end = vi.fn().mockReturnValue(true);
    const emitChildSpans = vi.fn();
    await emitK8sUsageTelemetry({
      ...baseParams(transcriptPath),
      agentSpanHandle: { end, emitChildSpans },
    });

    expect(emitChildSpans).toHaveBeenCalledTimes(1);
    const [turns, tools, stamp] = emitChildSpans.mock.calls[0];

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turnIndex: 0,
      inputTokens: 400,
      outputTokens: 200,
      responseModel: 'claude-sonnet-4-6',
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolName: 'Bash', callIndex: 0 });

    // Re-stamped from params, not read from the transcript.
    expect(stamp).toEqual({ graphId: 'graph-abc', taskId: 'task-xyz', role: 'backend-dev' });
  });

  it('does not call emitChildSpans when the span end was lost to the cancel path (ownership guard)', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, [makeAssistantLine(), makeResultLine()].join('\n') + '\n');

    const end = vi.fn().mockReturnValue(false);
    const emitChildSpans = vi.fn();
    await emitK8sUsageTelemetry({
      ...baseParams(transcriptPath),
      agentSpanHandle: { end, emitChildSpans },
    });

    expect(emitChildSpans).not.toHaveBeenCalled();
  });

  it('does not call emitChildSpans when the transcript has no usage', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'content_block_delta' }) + '\n');

    const end = vi.fn().mockReturnValue(true);
    const emitChildSpans = vi.fn();
    await emitK8sUsageTelemetry(
      { ...baseParams(transcriptPath), agentSpanHandle: { end, emitChildSpans } },
      { maxAttempts: 1, sleep: noSleep },
    );

    expect(emitChildSpans).not.toHaveBeenCalled();
  });

  it('never throws when agentSpanHandle has no emitChildSpans (backward-compat with plain { end } handles)', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, [makeAssistantLine(), makeResultLine()].join('\n') + '\n');

    const end = vi.fn().mockReturnValue(true);
    await expect(
      emitK8sUsageTelemetry({ ...baseParams(transcriptPath), agentSpanHandle: { end } }),
    ).resolves.toBeUndefined();
    expect(onAgentUsage).toHaveBeenCalledTimes(1);
  });

  it('still emits run-level totals and onAgentUsage correctly alongside child-span emission', async () => {
    const transcriptPath = join(tmpDir, 'session.log');
    writeFileSync(transcriptPath, [makeAssistantLine(), makeResultLine()].join('\n') + '\n');

    const end = vi.fn().mockReturnValue(true);
    const emitChildSpans = vi.fn();
    await emitK8sUsageTelemetry({
      ...baseParams(transcriptPath),
      agentSpanHandle: { end, emitChildSpans },
    });

    expect(emitChildSpans).toHaveBeenCalledTimes(1);
    expect(onAgentUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(onAgentUsage).mock.calls[0][0];
    expect(call.inputTokens).toBe(1000);
    expect(call.totalCostUsd).toBeCloseTo(0.042);
  });
});
