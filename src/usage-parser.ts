export interface UsageData {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  durationMs: number;
}

/** One assistant turn's token usage, recovered from a `type: "assistant"` transcript event (#355). */
export interface TurnUsageRecord {
  /** 0-based index over all assistant turns seen by this parser instance. */
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  responseModel?: string;
  /** Epoch ms — from the event's `timestamp` field when present, else parse-time wall clock. */
  timestamp: number;
}

/** One `tool_use` content block, recovered from within an assistant turn (#355). */
export interface ToolCallRecord {
  toolName: string;
  /** 0-based index over all tool calls seen by this parser instance. */
  callIndex: number;
  /**
   * Transcript tool_use blocks carry no independent timestamp of their own —
   * only the enclosing assistant turn does. Both start and end default to
   * that turn's timestamp (a zero-duration reconstruction), per the wire
   * contract's documented fallback (#355).
   */
  startTimestamp: number;
  endTimestamp: number;
}

/**
 * Extracts token usage data from Claude's --output-format stream-json JSONL output.
 * Designed to be driven by PTY onData callbacks — chunks may split across lines.
 * Fires the onUsage callback exactly once per session, on the final result event.
 *
 * Also accumulates per-turn and per-tool records (#355) as a side channel —
 * available via getTurnRecords()/getToolCallRecords() after processing. This
 * is purely additive: the onUsage run-level total path is unchanged.
 */
export class UsageParser {
  private buffer = "";
  private readonly startedAt: number;

  private readonly turnRecords: TurnUsageRecord[] = [];
  private readonly toolCallRecords: ToolCallRecord[] = [];
  private turnIndex = 0;
  private toolCallIndex = 0;

  constructor(
    private readonly sessionId: string,
    private readonly onUsage: (data: UsageData) => void,
  ) {
    this.startedAt = Date.now();
  }

  processChunk(data: string): void {
    this.buffer += data;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trimEnd();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.includes('"usage"')) {
        this.parseLine(line);
      }
    }
  }

  /** Process any remaining data in the buffer (e.g. final line without trailing newline). */
  flush(): void {
    const line = this.buffer.trimEnd();
    this.buffer = "";
    if (line && line.includes('"usage"')) {
      this.parseLine(line);
    }
  }

  /** Ordered per-turn token usage records extracted so far (#355). */
  getTurnRecords(): TurnUsageRecord[] {
    return this.turnRecords;
  }

  /** Ordered per-tool-call records extracted so far (#355). */
  getToolCallRecords(): ToolCallRecord[] {
    return this.toolCallRecords;
  }

  private parseLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn("[UsageParser] malformed JSON in stream-json output");
      return;
    }

    this.parseRunLevelUsage(parsed);
    if (parsed["type"] === "assistant") {
      this.parseAssistantTurn(parsed);
    }
  }

  /** Existing run-level total path — fires onUsage on the final result event's
   *  top-level `usage` key. Unchanged and authoritative for cost/token totals. */
  private parseRunLevelUsage(parsed: Record<string, unknown>): void {
    const usage = parsed["usage"];
    if (
      typeof usage !== "object" ||
      usage === null ||
      Array.isArray(usage)
    ) {
      return;
    }

    const u = usage as Record<string, unknown>;
    const inputTokens = typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0;
    const outputTokens = typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0;
    const cacheCreationInputTokens =
      typeof u["cache_creation_input_tokens"] === "number" ? u["cache_creation_input_tokens"] : 0;
    const cacheReadInputTokens =
      typeof u["cache_read_input_tokens"] === "number" ? u["cache_read_input_tokens"] : 0;
    const totalCostUsd =
      typeof parsed["total_cost_usd"] === "number" ? parsed["total_cost_usd"] : 0;

    this.onUsage({
      sessionId: this.sessionId,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalCostUsd,
      durationMs: Date.now() - this.startedAt,
    });
  }

  /** Per-turn/per-tool extraction (#355) — reads `message.usage` and
   *  `message.content[].tool_use` from a `type: "assistant"` event. Distinct
   *  from parseRunLevelUsage: this reads a nested `message.usage`, not the
   *  top-level `usage` key, so the two paths never double-fire off one line. */
  private parseAssistantTurn(parsed: Record<string, unknown>): void {
    const message = parsed["message"];
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return;
    }
    const m = message as Record<string, unknown>;

    const usage = m["usage"];
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
      return;
    }
    const u = usage as Record<string, unknown>;

    const timestamp = this.extractTimestamp(parsed);
    const responseModel = typeof m["model"] === "string" ? m["model"] : undefined;

    const record: TurnUsageRecord = {
      turnIndex: this.turnIndex++,
      inputTokens: typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0,
      outputTokens: typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0,
      cacheCreationInputTokens:
        typeof u["cache_creation_input_tokens"] === "number" ? u["cache_creation_input_tokens"] : 0,
      cacheReadInputTokens:
        typeof u["cache_read_input_tokens"] === "number" ? u["cache_read_input_tokens"] : 0,
      timestamp,
    };
    if (responseModel !== undefined) record.responseModel = responseModel;
    this.turnRecords.push(record);

    const content = m["content"];
    if (!Array.isArray(content)) return;

    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const block = item as Record<string, unknown>;
      if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        this.toolCallRecords.push({
          toolName: block["name"],
          callIndex: this.toolCallIndex++,
          startTimestamp: timestamp,
          endTimestamp: timestamp,
        });
      }
    }
  }

  /** ISO-string or epoch-ms `timestamp` field on the event, else parse-time wall clock. */
  private extractTimestamp(parsed: Record<string, unknown>): number {
    const raw = parsed["timestamp"];
    if (typeof raw === "string") {
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms)) return ms;
    }
    if (typeof raw === "number") return raw;
    return Date.now();
  }
}
