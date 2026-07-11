/**
 * Tests for k8s pod-mode dead-detection in await_graph_event timeout handler.
 *
 * Covers issue #160: k8s workers doing long silent work (npm ci, git clone,
 * vitest, build) have no Bureau MCP activity, so their 60s peer-record TTL
 * expires. Previously, the timeout handler saw no peer data and marked the
 * task dead (false positive). These tests verify that:
 *
 *  1. A podMode task whose Job is still Running is NOT marked dead, even
 *     though its peer record has expired and MCP idle time exceeds staleAfterMs.
 *  2. A podMode task whose Job has Succeeded is reconciled as completed.
 *  3. A podMode task whose Job has Failed or is Gone is correctly marked failed.
 *  4. When no k8sJobStatus accessor is provided, podMode tasks are left alone
 *     (conservative: health sweep finalizes them instead).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAwaitGraphEvent } from "../../src/tools/await-graph-event.js";
import { ProcessMonitor } from "../../src/process-monitor.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";
import type { K8sJobStatus } from "../../src/spawn/k8s-strategy.js";

const GRAPH_ID = "graph-k8s-test";
const PROJECT = "k8s-project";
const SESSION_ID = "orch-session-k8s";

/**
 * Build a handler wired for the timeout path with a podMode task.
 *
 * With timeoutSeconds:0 the while-loop deadline is already past, so the handler
 * goes directly to the timeout/dead-detection block — no XREADGROUP blocking.
 */
function buildK8sTimeoutHandler(opts: {
  k8sJobStatus?: (graphId: string, taskId: string) => Promise<K8sJobStatus>;
  peerData?: string | null;
  taskStartedAgo?: number;
}) {
  const {
    k8sJobStatus,
    peerData = null,   // peer expired by default (realistic for long-running workers)
    taskStartedAgo = 300_000, // 5 min ago — well past staleAfterMs=120s
  } = opts;

  let handler: (args: any) => Promise<any>;

  const mockServer = {
    registerTool: (_: string, __: any, h: typeof handler) => { handler = h; },
  } as any;

  const blockingRedis = {
    xgroup: vi.fn().mockRejectedValue(
      Object.assign(new Error("BUSYGROUP Consumer Group name already exists"), {}),
    ),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
  } as any;

  const redis = {
    get: vi.fn().mockResolvedValue(peerData),
    set: vi.fn().mockResolvedValue("OK"),
  } as any;

  const onTaskFailed = vi.fn().mockResolvedValue(undefined);
  const onTaskCompleted = vi.fn().mockResolvedValue(undefined);

  const podModeTask = {
    id: "task-k8s-worker",
    status: "running",
    sessionId: "sess-k8s-worker",
    startedAt: Date.now() - taskStartedAgo,
    role: "coder",
    podMode: true,
  };

  const graphManager = {
    getAllTasks: vi.fn().mockResolvedValue([podModeTask]),
    // Re-fetch guard: task still running (peer/PID checks use this snapshot)
    getTask: vi.fn().mockResolvedValue({ ...podModeTask }),
    getGraph: vi.fn().mockResolvedValue({ status: "active" }),
    onTaskFailed,
    onTaskCompleted,
  } as any;

  registerAwaitGraphEvent(
    mockServer,
    () => blockingRedis,
    redis,
    createStaticResolver({ sessionId: SESSION_ID }),
    graphManager,
    k8sJobStatus,
  );

  return { handler: handler!, onTaskFailed, onTaskCompleted };
}

describe("await_graph_event — k8s pod-mode dead detection (#160)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Peer/PID path should never be reached for podMode tasks — spy to catch leakage.
    vi.spyOn(ProcessMonitor, "isPidAlive").mockReturnValue(false);
  });

  it("does NOT mark a podMode task dead when its Job is still active (peer expired)", async () => {
    // Scenario: k8s worker doing npm ci for 5 minutes. Peer record expired (60s TTL)
    // but the Job is Running. Must NOT call onTaskFailed.
    const k8sJobStatus = vi.fn().mockResolvedValue("active" as K8sJobStatus);
    const { handler, onTaskFailed, onTaskCompleted } = buildK8sTimeoutHandler({
      k8sJobStatus,
      peerData: null,  // peer expired
    });

    const result = await handler({
      graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10,
    });

    expect(k8sJobStatus).toHaveBeenCalledWith(GRAPH_ID, "task-k8s-worker");
    expect(onTaskFailed).not.toHaveBeenCalled();
    expect(onTaskCompleted).not.toHaveBeenCalled();
    // Should still appear in the status snapshot as alive
    const text = result.content[0].text;
    expect(text).toContain("task-k8s-worker");
    // isPidAlive must never be called for podMode tasks (wrong signal)
    expect(ProcessMonitor.isPidAlive).not.toHaveBeenCalled();
  });

  it("does NOT mark a podMode task dead when its Job is active AND peer data present", async () => {
    // Scenario: peer record still fresh (worker called set_status recently) and Job running.
    const k8sJobStatus = vi.fn().mockResolvedValue("active" as K8sJobStatus);
    const peerData = JSON.stringify({ pid: 0, phase: "implementing", description: "running npm ci" });
    const { handler, onTaskFailed, onTaskCompleted } = buildK8sTimeoutHandler({
      k8sJobStatus,
      peerData,
    });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    expect(onTaskFailed).not.toHaveBeenCalled();
    expect(onTaskCompleted).not.toHaveBeenCalled();
    expect(ProcessMonitor.isPidAlive).not.toHaveBeenCalled();
  });

  it("marks a podMode task completed when its Job has Succeeded", async () => {
    // Scenario: worker pushed commits and exited cleanly. Job=Succeeded.
    // The merge-to-base must proceed, not be skipped. onTaskCompleted must be called.
    const k8sJobStatus = vi.fn().mockResolvedValue("succeeded" as K8sJobStatus);
    const { handler, onTaskFailed, onTaskCompleted } = buildK8sTimeoutHandler({
      k8sJobStatus,
      peerData: null,  // peer expired after clean exit
    });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    expect(k8sJobStatus).toHaveBeenCalledWith(GRAPH_ID, "task-k8s-worker");
    expect(onTaskCompleted).toHaveBeenCalledWith(GRAPH_ID, "task-k8s-worker", "sess-k8s-worker", 0);
    expect(onTaskFailed).not.toHaveBeenCalled();
  });

  it("marks a podMode task failed when its Job has Failed", async () => {
    // Scenario: worker pod crashed or the claude process exited non-zero. Job=Failed.
    const k8sJobStatus = vi.fn().mockResolvedValue("failed" as K8sJobStatus);
    const { handler, onTaskFailed, onTaskCompleted } = buildK8sTimeoutHandler({
      k8sJobStatus,
    });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    expect(onTaskFailed).toHaveBeenCalledWith(GRAPH_ID, "task-k8s-worker", "sess-k8s-worker", 1);
    expect(onTaskCompleted).not.toHaveBeenCalled();
  });

  it("marks a podMode task completed when its Job is Gone (TTL-expired after running)", async () => {
    // Scenario: Job ran to completion and the k8s TTL cleaned it up before we checked.
    // Treat as completed (consistent with health-sweep's handling of 'gone').
    const k8sJobStatus = vi.fn().mockResolvedValue("gone" as K8sJobStatus);
    const { handler, onTaskFailed, onTaskCompleted } = buildK8sTimeoutHandler({
      k8sJobStatus,
    });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    expect(onTaskCompleted).toHaveBeenCalledWith(GRAPH_ID, "task-k8s-worker", "sess-k8s-worker", 0);
    expect(onTaskFailed).not.toHaveBeenCalled();
  });

  it("skips dead detection for podMode tasks when no k8sJobStatus is provided", async () => {
    // Scenario: engine is non-k8s (or pre-upgrade with lingering podMode tasks).
    // Conservative: don't mark dead if we can't verify — health sweep handles it.
    const { handler, onTaskFailed, onTaskCompleted } = buildK8sTimeoutHandler({
      k8sJobStatus: undefined,
      peerData: null,
    });

    const result = await handler({
      graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10,
    });

    expect(onTaskFailed).not.toHaveBeenCalled();
    expect(onTaskCompleted).not.toHaveBeenCalled();
    // Task still shown in snapshot as alive
    const text = result.content[0].text;
    expect(text).toContain("task-k8s-worker");
    expect(ProcessMonitor.isPidAlive).not.toHaveBeenCalled();
  });

  it("falls back to alive when k8sJobStatus throws", async () => {
    // Scenario: transient k8s API error. Don't false-kill; health sweep retries.
    const k8sJobStatus = vi.fn().mockRejectedValue(new Error("k8s API timeout"));
    const { handler, onTaskFailed, onTaskCompleted } = buildK8sTimeoutHandler({
      k8sJobStatus,
    });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    expect(onTaskFailed).not.toHaveBeenCalled();
    expect(onTaskCompleted).not.toHaveBeenCalled();
  });
});
