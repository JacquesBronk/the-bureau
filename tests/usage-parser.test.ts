import { describe, it, expect, vi } from "vitest";
import { UsageParser, type UsageData } from "../src/usage-parser.js";

function makeResultLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 500,
      output_tokens: 200,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 50,
    },
    ...overrides,
  });
}

/** A `type: "assistant"` stream-json event carrying nested message.usage (#355). */
function makeAssistantLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_01",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "working on it" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    },
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("UsageParser", () => {
  describe("processChunk — valid usage event", () => {
    it("fires callback with correct UsageData from a complete result line", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-abc", onUsage);

      parser.processChunk(makeResultLine() + "\n");

      expect(onUsage).toHaveBeenCalledTimes(1);
      const data: UsageData = onUsage.mock.calls[0][0];
      expect(data.sessionId).toBe("session-abc");
      expect(data.inputTokens).toBe(500);
      expect(data.outputTokens).toBe(200);
      expect(data.cacheCreationInputTokens).toBe(100);
      expect(data.cacheReadInputTokens).toBe(50);
      expect(data.totalCostUsd).toBe(0.0123);
      expect(data.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("includes durationMs as a non-negative number", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-xyz", onUsage);
      parser.processChunk(makeResultLine() + "\n");
      const data: UsageData = onUsage.mock.calls[0][0];
      expect(data.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("processChunk — non-usage lines are skipped", () => {
    it("does not fire callback for text_delta events", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-1", onUsage);
      const textDelta = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } });
      parser.processChunk(textDelta + "\n");
      expect(onUsage).not.toHaveBeenCalled();
    });

    it("does not fire callback for system init events", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-1", onUsage);
      const systemInit = JSON.stringify({ type: "system", subtype: "init", session_id: "abc" });
      parser.processChunk(systemInit + "\n");
      expect(onUsage).not.toHaveBeenCalled();
    });

    it("does not fire callback for assistant message_start events, and does not surface a turn/tool record either (#355)", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-1", onUsage);
      // message_start has usage but it's input token counting, not the final result
      // This line contains '"usage"' so will be parsed — but we still test it fires
      // correctly for lines that have usage in a non-result context
      const msgStart = JSON.stringify({
        type: "message_start",
        message: { id: "msg_01", usage: { input_tokens: 10, output_tokens: 0 } },
      });
      // message_start has '"usage"' nested inside — parser will parse it.
      // The top-level "usage" key will be absent, so callback must NOT fire.
      // Its type is "message_start", not "assistant", so the per-turn extraction
      // path (#355) must also ignore it — only real "assistant" events surface
      // turn/tool records.
      parser.processChunk(msgStart + "\n");
      expect(onUsage).not.toHaveBeenCalled();
      expect(parser.getTurnRecords()).toEqual([]);
      expect(parser.getToolCallRecords()).toEqual([]);
    });
  });

  describe("processChunk — split chunks", () => {
    it("handles a result line split across two chunks", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-split", onUsage);
      const line = makeResultLine() + "\n";
      const mid = Math.floor(line.length / 2);
      parser.processChunk(line.slice(0, mid));
      expect(onUsage).not.toHaveBeenCalled();
      parser.processChunk(line.slice(mid));
      expect(onUsage).toHaveBeenCalledTimes(1);
    });

    it("handles result line split into many small chunks", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-chunks", onUsage);
      const line = makeResultLine() + "\n";
      for (const char of line) {
        parser.processChunk(char);
      }
      expect(onUsage).toHaveBeenCalledTimes(1);
    });

    it("handles multiple lines in a single chunk, firing only for the usage line", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-multi", onUsage);
      const textDelta = JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } });
      const combined = textDelta + "\n" + makeResultLine() + "\n";
      parser.processChunk(combined);
      expect(onUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe("processChunk — malformed JSON", () => {
    it("does not throw on malformed JSON that contains '\"usage\"'", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-bad", onUsage);
      expect(() => parser.processChunk('{"usage": broken json}\n')).not.toThrow();
      expect(onUsage).not.toHaveBeenCalled();
    });
  });

  describe("processChunk — usage in text content, not top-level", () => {
    it("does not fire callback when '\"usage\"' appears only in nested text, not as top-level key", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-fake", onUsage);
      // A line where "usage" appears in text content but top-level usage key is absent
      const fakeLine = JSON.stringify({
        type: "content_block_delta",
        delta: { text: 'monitor "usage" metrics carefully' },
      });
      parser.processChunk(fakeLine + "\n");
      // includes('"usage"') matches, so JSON.parse is called — but no top-level usage object
      expect(onUsage).not.toHaveBeenCalled();
    });
  });

  describe("getTurnRecords / getToolCallRecords — per-turn and per-tool extraction (#355)", () => {
    it("surfaces one turn record per assistant event with the four token counts, model, and timestamp", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-turn", onUsage);
      parser.processChunk(makeAssistantLine() + "\n");

      const turns = parser.getTurnRecords();
      expect(turns).toHaveLength(1);
      expect(turns[0].turnIndex).toBe(0);
      expect(turns[0].inputTokens).toBe(100);
      expect(turns[0].outputTokens).toBe(50);
      expect(turns[0].cacheCreationInputTokens).toBe(10);
      expect(turns[0].cacheReadInputTokens).toBe(5);
      expect(turns[0].responseModel).toBe("claude-sonnet-4-6");
      expect(turns[0].timestamp).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
      // The run-level total path is untouched — no result event yet, no fire.
      expect(onUsage).not.toHaveBeenCalled();
    });

    it("falls back to parse-time wall clock when the event has no timestamp field", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-no-ts", onUsage);
      const before = Date.now();
      const line = JSON.parse(makeAssistantLine());
      delete line.timestamp;
      parser.processChunk(JSON.stringify(line) + "\n");
      const after = Date.now();

      const turns = parser.getTurnRecords();
      expect(turns).toHaveLength(1);
      expect(turns[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(turns[0].timestamp).toBeLessThanOrEqual(after);
    });

    it("extracts tool_use blocks from an assistant turn's content, defaulting start/end to the enclosing turn's timestamp", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-tool", onUsage);
      const line = makeAssistantLine({
        message: {
          id: "msg_01",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 },
        },
      });
      parser.processChunk(line + "\n");

      const tools = parser.getToolCallRecords();
      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe("Bash");
      expect(tools[0].callIndex).toBe(0);
      const expectedTs = Date.parse("2026-01-01T00:00:00.000Z");
      expect(tools[0].startTimestamp).toBe(expectedTs);
      expect(tools[0].endTimestamp).toBe(expectedTs);
    });

    it("ignores non-tool_use content blocks (text) — no tool record is created for them", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-text-only", onUsage);
      parser.processChunk(makeAssistantLine() + "\n"); // content is a single text block
      expect(parser.getToolCallRecords()).toEqual([]);
      expect(parser.getTurnRecords()).toHaveLength(1);
    });

    it("extracts per-turn and per-tool records from a multi-turn, multi-tool transcript, preserving order, and the run-level total remains the authoritative aggregate from the final result event", () => {
      const onUsage = vi.fn();
      const parser = new UsageParser("session-multi-turn", onUsage);

      const turn1 = makeAssistantLine({
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          id: "msg_01",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
          usage: { input_tokens: 400, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
      const toolResult1 = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
      });
      const turn2 = makeAssistantLine({
        timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          id: "msg_02",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "/a" } },
            { type: "tool_use", id: "tu_3", name: "Edit", input: { file_path: "/a" } },
          ],
          usage: { input_tokens: 600, output_tokens: 300, cache_creation_input_tokens: 50, cache_read_input_tokens: 25 },
        },
      });
      const result = makeResultLine({
        total_cost_usd: 0.030,
        usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 50, cache_read_input_tokens: 25 },
      });

      parser.processChunk([turn1, toolResult1, turn2, result].join("\n") + "\n");

      // Per-turn records (#355): 2 turns, correct fields and ordering.
      const turns = parser.getTurnRecords();
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({ turnIndex: 0, inputTokens: 400, outputTokens: 200 });
      expect(turns[1]).toMatchObject({ turnIndex: 1, inputTokens: 600, outputTokens: 300, cacheCreationInputTokens: 50, cacheReadInputTokens: 25 });
      expect(turns[0].timestamp).toBeLessThan(turns[1].timestamp);

      // Per-tool records (#355): 3 tool calls across the 2 turns, correct ordering.
      const tools = parser.getToolCallRecords();
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => ({ name: t.toolName, callIndex: t.callIndex }))).toEqual([
        { name: "Bash", callIndex: 0 },
        { name: "Read", callIndex: 1 },
        { name: "Edit", callIndex: 2 },
      ]);
      // Tools from turn2 share turn2's timestamp (start/end fallback rule).
      expect(tools[1].startTimestamp).toBe(turns[1].timestamp);
      expect(tools[2].startTimestamp).toBe(turns[1].timestamp);

      // Run-level total (existing, authoritative path) fires exactly once, from
      // the final result event only — untouched by the new per-turn surfacing.
      expect(onUsage).toHaveBeenCalledTimes(1);
      const data: UsageData = onUsage.mock.calls[0][0];
      expect(data.inputTokens).toBe(1000);
      expect(data.outputTokens).toBe(500);
      expect(data.totalCostUsd).toBeCloseTo(0.030);
    });
  });
});
