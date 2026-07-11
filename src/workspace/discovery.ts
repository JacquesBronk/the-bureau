import { Redis } from "ioredis";
import { Discovery, DiscoveryWithGraph } from "../types/workspace.js";
import { parseStreamMessages, scanKeys } from "../redis.js";

export function topicMatches(topic: string, text: string): boolean {
  return text.toLowerCase().includes(topic.toLowerCase());
}

export function filesOverlap(filesA: string[], filesB: string[]): boolean {
  const setA = new Set(filesA);
  return filesB.some((f) => setA.has(f));
}

function parseDiscovery(id: string, fields: string[]): Discovery {
  const parsed = parseStreamMessages(fields);
  let files: string[] = [];
  try {
    files = JSON.parse(parsed.files || "[]");
  } catch {
    files = [];
  }
  return {
    id,
    taskId: parsed.taskId,
    role: parsed.role,
    topic: parsed.topic,
    content: parsed.content,
    files,
    scope: (parsed.scope as "graph" | "project") || "graph",
    timestamp: Number(parsed.timestamp),
  };
}

export class DiscoveryStore {
  constructor(private redis: Redis) {}

  async postDiscovery(
    graphId: string,
    discovery: {
      taskId: string;
      role: string;
      topic: string;
      content: string;
      files?: string[];
      scope?: "graph" | "project";
      project?: string;
    }
  ): Promise<string> {
    const { taskId, role, topic, content, files = [], scope = "graph", project } = discovery;
    const timestamp = String(Date.now());
    const graphKey = `workspace:${graphId}:discoveries`;

    const id = await this.redis.xadd(
      graphKey, "*",
      "taskId", taskId,
      "role", role,
      "topic", topic,
      "content", content,
      "files", JSON.stringify(files),
      "scope", scope,
      "timestamp", timestamp
    );
    await this.redis.xtrim(graphKey, "MAXLEN", "~", 500);

    if (scope === "project" && project) {
      const projectKey = `workspace:project:${project}:discoveries`;
      await this.redis.xadd(
        projectKey, "*",
        "taskId", taskId,
        "role", role,
        "topic", topic,
        "content", content,
        "files", JSON.stringify(files),
        "scope", scope,
        "timestamp", timestamp
      );
      await this.redis.xtrim(projectKey, "MAXLEN", "~", 1000);
      await this.redis.expire(projectKey, 86400); // 24h TTL per spec
    }

    return id as string;
  }

  async queryDiscoveries(
    graphId: string,
    opts?: { topic?: string; since?: string; taskId?: string; limit?: number }
  ): Promise<Discovery[]> {
    const { topic, since, taskId, limit = 20 } = opts ?? {};
    const streamKey = `workspace:${graphId}:discoveries`;
    const start = since ? `(${since}` : "-";

    const entries = await this.redis.xrange(streamKey, start, "+");

    const discoveries: Discovery[] = [];
    for (const [id, fields] of entries) {
      const d = parseDiscovery(id, fields);
      if (taskId && d.taskId !== taskId) continue;
      if (topic && !topicMatches(topic, d.topic) && !topicMatches(topic, d.content)) continue;
      discoveries.push(d);
    }

    return discoveries.reverse().slice(0, limit);
  }

  async getNewDiscoveries(
    graphId: string,
    lastId: string,
    intentDescription: string,
    intentFiles: string[]
  ): Promise<Discovery[]> {
    const streamKey = `workspace:${graphId}:discoveries`;
    const entries = await this.redis.xrange(streamKey, `(${lastId}`, "+");

    const discoveries: Discovery[] = [];
    for (const [id, fields] of entries) {
      const d = parseDiscovery(id, fields);
      if (topicMatches(d.topic, intentDescription) || filesOverlap(d.files, intentFiles)) {
        discoveries.push(d);
      }
    }

    return discoveries;
  }

  async queryAllDiscoveries(
    opts?: { topic?: string; limit?: number }
  ): Promise<DiscoveryWithGraph[]> {
    const { topic, limit = 50 } = opts ?? {};
    const GRAPH_KEY_RE = /^workspace:([^:]+):discoveries$/;

    const keys = await scanKeys(this.redis, "workspace:*:discoveries");
    const all: DiscoveryWithGraph[] = [];

    for (const key of keys) {
      const m = GRAPH_KEY_RE.exec(key);
      if (!m) continue;
      const graphId = m[1];

      const entries = await this.redis.xrange(key, "-", "+");
      for (const [id, fields] of entries) {
        const d = parseDiscovery(id, fields);
        if (topic && !topicMatches(topic, d.topic) && !topicMatches(topic, d.content)) continue;
        all.push({ ...d, graphId });
      }
    }

    all.sort((a, b) => b.timestamp - a.timestamp);
    return all.slice(0, limit);
  }

  async cleanupGraph(graphId: string): Promise<void> {
    await this.redis.del(`workspace:${graphId}:discoveries`);
  }
}
