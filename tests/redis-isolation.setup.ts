// Test Redis DB isolation — runs in every vitest worker BEFORE any test file loads.
//
// Two problems this solves:
//
// 1. ENGINE COLLISION. The k3s engine uses Redis **db 0** on the shared instance. The
//    suite flushes its DB on teardown, so running it against db 0 wipes live graph/peer
//    state (incident 2026-06-21: a `test:coverage` against redis://redis.local:6379 (db 0)
//    flushed a running dogfood graph). We must never touch db 0.
//
// 2. CROSS-FORK CONTAMINATION. vitest runs test files across parallel forks; if they share
//    one logical DB, concurrent files collide on keys (flaky failures, e.g. resumeDispatch).
//
// Fix: give each fork its OWN logical DB, derived from VITEST_POOL_ID, all clear of db 0.
// Host/port from REDIS_URL is preserved. Override the base with BUREAU_TEST_REDIS_DB.
// Redis ships 16 logical DBs (0–15); the engine owns 0, so tests live in 10–15.

const BASE = Number(process.env.BUREAU_TEST_REDIS_DB ?? "10"); // first test DB (must be > 0)
const SPAN = 6;                                                // 10..15 → up to 6 parallel forks
const poolId = Number(process.env.VITEST_POOL_ID ?? "1");      // 1-based per fork

if (!Number.isInteger(BASE) || BASE < 1 || BASE > 15) {
  throw new Error(`BUREAU_TEST_REDIS_DB must be an integer in 1..15 (got ${process.env.BUREAU_TEST_REDIS_DB}).`);
}

const db = BASE + ((Math.max(1, poolId) - 1) % SPAN);
if (db === 0) throw new Error("Refusing Redis db 0 — that is the engine's live DB.");
if (db > 15) throw new Error(`Computed Redis test db ${db} exceeds 15; lower BUREAU_TEST_REDIS_DB.`);

const raw = process.env.REDIS_URL ?? "redis://localhost:6379";
try {
  const u = new URL(raw);
  u.pathname = `/${db}`;
  process.env.REDIS_URL = u.toString();
} catch {
  process.env.REDIS_URL = `redis://localhost:6379/${db}`;
}
