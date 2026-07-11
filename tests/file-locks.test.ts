import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { FileLockManager } from "../src/file-locks.js";

describe("FileLockManager", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let locks: FileLockManager;
  const project = "test-lock-project";

  beforeEach(async () => {
    const keys = await scanKeys(redis, "locks:test-lock-*");
    if (keys.length > 0) await redis.del(...keys);
    locks = new FileLockManager(redis);
  });

  afterAll(async () => {
    const keys = await scanKeys(redis, "locks:test-lock-*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("should acquire an exclusive lock", async () => {
    const result = await locks.acquireLocks(project, {
      sessionId: "s1", taskId: "t1", graphId: "g1",
      paths: ["src/index.ts"], mode: "exclusive",
    });
    expect(result.acquired).toContain("src/index.ts");
    expect(result.conflicts).toHaveLength(0);
  });

  it("should fail to acquire a lock already held", async () => {
    await locks.acquireLocks(project, {
      sessionId: "s1", taskId: "t1", graphId: "g1",
      paths: ["src/index.ts"], mode: "exclusive",
    });
    const result = await locks.acquireLocks(project, {
      sessionId: "s2", taskId: "t2", graphId: "g1",
      paths: ["src/index.ts"], mode: "exclusive",
    });
    expect(result.acquired).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].path).toBe("src/index.ts");
    expect(result.conflicts[0].heldBy.sessionId).toBe("s1");
  });

  it("should release locks", async () => {
    await locks.acquireLocks(project, {
      sessionId: "s1", taskId: "t1", graphId: "g1",
      paths: ["src/index.ts"], mode: "exclusive",
    });
    const released = await locks.releaseLocks(project, "s1", ["src/index.ts"]);
    expect(released.released).toContain("src/index.ts");

    const result = await locks.acquireLocks(project, {
      sessionId: "s2", taskId: "t2", graphId: "g1",
      paths: ["src/index.ts"], mode: "exclusive",
    });
    expect(result.acquired).toContain("src/index.ts");
  });

  it("should release all locks for a session", async () => {
    await locks.acquireLocks(project, {
      sessionId: "s1", taskId: "t1", graphId: "g1",
      paths: ["a.ts", "b.ts", "c.ts"], mode: "exclusive",
    });
    const count = await locks.releaseAllForSession(project, "s1");
    expect(count).toBe(3);
  });


  it("should be all-or-nothing: no partial lock sets on conflict", async () => {
    // Agent 1 acquires locks on a.ts and b.ts
    const r1 = await locks.acquireLocks(project, {
      sessionId: "s1", taskId: "t1", graphId: "g1",
      paths: ["a.ts", "b.ts"], mode: "exclusive",
    });
    expect(r1.acquired).toEqual(["a.ts", "b.ts"]);
    expect(r1.conflicts).toHaveLength(0);

    // Agent 2 tries to acquire b.ts and c.ts (overlaps on b.ts)
    const r2 = await locks.acquireLocks(project, {
      sessionId: "s2", taskId: "t2", graphId: "g1",
      paths: ["b.ts", "c.ts"], mode: "exclusive",
    });

    // Agent 2 must get zero acquired (all-or-nothing)
    expect(r2.acquired).toHaveLength(0);
    expect(r2.conflicts).toHaveLength(1);
    expect(r2.conflicts[0].path).toBe("b.ts");
    expect(r2.conflicts[0].heldBy.sessionId).toBe("s1");

    // Verify c.ts was NOT partially acquired by agent 2
    const r3 = await locks.acquireLocks(project, {
      sessionId: "s3", taskId: "t3", graphId: "g1",
      paths: ["c.ts"], mode: "exclusive",
    });
    expect(r3.acquired).toEqual(["c.ts"]);
    expect(r3.conflicts).toHaveLength(0);
  });

  it("should allow same session to re-acquire its own locks", async () => {
    await locks.acquireLocks(project, {
      sessionId: "s1", taskId: "t1", graphId: "g1",
      paths: ["x.ts", "y.ts"], mode: "exclusive",
    });
    // Same session re-acquires — should succeed
    const r2 = await locks.acquireLocks(project, {
      sessionId: "s1", taskId: "t1", graphId: "g1",
      paths: ["x.ts", "y.ts"], mode: "exclusive",
    });
    expect(r2.acquired).toEqual(["x.ts", "y.ts"]);
    expect(r2.conflicts).toHaveLength(0);
  });

  it("concurrent acquisition with overlapping paths: no partial sets", async () => {
    // Simulate two concurrent lock requests with overlapping paths
    const [r1, r2] = await Promise.all([
      locks.acquireLocks(project, {
        sessionId: "s1", taskId: "t1", graphId: "g1",
        paths: ["shared.ts", "only-a.ts"], mode: "exclusive",
      }),
      locks.acquireLocks(project, {
        sessionId: "s2", taskId: "t2", graphId: "g1",
        paths: ["shared.ts", "only-b.ts"], mode: "exclusive",
      }),
    ]);

    // Exactly one should succeed fully, the other should fail entirely
    const oneSucceeded =
      (r1.acquired.length === 2 && r2.acquired.length === 0) ||
      (r2.acquired.length === 2 && r1.acquired.length === 0);
    expect(oneSucceeded).toBe(true);

    // The loser must have zero acquired paths (no partial sets)
    const loser = r1.acquired.length === 0 ? r1 : r2;
    expect(loser.acquired).toHaveLength(0);
    expect(loser.conflicts).toHaveLength(1);
    expect(loser.conflicts[0].path).toBe("shared.ts");
  });

  // ── Regression tests for Issue #67: TOCTOU race in acquireLocks ────────────
  // Before the fix, acquireLocks iterated paths one at a time. Two concurrent
  // callers could each partially acquire different subsets of an overlapping
  // path set. The Lua-script fix makes acquisition all-or-nothing atomically.

  describe("regression #67: atomic all-or-nothing lock acquisition", () => {
    it("concurrent acquisition: both sessions win when their path sets are disjoint", async () => {
      const [r1, r2] = await Promise.all([
        locks.acquireLocks(project, {
          sessionId: "s1", taskId: "t1", graphId: "g1",
          paths: ["disjoint-a.ts", "disjoint-b.ts"], mode: "exclusive",
        }),
        locks.acquireLocks(project, {
          sessionId: "s2", taskId: "t2", graphId: "g1",
          paths: ["disjoint-c.ts", "disjoint-d.ts"], mode: "exclusive",
        }),
      ]);

      // Disjoint sets: both must fully succeed
      expect(r1.acquired).toEqual(["disjoint-a.ts", "disjoint-b.ts"]);
      expect(r1.conflicts).toHaveLength(0);
      expect(r2.acquired).toEqual(["disjoint-c.ts", "disjoint-d.ts"]);
      expect(r2.conflicts).toHaveLength(0);
    });

    it("concurrent acquisition: three agents racing for one shared path, exactly one wins", async () => {
      const [r1, r2, r3] = await Promise.all([
        locks.acquireLocks(project, {
          sessionId: "s1", taskId: "t1", graphId: "g1",
          paths: ["hotspot.ts", "race-a.ts"], mode: "exclusive",
        }),
        locks.acquireLocks(project, {
          sessionId: "s2", taskId: "t2", graphId: "g1",
          paths: ["hotspot.ts", "race-b.ts"], mode: "exclusive",
        }),
        locks.acquireLocks(project, {
          sessionId: "s3", taskId: "t3", graphId: "g1",
          paths: ["hotspot.ts", "race-c.ts"], mode: "exclusive",
        }),
      ]);

      const results = [r1, r2, r3];
      const winners = results.filter((r) => r.acquired.length === 2);
      const losers = results.filter((r) => r.acquired.length === 0);

      // Exactly one winner
      expect(winners).toHaveLength(1);
      expect(winners[0].conflicts).toHaveLength(0);

      // Two losers, each with zero acquired paths and one conflict
      expect(losers).toHaveLength(2);
      for (const loser of losers) {
        expect(loser.acquired).toHaveLength(0);
        expect(loser.conflicts).toHaveLength(1);
        // The conflict must be on the shared path, not on the loser's private path
        expect(loser.conflicts[0].path).toBe("hotspot.ts");
      }
    });

    it("concurrent acquisition: losers report the shared path as conflict, not an uncontested path", async () => {
      // s1 pre-holds "shared.ts" so subsequent contenders must conflict on it
      await locks.acquireLocks(project, {
        sessionId: "s1", taskId: "t1", graphId: "g1",
        paths: ["conflict-shared.ts"], mode: "exclusive",
      });

      // Two agents both want the held key plus a unique private key each
      const [r2, r3] = await Promise.all([
        locks.acquireLocks(project, {
          sessionId: "s2", taskId: "t2", graphId: "g1",
          paths: ["conflict-shared.ts", "unique-to-s2.ts"], mode: "exclusive",
        }),
        locks.acquireLocks(project, {
          sessionId: "s3", taskId: "t3", graphId: "g1",
          paths: ["conflict-shared.ts", "unique-to-s3.ts"], mode: "exclusive",
        }),
      ]);

      // Both must fail: zero acquired, conflict on the shared path only
      expect(r2.acquired).toHaveLength(0);
      expect(r2.conflicts[0].path).toBe("conflict-shared.ts");

      expect(r3.acquired).toHaveLength(0);
      expect(r3.conflicts[0].path).toBe("conflict-shared.ts");

      // The private paths must still be free (not partially acquired)
      const canAcquireS2Private = await locks.acquireLocks(project, {
        sessionId: "s4", taskId: "t4", graphId: "g1",
        paths: ["unique-to-s2.ts"], mode: "exclusive",
      });
      expect(canAcquireS2Private.acquired).toEqual(["unique-to-s2.ts"]);

      const canAcquireS3Private = await locks.acquireLocks(project, {
        sessionId: "s5", taskId: "t5", graphId: "g1",
        paths: ["unique-to-s3.ts"], mode: "exclusive",
      });
      expect(canAcquireS3Private.acquired).toEqual(["unique-to-s3.ts"]);
    });

    it("concurrent acquisition: winner's acquired list matches its full requested path set", async () => {
      const paths = ["full-a.ts", "full-b.ts", "full-c.ts"];
      const [r1, r2] = await Promise.all([
        locks.acquireLocks(project, {
          sessionId: "s1", taskId: "t1", graphId: "g1",
          paths, mode: "exclusive",
        }),
        locks.acquireLocks(project, {
          sessionId: "s2", taskId: "t2", graphId: "g1",
          paths, mode: "exclusive",
        }),
      ]);

      const winner = r1.acquired.length === 3 ? r1 : r2;
      expect(winner.acquired).toEqual(paths);
      expect(winner.conflicts).toHaveLength(0);
    });

    it("conflict heldBy carries the sessionId and taskId of the winning agent", async () => {
      await locks.acquireLocks(project, {
        sessionId: "holder-session", taskId: "holder-task", graphId: "g1",
        paths: ["held-file.ts"], mode: "exclusive",
      });

      const result = await locks.acquireLocks(project, {
        sessionId: "contender-session", taskId: "contender-task", graphId: "g1",
        paths: ["held-file.ts"], mode: "exclusive",
      });

      expect(result.acquired).toHaveLength(0);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].heldBy.sessionId).toBe("holder-session");
      expect(result.conflicts[0].heldBy.taskId).toBe("holder-task");
    });

    it("loser can win after the winner releases all its locks", async () => {
      const paths = ["retry-a.ts", "retry-b.ts"];
      const [r1, r2] = await Promise.all([
        locks.acquireLocks(project, {
          sessionId: "s1", taskId: "t1", graphId: "g1",
          paths, mode: "exclusive",
        }),
        locks.acquireLocks(project, {
          sessionId: "s2", taskId: "t2", graphId: "g1",
          paths, mode: "exclusive",
        }),
      ]);

      const [winner, loserSession] = r1.acquired.length === 2
        ? ["s1", "s2"]
        : ["s2", "s1"];

      // Winner releases
      await locks.releaseAllForSession(project, winner);

      // Loser retries and must now win
      const retry = await locks.acquireLocks(project, {
        sessionId: loserSession, taskId: "t-retry", graphId: "g1",
        paths, mode: "exclusive",
      });
      expect(retry.acquired).toEqual(paths);
      expect(retry.conflicts).toHaveLength(0);
    });

    it("acquireLocks with empty paths always succeeds and acquires nothing", async () => {
      const result = await locks.acquireLocks(project, {
        sessionId: "s1", taskId: "t1", graphId: "g1",
        paths: [], mode: "exclusive",
      });
      expect(result.acquired).toEqual([]);
      expect(result.conflicts).toHaveLength(0);
    });

    it("same session acquiring a superset of its own existing locks succeeds", async () => {
      // First acquire a subset
      await locks.acquireLocks(project, {
        sessionId: "s1", taskId: "t1", graphId: "g1",
        paths: ["superset-a.ts"], mode: "exclusive",
      });
      // Then acquire the subset + a new file — should succeed because s1 already owns superset-a.ts
      const r2 = await locks.acquireLocks(project, {
        sessionId: "s1", taskId: "t1", graphId: "g1",
        paths: ["superset-a.ts", "superset-b.ts"], mode: "exclusive",
      });
      expect(r2.acquired).toEqual(["superset-a.ts", "superset-b.ts"]);
      expect(r2.conflicts).toHaveLength(0);
    });
  });

  // ── releaseLocks edge cases ────────────────────────────────────────────────

  describe("releaseLocks edge cases", () => {
    it("does not release a lock held by a different session", async () => {
      await locks.acquireLocks(project, {
        sessionId: "holder", taskId: "t1", graphId: "g1",
        paths: ["protected.ts"], mode: "exclusive",
      });

      const result = await locks.releaseLocks(project, "interloper", ["protected.ts"]);
      expect(result.released).toHaveLength(0);
      expect(result.notHeld).toContain("protected.ts");

      // Lock must still be held — the original holder can still see it conflict
      const check = await locks.acquireLocks(project, {
        sessionId: "someone-else", taskId: "t-check", graphId: "g1",
        paths: ["protected.ts"], mode: "exclusive",
      });
      expect(check.acquired).toHaveLength(0);
      expect(check.conflicts[0].heldBy.sessionId).toBe("holder");
    });

    it("reports notHeld for paths that were never locked", async () => {
      const result = await locks.releaseLocks(project, "s1", ["never-locked.ts"]);
      expect(result.released).toHaveLength(0);
      expect(result.notHeld).toContain("never-locked.ts");
    });

    it("distinguishes between released and notHeld in a mixed batch", async () => {
      await locks.acquireLocks(project, {
        sessionId: "s1", taskId: "t1", graphId: "g1",
        paths: ["owned.ts"], mode: "exclusive",
      });
      await locks.acquireLocks(project, {
        sessionId: "s2", taskId: "t2", graphId: "g1",
        paths: ["other-owned.ts"], mode: "exclusive",
      });

      const result = await locks.releaseLocks(project, "s1", [
        "owned.ts",       // s1 owns this — should be released
        "other-owned.ts", // s2 owns this — should be notHeld
        "unlocked.ts",    // nobody owns — should be notHeld
      ]);

      expect(result.released).toEqual(["owned.ts"]);
      expect(result.notHeld).toContain("other-owned.ts");
      expect(result.notHeld).toContain("unlocked.ts");
    });

    it("releaseAllForSession returns 0 when session holds no locks", async () => {
      const count = await locks.releaseAllForSession(project, "ghost-session");
      expect(count).toBe(0);
    });
  });
});
