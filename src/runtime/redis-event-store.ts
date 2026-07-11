import type { Redis } from "ioredis";
import type { EventStore, StreamId, EventId } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Redis-backed MCP EventStore for SSE resumability. Each stream is a Redis list
 * of JSON-encoded messages; the event id is `${streamId}:${index}` where index
 * is the 0-based position in that list. Keys carry a TTL so abandoned streams
 * self-expire. All Redis errors degrade gracefully (logged, never thrown into
 * the transport request path).
 */
export class RedisEventStore implements EventStore {
  constructor(
    private redis: Redis,
    private ttlSeconds = 3600,
    private log: { warn: (o: unknown, m?: string) => void } = { warn: () => {} },
  ) {}

  private key(streamId: StreamId): string { return `mcp:evt:${streamId}`; }
  private splitStreamId(eventId: EventId): StreamId {
    return eventId.slice(0, eventId.lastIndexOf(":"));
  }
  private splitIndex(eventId: EventId): number {
    return Number(eventId.slice(eventId.lastIndexOf(":") + 1));
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    try {
      const len = await this.redis.rpush(this.key(streamId), JSON.stringify(message));
      await this.redis.expire(this.key(streamId), this.ttlSeconds);
      return `${streamId}:${len - 1}`;
    } catch (err) {
      // Best-effort: return a well-formed id so the live stream continues; this
      // event just won't be durably replayable.
      this.log.warn({ err: String(err), streamId }, "RedisEventStore.storeEvent failed");
      return `${streamId}:unstored`;
    }
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    const sid = this.splitStreamId(eventId);
    return sid || undefined;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const streamId = this.splitStreamId(lastEventId);
    const after = this.splitIndex(lastEventId);
    if (!streamId || Number.isNaN(after)) return streamId;
    try {
      const items = await this.redis.lrange(this.key(streamId), after + 1, -1);
      for (let i = 0; i < items.length; i++) {
        const seq = after + 1 + i;
        await send(`${streamId}:${seq}`, JSON.parse(items[i]) as JSONRPCMessage);
      }
    } catch (err) {
      this.log.warn({ err: String(err), streamId }, "RedisEventStore.replayEventsAfter failed");
    }
    return streamId;
  }
}
