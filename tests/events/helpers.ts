/**
 * Shared helpers for the event preservation contract test suite.
 *
 * These utilities provide minimal scaffolding so each contract test can set up
 * a real TaskGraphManager + real Redis scenario, consume the event stream, and
 * assert on field layout without repeating boilerplate.
 */
import type { RedisClient } from "../../src/redis.js";
import { TaskGraphManager } from "../../src/task-graph.js";
import { cleanupGraphsAndEvents } from "../utils/graph-cleanup.js";

export type StreamEvent = Record<string, string>;

/**
 * Read all entries from a Redis event stream and return them as plain objects.
 * Uses the same xrange pattern as the rest of the test suite.
 */
export async function readStreamEvents(
  redis: RedisClient,
  project: string,
): Promise<StreamEvent[]> {
  const entries = await redis.xrange(`events:${project}`, "-", "+");
  return entries.map(([_id, fields]) => {
    const obj: StreamEvent = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return obj;
  });
}

/** Return the first stream event whose `type` matches, or undefined. */
export function findEvent(events: StreamEvent[], type: string): StreamEvent | undefined {
  return events.find((e) => e.type === type);
}

/** Return all stream events whose `type` matches. */
export function filterEvents(events: StreamEvent[], type: string): StreamEvent[] {
  return events.filter((e) => e.type === type);
}

/**
 * Construct a TaskGraphManager with minimal no-op callbacks.
 * Returns the manager plus mutable arrays so tests can inspect what was dispatched
 * or what events flowed through the in-process callback.
 *
 * Note: the in-process `onEvent` callback is secondary to the Redis stream assertions.
 * The stream is the contract; the callback is a convenience for quick smoke checks.
 */
export function makeManager(
  redis: RedisClient,
  sessionId?: string,
): {
  manager: TaskGraphManager;
  dispatched: Array<{ graphId: string; taskId: string }>;
  events: Array<{ type: string; graphId: string; taskId?: string; detail?: string }>;
} {
  const dispatched: Array<{ graphId: string; taskId: string }> = [];
  const events: Array<{ type: string; graphId: string; taskId?: string; detail?: string }> = [];

  const manager = new TaskGraphManager(
    redis,
    {
      onDispatch: async (graphId, task) => {
        dispatched.push({ graphId, taskId: task.id });
      },
      onEvent: async (event) => {
        events.push({
          type: event.type,
          graphId: event.graphId,
          taskId: event.taskId,
          detail: event.detail,
        });
      },
    },
    sessionId,
  );

  return { manager, dispatched, events };
}

/**
 * Clean up all graph keys and event streams for projects matching the given
 * pattern.  Delegates to the shared graph-cleanup utility.
 *
 * @param redis     Redis client to use
 * @param pattern   Regex matched against the `project` field in graph metadata
 * @param prefix    Passed to `cleanupGraphsAndEvents` for the `events:{prefix}*` scan
 */
export async function cleanupByPrefix(
  redis: RedisClient,
  pattern: RegExp,
  prefix: string,
): Promise<void> {
  await cleanupGraphsAndEvents(redis, pattern, prefix);
}
