/**
 * events-bridge.ts — safety-net subscriber on Redis TaskEvent streams (§5.7).
 *
 * Subscribes to `events:{project}` streams via XREADGROUP and increments
 * `bureau.event{bureau.event.type=<type>}` for every consumed event.
 *
 * Purpose: prevents "events exist but metrics don't" divergence when new event
 * types are added to the TaskEvent union without updating domain modules.
 * This module is type-oblivious — it reads the `type` field and counts it,
 * nothing more.
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';
import { getMeter } from './core.js';
import { METRIC, ATTR } from './schema.js';
import { parseStreamMessages } from '../redis.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EventsBridgeHandle {
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROUP = 'telemetry-bridge';
/** Short block timeout so shutdown is prompt (≤1s lag). */
const BLOCK_MS = 1000;
/** Max messages per XREADGROUP call — plenty for bursts while keeping latency low. */
const COUNT = 100;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function startEventsBridge(opts: {
  projects: string[];
  getRedis: () => Promise<Redis>;
}): Promise<EventsBridgeHandle> {
  const { projects, getRedis } = opts;

  // Each bridge instance gets a stable-per-process consumer identity.
  const consumerId = `bridge-${process.pid}-${randomUUID()}`;

  const redis = await getRedis();

  // Get meter + counter once at startup. Counter is null when telemetry is
  // disabled — the loop still runs (for ack hygiene) but skips metric emission.
  const meter = getMeter();
  const counter = meter !== null ? meter.createCounter(METRIC.EVENT) : null;

  // Create consumer groups for all projects. MKSTREAM creates the stream if it
  // doesn't exist. '$' means: only read entries added after this moment.
  // BUSYGROUP means the group already exists — that's fine.
  for (const project of projects) {
    const streamKey = `events:${project}`;
    try {
      await redis.xgroup('CREATE', streamKey, GROUP, '$', 'MKSTREAM');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('BUSYGROUP')) {
        logger.warn({ err: msg, streamKey }, 'events-bridge: xgroup CREATE failed');
      }
    }
  }

  let stopped = false;
  let stopped2 = false; // second stop() guard

  const streamKeys = projects.map((p) => `events:${p}`);
  const streamIds = projects.map(() => '>');

  const loopPromise: Promise<void> = (async () => {
    let retryDelay = 100;

    while (!stopped) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (redis as any).xreadgroup(
          'GROUP', GROUP, consumerId,
          'COUNT', COUNT,
          'BLOCK', BLOCK_MS,
          'STREAMS', ...streamKeys, ...streamIds,
        ) as [key: string, messages: [id: string, fields: string[]][]][] | null;

        // Reset backoff on a successful call (even if result is null = timeout).
        retryDelay = 100;

        if (!result) continue;

        for (const [streamKey, messages] of result) {
          for (const [messageId, fields] of messages) {
            try {
              const parsed = parseStreamMessages(fields);
              const eventType = parsed['type'];

              if (!eventType) {
                logger.warn(
                  { streamKey, messageId },
                  'events-bridge: entry missing type field, skipping',
                );
                // ACK to prevent re-delivery — this entry will never be valid.
                await redis.xack(streamKey, GROUP, messageId);
                continue;
              }

              if (counter !== null) {
                counter.add(1, { [ATTR.EVENT_TYPE]: eventType });
              }

              await redis.xack(streamKey, GROUP, messageId);
            } catch (e: unknown) {
              // Per-message fault isolation: log once and continue.
              const msg = e instanceof Error ? e.message : String(e);
              logger.warn(
                { err: msg, streamKey, messageId },
                'events-bridge: failed to process stream entry, skipping',
              );
            }
          }
        }
      } catch (e: unknown) {
        if (stopped) break;
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(
          { err: msg, retryDelay },
          'events-bridge: Redis error in consume loop, retrying with backoff',
        );
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, retryDelay);
          // Allow process exit while sleeping
          if (typeof t === 'object' && t !== null && 'unref' in t) t.unref();
        });
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    }
  })();

  let stopCalled = false;

  return {
    async stop(): Promise<void> {
      if (stopCalled) {
        // Idempotent: second call is a no-op (loopPromise already resolved)
        await loopPromise.catch(() => {});
        return;
      }
      stopCalled = true;
      stopped = true;
      // The loop will exit after at most BLOCK_MS (the current XREADGROUP returns).
      await loopPromise;
      // Best-effort quit — ignore errors if already disconnected.
      await redis.quit().catch(() => {});
    },
  };
}
