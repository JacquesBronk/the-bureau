#!/usr/bin/env node
// Stream graph events from Redis for Claude Code's Monitor tool.
// Usage: node monitor-graph-events.mjs <project> <graphId>
//
// Each event prints one formatted line to stdout, which becomes a notification
// in the Claude Code chat. Exits automatically on terminal graph events.

import Redis from "ioredis";

const project = process.argv[2];
const graphId = process.argv[3];

if (!project || !graphId) {
  console.error("Usage: monitor-graph-events.mjs <project> <graphId>");
  process.exit(1);
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const streamKey = `events:${project}`;
let lastId = "$";

const ICONS = {
  task_started: "▶",
  task_completed: "✓",
  task_failed: "✗",
  task_progress: "◐",
  task_approval_required: "⏸",
  task_dead: "💀",
  task_stale: "⚠",
  task_warning: "⚠",
  task_retried: "↻",
  graph_completed: "━━ ✓",
  graph_failed: "━━ ✗",
  graph_verifying: "🔍",
  graph_verification_passed: "━━ ✓",
  graph_verification_failed: "━━ ✗",
  graph_awaiting_children: "⏳",
};

const TERMINAL_EVENTS = new Set([
  "graph_completed",
  "graph_failed",
  "graph_verification_passed",
  "graph_verification_failed",
]);

const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
await redis.connect();

const cleanup = async () => {
  await redis.quit().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

while (true) {
  try {
    const results = await redis.xread(
      "COUNT", 10, "BLOCK", 5000, "STREAMS", streamKey, lastId,
    );

    if (!results) continue;

    for (const [, entries] of results) {
      for (const [entryId, fields] of entries) {
        lastId = entryId;

        // fields is a flat array: [key, val, key, val, ...]
        const m = {};
        for (let i = 0; i < fields.length; i += 2) {
          m[fields[i]] = fields[i + 1];
        }

        // Only show events for our graph
        if (m.graphId !== graphId) continue;

        const type = m.type || "unknown";
        const taskId = m.taskId || "";
        const detail = m.detail || "";
        const icon = ICONS[type] || "•";

        const parts = [icon, type];
        if (taskId) parts.push(taskId);
        if (detail) parts.push(`— ${detail}`);
        console.log(parts.join(" "));

        if (TERMINAL_EVENTS.has(type)) {
          await cleanup();
        }
      }
    }
  } catch (err) {
    console.error(`Redis error: ${err.message}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
