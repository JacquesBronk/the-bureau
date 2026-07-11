import type { RedisClient } from "./redis.js";
import { v4 as uuidv4 } from "uuid";
import { parseStreamMessages, getStreamLatestId } from "./redis.js";
import type { PeerMessage } from "./types.js";

function inboxKey(sessionId: string): string {
  return `inbox:${sessionId}`;
}

function broadcastKey(project: string): string {
  return `broadcast:${project}`;
}

export class Messaging {
  private inboxCursors: Map<string, string> = new Map();
  private lastBroadcastIds: Map<string, string> = new Map();

  constructor(
    private redis: RedisClient,
    private sessionId: string,
  ) {}

  async sendMessage(
    toSessionId: string,
    fromSessionId: string,
    type: PeerMessage["type"],
    body: string,
  ): Promise<string> {
    const msgId = uuidv4();
    const timestamp = Date.now().toString();

    await this.redis.xadd(
      inboxKey(toSessionId),
      "*",
      "id", msgId,
      "from", fromSessionId,
      "type", type,
      "body", body,
      "timestamp", timestamp,
    );

    return msgId;
  }

  async checkMessages(sessionId: string = this.sessionId): Promise<PeerMessage[]> {
    const cursor = this.inboxCursors.get(sessionId) ?? "0-0";
    const results = await this.redis.xread(
      "COUNT", 100,
      "STREAMS", inboxKey(sessionId),
      cursor,
    );

    if (!results) return [];

    const messages: PeerMessage[] = [];
    const [, entries] = results[0] as [string, [string, string[]][]];

    for (const [streamId, fields] of entries) {
      const parsed = parseStreamMessages(fields);
      messages.push({
        id: parsed.id,
        from: parsed.from,
        type: parsed.type as PeerMessage["type"],
        body: parsed.body,
        timestamp: parseInt(parsed.timestamp, 10),
      });
      this.inboxCursors.set(sessionId, streamId);
    }

    return messages;
  }

  async broadcast(
    project: string,
    fromSessionId: string,
    body: string,
  ): Promise<void> {
    const timestamp = Date.now().toString();

    await this.redis.xadd(
      broadcastKey(project),
      "*",
      "id", uuidv4(),
      "from", fromSessionId,
      "type", "announcement",
      "body", body,
      "timestamp", timestamp,
    );
  }

  async initBroadcastCursor(project: string): Promise<void> {
    const latestId = await getStreamLatestId(this.redis, broadcastKey(project));
    this.lastBroadcastIds.set(project, latestId);
  }

  async checkBroadcasts(project: string): Promise<PeerMessage[]> {
    const lastId = this.lastBroadcastIds.get(project) || "0-0";

    const results = await this.redis.xread(
      "COUNT", 100,
      "STREAMS", broadcastKey(project),
      lastId,
    );

    if (!results) return [];

    const messages: PeerMessage[] = [];
    const [, entries] = results[0] as [string, [string, string[]][]];

    for (const [streamId, fields] of entries) {
      const parsed = parseStreamMessages(fields);
      messages.push({
        id: parsed.id,
        from: parsed.from,
        type: parsed.type as PeerMessage["type"],
        body: parsed.body,
        timestamp: parseInt(parsed.timestamp, 10),
      });
      this.lastBroadcastIds.set(project, streamId);
    }

    return messages;
  }
}
