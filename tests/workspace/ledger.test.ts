import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import { WorkspaceLedger, normalizePath, parseFileRefsFromDescription } from "../../src/workspace/ledger.js";

// ─── normalizePath ─────────────────────────────────────────────────────────

describe("normalizePath()", () => {
  it("strips cwd prefix from an absolute path", () => {
    expect(normalizePath("/mnt/c/Projects/foo/src/bar.ts", "/mnt/c/Projects/foo")).toBe("src/bar.ts");
  });

  it("leaves an already-relative path unchanged", () => {
    expect(normalizePath("src/bar.ts", "/mnt/c/Projects/foo")).toBe("src/bar.ts");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(normalizePath("src\\bar.ts", "/mnt/c/Projects/foo")).toBe("src/bar.ts");
  });

  it("handles cwd with trailing slash", () => {
    expect(normalizePath("/mnt/c/Projects/foo/src/bar.ts", "/mnt/c/Projects/foo/")).toBe("src/bar.ts");
  });

  it("does not strip partial prefix match", () => {
    // '/mnt/c/Projects/foobar/...' should NOT strip '/mnt/c/Projects/foo'
    const result = normalizePath("/mnt/c/Projects/foobar/src/bar.ts", "/mnt/c/Projects/foo");
    expect(result).toBe("/mnt/c/Projects/foobar/src/bar.ts");
  });
});

// ─── parseFileRefsFromDescription ─────────────────────────────────────────

describe("parseFileRefsFromDescription()", () => {
  it("extracts a backtick-wrapped path", () => {
    expect(parseFileRefsFromDescription("fixing bug in `src/redis.ts`")).toEqual(["src/redis.ts"]);
  });

  it("extracts a path-like pattern containing / with a file extension", () => {
    expect(parseFileRefsFromDescription("working on src/redis.ts now")).toEqual(["src/redis.ts"]);
  });

  it("returns empty array for fuzzy module description with no path", () => {
    expect(parseFileRefsFromDescription("working on the Redis module")).toEqual([]);
  });

  it("extracts multiple backtick-wrapped paths", () => {
    const result = parseFileRefsFromDescription("updating `src/a.ts` and `src/b.ts`");
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
    expect(result).toHaveLength(2);
  });

  it("deduplicates the same path mentioned twice", () => {
    const result = parseFileRefsFromDescription("`src/a.ts` and also src/a.ts");
    expect(result).toEqual(["src/a.ts"]);
  });

  it("returns empty array for empty description", () => {
    expect(parseFileRefsFromDescription("")).toEqual([]);
  });

  it("does not extract bare filenames without a directory separator", () => {
    expect(parseFileRefsFromDescription("working on redis.ts")).toEqual([]);
  });
});

// ─── WorkspaceLedger (Redis-backed) ───────────────────────────────────────

describe("WorkspaceLedger", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let ledger: WorkspaceLedger;
  let graphId: string;

  beforeEach(() => {
    graphId = `test-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ledger = new WorkspaceLedger(redis);
  });

  afterEach(async () => {
    await ledger.cleanupGraph(graphId);
  });

  afterEach(async () => {
    // Belt-and-suspenders: scan for any lingering test keys
    const keys = await redis.keys(`workspace:${graphId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  // ─── Intent CRUD ────────────────────────────────────────────────────────

  describe("Intent CRUD", () => {
    it("publishIntent stores intent and getIntent reads it back", async () => {
      await ledger.publishIntent(graphId, "task-a", {
        files: ["src/foo.ts"],
        description: "adding feature",
        role: "implementer",
        phase: "implementing",
        sessionId: "session-1",
      });

      const intent = await ledger.getIntent(graphId, "task-a");

      expect(intent).not.toBeNull();
      expect(intent!.taskId).toBe("task-a");
      expect(intent!.graphId).toBe(graphId);
      expect(intent!.files).toEqual(["src/foo.ts"]);
      expect(intent!.description).toBe("adding feature");
      expect(intent!.role).toBe("implementer");
      expect(intent!.phase).toBe("implementing");
      expect(intent!.sessionId).toBe("session-1");
      expect(intent!.updatedAt).toBeGreaterThan(0);
    });

    it("publishIntent merges with existing intent — files published first, then phase", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/foo.ts"] });
      await ledger.publishIntent(graphId, "task-a", { phase: "testing" });

      const intent = await ledger.getIntent(graphId, "task-a");

      expect(intent!.files).toEqual(["src/foo.ts"]);
      expect(intent!.phase).toBe("testing");
    });

    it("getIntent returns null for a non-existent task", async () => {
      const intent = await ledger.getIntent(graphId, "no-such-task");
      expect(intent).toBeNull();
    });

    it("removeIntent deletes the intent key so getIntent returns null", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/foo.ts"] });
      await ledger.removeIntent(graphId, "task-a");

      const intent = await ledger.getIntent(graphId, "task-a");
      expect(intent).toBeNull();
    });

    it("getAllIntents returns all intents published for a graph", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/a.ts"], description: "agent A" });
      await ledger.publishIntent(graphId, "task-b", { files: ["src/b.ts"], description: "agent B" });

      const intents = await ledger.getAllIntents(graphId);
      const taskIds = intents.map((i) => i.taskId).sort();

      expect(taskIds).toEqual(["task-a", "task-b"]);
    });

    it("getAllIntents returns empty array when no intents exist", async () => {
      const intents = await ledger.getAllIntents(graphId);
      expect(intents).toEqual([]);
    });

    it("addFiles deduplicates and merges new files into existing list", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/foo.ts", "src/bar.ts"] });
      await ledger.addFiles(graphId, "task-a", ["src/bar.ts", "src/baz.ts"]);

      const intent = await ledger.getIntent(graphId, "task-a");

      expect(intent!.files).toHaveLength(3);
      expect(intent!.files).toContain("src/foo.ts");
      expect(intent!.files).toContain("src/bar.ts");
      expect(intent!.files).toContain("src/baz.ts");
    });

    it("addFiles on a task with no prior files creates the files list", async () => {
      await ledger.addFiles(graphId, "task-a", ["src/new.ts"]);

      const intent = await ledger.getIntent(graphId, "task-a");
      expect(intent!.files).toEqual(["src/new.ts"]);
    });
  });

  // ─── Conflict detection ─────────────────────────────────────────────────

  describe("detectConflicts()", () => {
    it("returns no conflicts when intents have no file overlap and no directory overlap", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/foo.ts"], phase: "implementing" });
      await ledger.publishIntent(graphId, "task-b", { files: ["tests/bar.ts"], phase: "implementing" });

      const conflicts = await ledger.detectConflicts(graphId, "task-a");
      expect(conflicts).toHaveLength(0);
    });

    it("returns severity 'low' when agents work in the same directory on different files", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/foo.ts"], phase: "planning" });
      await ledger.publishIntent(graphId, "task-b", { files: ["src/bar.ts"], phase: "planning" });

      const conflicts = await ledger.detectConflicts(graphId, "task-a");

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].severity).toBe("low");
      expect(conflicts[0].taskA).toBe("task-a");
      expect(conflicts[0].taskB).toBe("task-b");
    });

    it("returns severity 'high' when agents declare the same file but are not both implementing", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/redis.ts"], phase: "planning" });
      await ledger.publishIntent(graphId, "task-b", { files: ["src/redis.ts"], phase: "implementing" });

      const conflicts = await ledger.detectConflicts(graphId, "task-a");

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].severity).toBe("high");
      expect(conflicts[0].files).toContain("src/redis.ts");
    });

    it("returns severity 'critical' when both agents are in implementing phase on the same file", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/redis.ts"], phase: "implementing" });
      await ledger.publishIntent(graphId, "task-b", { files: ["src/redis.ts"], phase: "implementing" });

      const conflicts = await ledger.detectConflicts(graphId, "task-a");

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].severity).toBe("critical");
    });

    it("returns no conflicts when the calling task has no files declared", async () => {
      await ledger.publishIntent(graphId, "task-a", { phase: "planning" });
      await ledger.publishIntent(graphId, "task-b", { files: ["src/redis.ts"], phase: "implementing" });

      const conflicts = await ledger.detectConflicts(graphId, "task-a");
      expect(conflicts).toHaveLength(0);
    });

    it("returns pairwise conflicts for three agents where two overlap", async () => {
      // task-a and task-b share src/shared.ts; task-c is in a completely different directory
      await ledger.publishIntent(graphId, "task-a", { files: ["src/shared.ts"], phase: "implementing" });
      await ledger.publishIntent(graphId, "task-b", { files: ["src/shared.ts"], phase: "implementing" });
      await ledger.publishIntent(graphId, "task-c", { files: ["docs/readme.ts"], phase: "implementing" });

      const conflicts = await ledger.detectConflicts(graphId, "task-a");

      // task-a overlaps only with task-b (critical); task-c is in different dir
      const criticalConflicts = conflicts.filter((c) => c.severity === "critical");
      expect(criticalConflicts).toHaveLength(1);
      expect(criticalConflicts[0].taskB).toBe("task-b");

      // no conflict with task-c
      const withC = conflicts.filter((c) => c.taskB === "task-c");
      expect(withC).toHaveLength(0);
    });

    it("stores detected conflicts in Redis under the conflicts hash key", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/redis.ts"], phase: "implementing" });
      await ledger.publishIntent(graphId, "task-b", { files: ["src/redis.ts"], phase: "implementing" });

      await ledger.detectConflicts(graphId, "task-a");

      const stored = await redis.hget(`workspace:${graphId}:conflicts`, "task-a:task-b");
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.severity).toBe("critical");
    });
  });

  // ─── cleanupGraph ────────────────────────────────────────────────────────

  describe("cleanupGraph()", () => {
    it("removes all workspace intent keys for the graph", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/a.ts"] });
      await ledger.publishIntent(graphId, "task-b", { files: ["src/b.ts"] });

      await ledger.cleanupGraph(graphId);

      expect(await ledger.getIntent(graphId, "task-a")).toBeNull();
      expect(await ledger.getIntent(graphId, "task-b")).toBeNull();
    });

    it("removes the conflicts hash key", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/x.ts"], phase: "implementing" });
      await ledger.publishIntent(graphId, "task-b", { files: ["src/x.ts"], phase: "implementing" });
      await ledger.detectConflicts(graphId, "task-a");

      await ledger.cleanupGraph(graphId);

      const conflictKeys = await redis.keys(`workspace:${graphId}:conflicts`);
      expect(conflictKeys).toHaveLength(0);
    });

    it("is idempotent — calling twice does not throw", async () => {
      await ledger.publishIntent(graphId, "task-a", { files: ["src/a.ts"] });
      await ledger.cleanupGraph(graphId);
      await expect(ledger.cleanupGraph(graphId)).resolves.not.toThrow();
    });

    it("does not affect intents from a different graph", async () => {
      const otherGraph = `${graphId}-other`;
      await ledger.publishIntent(graphId, "task-a", { files: ["src/a.ts"] });
      await ledger.publishIntent(otherGraph, "task-b", { files: ["src/b.ts"] });

      await ledger.cleanupGraph(graphId);

      // other graph's intent should still exist
      const otherIntent = await ledger.getIntent(otherGraph, "task-b");
      expect(otherIntent).not.toBeNull();

      // cleanup the other graph too
      await ledger.cleanupGraph(otherGraph);
    });
  });

  // ─── Child graph read-access to parent ledger ────────────────────────────

  describe("Child graph read-access (parentGraphId)", () => {
    let parentGraphId: string;

    beforeEach(() => {
      parentGraphId = `test-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    });

    afterEach(async () => {
      await ledger.cleanupGraph(parentGraphId);
      const keys = await redis.keys(`workspace:${parentGraphId}:*`);
      if (keys.length > 0) await redis.del(...keys);
    });

    it("getAllIntents with parentGraphId returns both local and parent intents", async () => {
      await ledger.publishIntent(graphId, "child-task", { files: ["src/child.ts"], description: "child work" });
      await ledger.publishIntent(parentGraphId, "parent-task", { files: ["src/parent.ts"], description: "parent work" });

      const intents = await ledger.getAllIntents(graphId, parentGraphId);
      const taskIds = intents.map((i) => i.taskId).sort();

      expect(taskIds).toContain("child-task");
      expect(taskIds).toContain("parent-task");
    });

    it("parent intents have fromParent: true, local intents do not", async () => {
      await ledger.publishIntent(graphId, "child-task", { files: ["src/child.ts"] });
      await ledger.publishIntent(parentGraphId, "parent-task", { files: ["src/parent.ts"] });

      const intents = await ledger.getAllIntents(graphId, parentGraphId);

      const childIntent = intents.find((i) => i.taskId === "child-task");
      const parentIntent = intents.find((i) => i.taskId === "parent-task");

      expect(childIntent?.fromParent).toBeFalsy();
      expect(parentIntent?.fromParent).toBe(true);
    });

    it("detectConflicts catches overlap between child task and parent task", async () => {
      await ledger.publishIntent(graphId, "child-task", { files: ["src/shared.ts"], phase: "implementing" });
      await ledger.publishIntent(parentGraphId, "parent-task", { files: ["src/shared.ts"], phase: "implementing" });

      const conflicts = await ledger.detectConflicts(graphId, "child-task", parentGraphId);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].severity).toBe("critical");
      expect(conflicts[0].files).toContain("src/shared.ts");
    });

    it("child graph intents don't appear in parent's getAllIntents (isolation is one-way)", async () => {
      await ledger.publishIntent(graphId, "child-task", { files: ["src/child.ts"] });
      await ledger.publishIntent(parentGraphId, "parent-task", { files: ["src/parent.ts"] });

      // Parent calls getAllIntents without passing a parentGraphId
      const parentIntents = await ledger.getAllIntents(parentGraphId);
      const taskIds = parentIntents.map((i) => i.taskId);

      expect(taskIds).toContain("parent-task");
      expect(taskIds).not.toContain("child-task");
    });

    it("getAllIntents without parentGraphId returns only local intents", async () => {
      await ledger.publishIntent(graphId, "child-task", { files: ["src/child.ts"] });
      await ledger.publishIntent(parentGraphId, "parent-task", { files: ["src/parent.ts"] });

      const intents = await ledger.getAllIntents(graphId);
      const taskIds = intents.map((i) => i.taskId);

      expect(taskIds).toContain("child-task");
      expect(taskIds).not.toContain("parent-task");
    });
  });
});
