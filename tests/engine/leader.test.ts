import { describe, it, expect, afterEach } from "vitest";
import { createRedisClient } from "../../src/redis.js";
import { LeaderElector } from "../../src/engine/leader.js";

const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
const electors: LeaderElector[] = [];
const keys: string[] = [];

afterEach(async () => {
  for (const e of electors.splice(0)) await e.stop();
  for (const k of keys.splice(0)) await redis.del(k);
});

async function waitFor(cond: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await new Promise(r => setTimeout(r, stepMs)); }
}

function makeElector(key: string, instanceId: string, hooks: { onAcquired?: () => void; onLost?: () => void } = {}) {
  const e = new LeaderElector(redis, { key, instanceId, leaseMs: 1000, ...hooks });
  electors.push(e);
  return e;
}

it("a single elector acquires leadership on start", async () => {
  const key = "test:leader:single"; keys.push(key);
  const e = makeElector(key, "inst-1");
  await e.start();
  expect(e.isLeader()).toBe(true);
});

it("a second elector cannot acquire while the first holds the lease", async () => {
  const key = "test:leader:contention"; keys.push(key);
  const e1 = makeElector(key, "inst-1");
  await e1.start();
  expect(e1.isLeader()).toBe(true);
  const e2 = makeElector(key, "inst-2");
  await e2.start();
  expect(e2.isLeader()).toBe(false);
});

it("a follower takes over after the leader releases (stop)", async () => {
  const key = "test:leader:takeover"; keys.push(key);
  let e2Acquired = 0;
  const e1 = makeElector(key, "inst-1");
  await e1.start();
  const e2 = makeElector(key, "inst-2", { onAcquired: () => { e2Acquired++; } });
  await e2.start();
  expect(e2.isLeader()).toBe(false);
  await e1.stop(); // releases the lease
  await waitFor(() => e2.isLeader());
  expect(e2.isLeader()).toBe(true);
  expect(e2Acquired).toBe(1);
});

it("fires onAcquired once on acquire", async () => {
  const key = "test:leader:cb"; keys.push(key);
  let acquired = 0;
  const e = makeElector(key, "inst-1", { onAcquired: () => { acquired++; } });
  await e.start();
  await waitFor(() => acquired === 1);
  expect(acquired).toBe(1);
  expect(e.isLeader()).toBe(true);
});

it("fires onLost once when the lease is lost", async () => {
  const key = "test:leader:onlost"; keys.push(key);
  let lost = 0;
  const e = makeElector(key, "inst-1", { onLost: () => { lost++; } });
  await e.start();
  expect(e.isLeader()).toBe(true);
  await redis.del(key);               // steal/expire the lease externally
  // renewMs = Math.max(1000, floor(leaseMs/3)) = 1000ms with leaseMs=1000.
  // Under parallel-suite load the event loop can lag, so we allow 8× the
  // renew interval (8 s) before declaring the tick missing.
  await waitFor(() => lost >= 1, 8_000);
  expect(lost).toBe(1);
  expect(e.isLeader()).toBe(false);
});
