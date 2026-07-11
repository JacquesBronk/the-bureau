import { describe, it, expect, vi, beforeEach } from "vitest";

// scanKeys is the graph-discovery seam — mock it per test.
vi.mock("../src/redis.js", () => ({
  scanKeys: vi.fn(() => Promise.resolve([])),
}));

import { reapStaleGraphs, STALE_GRAPH_MS } from "../src/health-sweep.js";
import { scanKeys } from "../src/redis.js";

const OLD = Date.now() - STALE_GRAPH_MS - 60_000; // safely past the idle horizon
const RECENT = Date.now() - 60_000;               // 1 min ago

function makeDeps(graphs: Record<string, any>, tasks: Record<string, any[]>) {
  const reapStaleGraph = vi.fn(async () => true);
  const deps: any = {
    redis: {
      // NX claim always succeeds in these tests
      set: vi.fn(async () => "OK"),
    },
    sessionId: "sweeper-1",
    graphManager: {
      getGraph: vi.fn(async (gid: string) => graphs[gid] ?? null),
      getAllTasks: vi.fn(async (gid: string) => tasks[gid] ?? []),
      reapStaleGraph,
    },
    log: { warn: vi.fn() },
    notify: vi.fn(),
  };
  return { deps, reapStaleGraph };
}

describe("reapStaleGraphs (#232)", () => {
  beforeEach(() => {
    vi.mocked(scanKeys).mockReset();
  });

  it("reaps a validating graph with all-terminal tasks idle past the horizon", async () => {
    vi.mocked(scanKeys).mockResolvedValue(["graph:g1:taskIds"]);
    const { deps, reapStaleGraph } = makeDeps(
      { g1: { status: "validating", createdAt: OLD } },
      { g1: [{ status: "completed", completedAt: OLD }] },
    );
    await reapStaleGraphs(deps);
    expect(reapStaleGraph).toHaveBeenCalledWith("g1", expect.stringContaining("validating"));
  });

  it("does NOT reap a graph with a live (running) task", async () => {
    vi.mocked(scanKeys).mockResolvedValue(["graph:g1:taskIds"]);
    const { deps, reapStaleGraph } = makeDeps(
      { g1: { status: "active", createdAt: OLD } },
      { g1: [{ status: "running", startedAt: OLD }] },
    );
    await reapStaleGraphs(deps);
    expect(reapStaleGraph).not.toHaveBeenCalled();
  });

  it("does NOT reap a recently-active graph (within the idle horizon)", async () => {
    vi.mocked(scanKeys).mockResolvedValue(["graph:g1:taskIds"]);
    const { deps, reapStaleGraph } = makeDeps(
      { g1: { status: "validating", createdAt: RECENT } },
      { g1: [{ status: "completed", completedAt: RECENT }] },
    );
    await reapStaleGraphs(deps);
    expect(reapStaleGraph).not.toHaveBeenCalled();
  });

  it("does NOT reap a parent graph that has a still-active child graph", async () => {
    vi.mocked(scanKeys).mockResolvedValue(["graph:parent:taskIds", "graph:child:taskIds"]);
    const { deps, reapStaleGraph } = makeDeps(
      {
        parent: { status: "validating", createdAt: OLD },
        child: { status: "active", createdAt: RECENT, parentGraphId: "parent" },
      },
      {
        parent: [{ status: "completed", completedAt: OLD }],
        child: [{ status: "running", startedAt: RECENT }],
      },
    );
    await reapStaleGraphs(deps);
    expect(reapStaleGraph).not.toHaveBeenCalledWith("parent", expect.anything());
  });

  it("does NOT reap an already-terminal graph", async () => {
    vi.mocked(scanKeys).mockResolvedValue(["graph:g1:taskIds"]);
    const { deps, reapStaleGraph } = makeDeps(
      { g1: { status: "completed", createdAt: OLD } },
      { g1: [{ status: "completed", completedAt: OLD }] },
    );
    await reapStaleGraphs(deps);
    expect(reapStaleGraph).not.toHaveBeenCalled();
  });

  it("skips reaping when the single-reaper claim is already held", async () => {
    vi.mocked(scanKeys).mockResolvedValue(["graph:g1:taskIds"]);
    const { deps, reapStaleGraph } = makeDeps(
      { g1: { status: "validating", createdAt: OLD } },
      { g1: [{ status: "completed", completedAt: OLD }] },
    );
    deps.redis.set = vi.fn(async () => null); // NX claim fails (another replica owns it)
    await reapStaleGraphs(deps);
    expect(reapStaleGraph).not.toHaveBeenCalled();
  });

  // #317 phase3 (Task 7, item c) — reworking joins the status guard so a genuinely-stuck
  // reworking graph (a broken fix loop, no resume driver ever able to advance it) is not
  // immortal.
  it("reaps a genuinely-stuck reworking graph (all-terminal tasks, old round, idle past the horizon)", async () => {
    vi.mocked(scanKeys).mockResolvedValue(["graph:g1:taskIds"]);
    const { deps, reapStaleGraph } = makeDeps(
      {
        g1: {
          status: "reworking", createdAt: OLD,
          currentRound: { attempt: 1, startHead: "", enteredAt: OLD, validationChildIds: [] },
        },
      },
      { g1: [{ status: "completed", completedAt: OLD }] },
    );
    await reapStaleGraphs(deps);
    expect(reapStaleGraph).toHaveBeenCalledWith("g1", expect.stringContaining("reworking"));
  });

  // #317 phase3 (Task 7, item d) — currentRound.enteredAt folded into the reaper's `last`.
  it("does NOT reap a healthy mid-round reworking graph — recent currentRound.enteredAt protects it despite stale (round-0-frozen) task timestamps", async () => {
    vi.mocked(scanKeys).mockResolvedValue(["graph:g1:taskIds"]);
    const { deps, reapStaleGraph } = makeDeps(
      {
        g1: {
          status: "reworking", createdAt: OLD,
          // The parent's OWN tasks are frozen at round entry (already terminal before the
          // round ever began) — only currentRound.enteredAt reflects the live round.
          currentRound: { attempt: 1, startHead: "", enteredAt: RECENT, validationChildIds: [] },
        },
      },
      { g1: [{ status: "completed", completedAt: OLD }] },
    );
    await reapStaleGraphs(deps);
    expect(reapStaleGraph).not.toHaveBeenCalled();
  });

  // #317 phase3 (Task 7, item d) — child (fix/re-validation) graph timestamps folded into
  // the reaper's `last` too — covers the idle window right after a fix child completes
  // (inter-step (c)), where the child is no longer "active" so parentsWithActiveChild alone
  // does not protect the parent.
  it("does NOT reap a healthy mid-round reworking graph — a recently-terminal fix-child's completedAt protects it", async () => {
    vi.mocked(scanKeys).mockResolvedValue(["graph:g1:taskIds", "graph:fix1:taskIds"]);
    const { deps, reapStaleGraph } = makeDeps(
      {
        g1: {
          status: "reworking", createdAt: OLD, childGraphIds: ["fix1"],
          currentRound: { attempt: 1, startHead: "", enteredAt: OLD, validationChildIds: [] },
        },
        fix1: { status: "completed", createdAt: OLD, completedAt: RECENT, isReworkFixChild: true, attempt: 1 },
      },
      {
        g1: [{ status: "completed", completedAt: OLD }],
        fix1: [{ status: "completed", completedAt: RECENT }],
      },
    );
    await reapStaleGraphs(deps);
    expect(reapStaleGraph).not.toHaveBeenCalled();
  });
});
