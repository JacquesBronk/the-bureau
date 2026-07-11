import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { HandoffManager } from "../src/handoff.js";
import type { HandoffContext } from "../src/types.js";

describe("HandoffManager", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: HandoffManager;

  beforeEach(async () => {
    const keys = await scanKeys(redis, "handoff:test-*");
    if (keys.length > 0) await redis.del(...keys);
    manager = new HandoffManager(redis);
  });

  afterAll(async () => {
    const keys = await scanKeys(redis, "handoff:test-*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("should store and retrieve a handoff", async () => {
    const handoff: HandoffContext = {
      taskId: "task-a",
      graphId: "test-graph-1",
      filesChanged: [
        { path: "src/foo.ts", action: "modified", summary: "Added validation" },
      ],
      gitStats: { additions: 50, deletions: 10, filesChanged: 1 },
      summary: "Added input validation to the foo module.",
      decisions: [
        { what: "Used zod", why: "Runtime type checking", alternatives: ["joi", "manual"] },
      ],
      warnings: ["Requires Node 18+"],
    };

    await manager.setHandoff(handoff);
    const retrieved = await manager.getHandoff("test-graph-1", "task-a");

    expect(retrieved).not.toBeNull();
    expect(retrieved!.summary).toBe("Added input validation to the foo module.");
    expect(retrieved!.filesChanged).toHaveLength(1);
    expect(retrieved!.decisions).toHaveLength(1);
    expect(retrieved!.warnings).toContain("Requires Node 18+");
  });

  it("should return null for missing handoff", async () => {
    const result = await manager.getHandoff("test-graph-2", "nonexistent");
    expect(result).toBeNull();
  });

  it("should build prompt context from dependency handoffs", async () => {
    await manager.setHandoff({
      taskId: "task-1",
      graphId: "test-graph-3",
      filesChanged: [{ path: "src/a.ts", action: "added", summary: "New module" }],
      gitStats: { additions: 100, deletions: 0, filesChanged: 1 },
      summary: "Created the A module with core types.",
      decisions: [{ what: "Used interfaces", why: "Better for declaration merging", alternatives: ["type aliases"] }],
      warnings: ["A.ts exports must be re-exported from index.ts"],
    });

    await manager.setHandoff({
      taskId: "task-2",
      graphId: "test-graph-3",
      filesChanged: [{ path: "src/b.ts", action: "added", summary: "Helper functions" }],
      gitStats: { additions: 50, deletions: 0, filesChanged: 1 },
      summary: "Created B module with helper functions for A.",
      decisions: [],
      warnings: [],
    });

    const context = await manager.buildPromptContext("test-graph-3", ["task-1", "task-2"]);

    expect(context).toContain("Context from predecessor tasks");
    expect(context).toContain("task-1");
    expect(context).toContain("Created the A module");
    expect(context).toContain("Used interfaces");
    expect(context).toContain("A.ts exports must be re-exported");
    expect(context).toContain("task-2");
    expect(context).toContain("Created B module");
  });

  it("should gracefully handle missing handoffs in prompt context", async () => {
    const context = await manager.buildPromptContext("test-graph-4", ["missing-1", "missing-2"]);
    expect(context).toBe("");
  });

  // === Commits Field Tests ===

  it("should include commits in prompt context when handoff has commits array", async () => {
    await manager.setHandoff({
      taskId: "task-commits",
      graphId: "test-graph-commits",
      filesChanged: [{ path: "src/feature.ts", action: "added", summary: "New feature" }],
      gitStats: { additions: 80, deletions: 5, filesChanged: 1 },
      summary: "Implemented the new feature.",
      decisions: [],
      warnings: [],
      commits: [
        { sha: "abc1234567890def", message: "feat: initial feature skeleton" },
        { sha: "def9876543210abc", message: "feat: complete feature implementation" },
      ],
    });

    const context = await manager.buildPromptContext("test-graph-commits", ["task-commits"]);

    // Commits section should appear
    expect(context).toContain("**Commits:**");

    // Each commit SHA should be present (first 8 chars)
    expect(context).toContain("abc12345");
    expect(context).toContain("def98765");

    // Commit messages should appear
    expect(context).toContain("feat: initial feature skeleton");
    expect(context).toContain("feat: complete feature implementation");
  });

  it("should not render a commits section when handoff has no commits", async () => {
    await manager.setHandoff({
      taskId: "task-nocommits",
      graphId: "test-graph-nocommits",
      filesChanged: [],
      gitStats: { additions: 0, deletions: 0, filesChanged: 0 },
      summary: "Nothing was committed.",
      decisions: [],
      warnings: [],
      // commits field is absent
    });

    const context = await manager.buildPromptContext("test-graph-nocommits", ["task-nocommits"]);
    expect(context).not.toContain("**Commits:**");
  });

  it("should not render a commits section when handoff has an empty commits array", async () => {
    await manager.setHandoff({
      taskId: "task-emptycommits",
      graphId: "test-graph-emptycommits",
      filesChanged: [],
      gitStats: { additions: 0, deletions: 0, filesChanged: 0 },
      summary: "No commits made.",
      decisions: [],
      warnings: [],
      commits: [],
    });

    const context = await manager.buildPromptContext("test-graph-emptycommits", ["task-emptycommits"]);
    expect(context).not.toContain("**Commits:**");
  });
});
