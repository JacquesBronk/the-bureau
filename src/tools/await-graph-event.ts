import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { RedisClient } from "../redis.js";
import type { TaskGraphManager } from "../task-graph.js";
import { ProcessMonitor } from "../process-monitor.js";
import type { TaskEvent } from "../types.js";
import { formatDuration } from "../utils/format.js";
import type { ContextResolver } from "../runtime/connection-context.js";
import type { K8sJobStatus } from "../spawn/k8s-strategy.js";

async function buildProgressSummary(
  project: string,
  graphId: string,
  graphManager: TaskGraphManager,
  redis: RedisClient,
): Promise<string> {
  const tasks = await graphManager.getAllTasks(graphId);
  const completed = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;

  const parts: string[] = [`[${project}] ${completed}/${total} done`];

  // Show active tasks with phase + description
  const running = tasks.filter((t) => t.status === "running");
  for (const task of running) {
    if (!task.sessionId) {
      parts.push(`${task.id} running`);
      continue;
    }
    try {
      const peerData = await redis.get(`peers:${task.sessionId}`);
      if (peerData) {
        const peer = JSON.parse(peerData);
        const phase = peer.phase || "running";
        const desc = peer.description ? `: ${peer.description}` : "";
        const elapsed = task.startedAt ? ` (${formatDuration(Date.now() - task.startedAt)})` : "";
        parts.push(`${task.id} ${phase}${desc}${elapsed}`);
      } else {
        parts.push(`${task.id} running`);
      }
    } catch {
      parts.push(`${task.id} running`);
    }
  }

  // Show next pending task
  const pending = tasks.filter((t) =>
    ["pending", "ready", "awaiting_approval"].includes(t.status),
  );
  if (pending.length > 0) {
    parts.push(`${pending[0].id} ${pending[0].status}`);
    if (pending.length > 1) {
      parts.push(`+${pending.length - 1} more pending`);
    }
  }

  return parts.join(" | ");
}

export function registerAwaitGraphEvent(
  server: McpServer,
  /** Factory that creates a fresh Redis client for each blocking XREADGROUP call.
   *  Each invocation gets its own connection so concurrent HTTP sessions can block
   *  independently without serializing on a shared client. The factory is called
   *  once per tool invocation and the client is quit/disconnected before return. */
  createBlockingRedis: () => RedisClient,
  redis: RedisClient,
  getContext: ContextResolver,
  graphManager: TaskGraphManager,
  /** Consult the k8s Job status for pod-mode tasks instead of peer/PID liveness.
   *  Set only when the active spawn strategy is k8s; undefined disables k8s checks. */
  k8sJobStatus?: (graphId: string, taskId: string) => Promise<K8sJobStatus>,
): void {
  const initializedGroups = new Set<string>();

  registerInstrumentedTool(server,
    "await_graph_event",
    {
      title: "Await Graph Event",
      description: [
        "Block until task graph events arrive (zero-CPU, zero-token waiting).",
        "",
        "Returns an array of events (up to maxEvents) like: task_completed, task_failed,",
        "task_progress, task_approval_required, graph_completed, graph_validating,",
        "graph_validated, graph_validation_failed.",
        "",
        "task_progress events include the agent's current phase and description in the 'detail' field,",
        "giving you live visibility into what each agent is doing without polling.",
        "",
        "On TIMEOUT: returns a status snapshot of all running tasks with their phase, idle time,",
        "and liveness — so you don't need to call check_health separately. Also auto-detects",
        "dead agents and marks them failed before returning.",
        "",
        "IMPORTANT: Each response starts with a human-readable progress summary line.",
        "You MUST display this summary to the user before calling await_graph_event again.",
        "The user needs to see what agents are doing — do not silently consume the output.",
        "",
        "ORCHESTRATOR TIPS:",
        "- Use this in a loop to react to events as they arrive.",
        "- ALWAYS output the progress summary and key events to the user between calls.",
        "- On task_progress: relay the agent's phase and description to the user. For deeper inspection,",
        "  use get_agent_log with the event's sessionId.",
        "- On task_approval_required: read the task's handoff with get_handoff, then approve_task.",
        "- On task_completed: note the timing, continue waiting for more events.",
        "- On graph_completed or graph_validated: exit the loop, show final get_task_graph.",
        "- On graph_awaiting_children: keep waiting — the graph's own tasks are done but child graphs are still running.",
        "  The loop will resolve with graph_completed once all child graphs finish.",
        "- On TIMEOUT: review the included status snapshot. If agents are alive and working,",
        "  just call await_graph_event again. Don't call check_health separately — the snapshot",
        "  already has that info.",
      ].join("\n"),
      inputSchema: z.object({
        graphId: z.string().describe("Graph ID to watch events for"),
        project: z.string().describe("Project tag (events stream key)"),
        timeoutSeconds: z.number().default(300).describe("Max seconds to wait (default 300)"),
        maxEvents: z.number().default(10).describe("Max events to return per call (default 10)"),
      }),
    },
    async ({ graphId, project, timeoutSeconds, maxEvents }, extra) => {
      const ctx = getContext(extra);
      // MCP SDK v1.12+ passes AbortSignal in extra when the HTTP client disconnects.
      const signal = (extra as unknown as { signal?: AbortSignal } | undefined)?.signal;

      // Per-call blocking Redis client: each invocation gets its own connection so
      // concurrent HTTP-mode sessions can block independently without serializing on
      // a shared client. The client is cleaned up in the finally block.
      const blockingRedis = createBlockingRedis();
      // Suppress connection errors that fire when disconnect() is called on abort —
      // without this the uncaughtException handler would crash the server.
      blockingRedis.on('error', () => {});

      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        // disconnect() is synchronous and immediately closes the socket, unblocking
        // any in-flight XREADGROUP BLOCK command on this client.
        try { blockingRedis.disconnect(); } catch { /* best effort */ }
      };
      signal?.addEventListener('abort', onAbort);

      try {
        const streamKey = `events:${project}`;
        const groupName = "orchestrator";
        const consumerName = ctx.sessionId;

        // Lazily create consumer group
        if (!initializedGroups.has(streamKey)) {
          try {
            await blockingRedis.xgroup("CREATE", streamKey, groupName, "$", "MKSTREAM");
            initializedGroups.add(streamKey);
          } catch (e: any) {
            if (e.message?.includes("BUSYGROUP")) {
              initializedGroups.add(streamKey);
            } else {
              return {
                content: [{ type: "text" as const, text: `Error creating consumer group: ${e.message}` }],
                isError: true,
              };
            }
          }
        }

        const timeoutMs = timeoutSeconds * 1000;
        const deadline = Date.now() + timeoutMs;

        // Early exit: if the graph is already in a terminal state (failed, completed,
        // canceled) before we start waiting, return immediately instead of blocking
        // for the full timeout. This catches spawn failures (e.g. invalid role) that
        // set graph status to "failed" without emitting stream events.
        const preCheckGraph = await graphManager.getGraph(graphId);
        if (preCheckGraph && ["failed", "completed", "canceled"].includes(preCheckGraph.status)) {
          const summary = await buildProgressSummary(project, graphId, graphManager, redis);
          const tasks = await graphManager.getAllTasks(graphId);
          const completedCount = tasks.filter((t) => t.status === "completed").length;
          const shortId = graphId.slice(0, 8);
          return {
            content: [{ type: "text" as const, text: [
              summary,
              "",
              `Graph ${shortId} already ${preCheckGraph.status} — no events to wait for.`,
              `---`,
              JSON.stringify({
                type: "terminal",
                graphId,
                graphStatus: preCheckGraph.status,
                progress: `${completedCount}/${tasks.length} completed`,
              }, null, 2),
            ].join("\n") }],
          };
        }

        // Two-phase PEL recovery pattern (see Redis Streams consumer groups docs):
        // Phase 1: Read with '0' to drain any pending (unACKed) messages from a prior crash.
        // Phase 2: Once '0' returns empty, switch to '>' for new messages.
        let pelDrained = false;
        const ownerKey = `graph:${graphId}:orchestrator`;
        let lastLeaseRenewal = Date.now();
        const LEASE_RENEWAL_INTERVAL = 30_000;

        while (Date.now() < deadline && !aborted) {
          // Renew orchestrator ownership lease every 30s while we're actively waiting
          if (Date.now() - lastLeaseRenewal >= LEASE_RENEWAL_INTERVAL) {
            await redis.set(ownerKey, ctx.sessionId, "EX", 120);
            lastLeaseRenewal = Date.now();
          }
          const remainingMs = Math.max(deadline - Date.now(), 1000);
          const streamId = pelDrained ? ">" : "0";

          try {
            // Only BLOCK when reading new messages ('>'), not when draining PEL
            const blockArgs: (string | number)[] = pelDrained
              ? ["BLOCK", Math.min(remainingMs, 30_000)]
              : [];

            const args: (string | number)[] = [
              "GROUP", groupName, consumerName,
              "COUNT", maxEvents,
              ...blockArgs,
              "STREAMS", streamKey, streamId,
            ];
            const result = await (blockingRedis as any).xreadgroup(
              ...args,
            ) as [key: string, messages: [id: string, fields: string[]][]][] | null;

            if (!result || result[0][1].length === 0) {
              // PEL phase returned no pending messages — switch to live reads
              if (!pelDrained) {
                pelDrained = true;
              }
              continue;
            }

            const [, messages] = result[0];
            const matchedEvents: TaskEvent[] = [];

            for (const [messageId, fields] of messages) {
              const parsed: Record<string, string> = {};
              for (let i = 0; i < fields.length; i += 2) {
                parsed[fields[i]] = fields[i + 1];
              }

              await blockingRedis.xack(streamKey, groupName, messageId);

              if (parsed.graphId !== graphId) continue;

              matchedEvents.push({
                type: parsed.type as TaskEvent["type"],
                graphId: parsed.graphId,
                taskId: parsed.taskId || undefined,
                sessionId: parsed.sessionId || undefined,
                timestamp: parseInt(parsed.timestamp, 10),
                detail: parsed.detail || undefined,
                childGraphId: parsed.childGraphId || undefined,
              });
            }

            if (matchedEvents.length > 0) {
              const summary = await buildProgressSummary(project, graphId, graphManager, redis);
              const shortId = graphId.slice(0, 8);
              const lines: string[] = [summary, "", `Graph ${shortId} | ${matchedEvents.length} events`];
              for (const ev of matchedEvents) {
                const id = ev.taskId ?? "";
                const childPrefix = ev.childGraphId ? `[${ev.childGraphId.slice(0, 8)}] ` : "";
                switch (ev.type) {
                  case "task_started":
                    lines.push(`▶ ${childPrefix}${id} started${ev.detail ? ` (${ev.detail})` : ""}`);
                    break;
                  case "task_progress":
                    lines.push(`◐ ${childPrefix}${id} — ${ev.detail ?? ""}`);
                    break;
                  case "task_completed":
                    lines.push(`✓ ${childPrefix}${id} completed (${ev.detail ?? ""})`);
                    break;
                  case "task_failed":
                    lines.push(`✗ ${childPrefix}${id} FAILED — ${ev.detail ?? ""}`);
                    break;
                  case "task_dead":
                    lines.push(`💀 ${childPrefix}${id} DEAD (PID gone) — ${ev.detail ?? ""}`);
                    break;
                  case "task_warning":
                    lines.push(`⚠ ${childPrefix}${id} — ${ev.detail ?? ""}`);
                    break;
                  case "task_approval_required":
                    lines.push(`⏸ ${childPrefix}${id} awaiting approval`);
                    break;
                  case "graph_completed":
                    lines.push(ev.childGraphId ? `━━ Child graph ${ev.childGraphId.slice(0, 8)} complete ━━` : `━━ Graph complete ━━`);
                    break;
                  case "child_graph_completed":
                    lines.push(`━━ Child graph ${(ev.detail ?? ev.childGraphId ?? "").slice(0, 8)} complete ━━`);
                    break;
                  case "graph_validating":
                    lines.push(`🔍 ${childPrefix}Validation started`);
                    break;
                  case "graph_validated":
                    lines.push(`━━ ${childPrefix}Validation passed ━━`);
                    break;
                  case "graph_validation_failed":
                    lines.push(`━━ ${childPrefix}Validation FAILED ━━`);
                    break;
                  case "task_added":
                    lines.push(`+ ${childPrefix}${id} added to graph`);
                    break;
                  default:
                    lines.push(`? ${childPrefix}${ev.type}${id ? ` (${id})` : ""}`);
                }
              }
              const rawJson = JSON.stringify({ summary, events: matchedEvents, count: matchedEvents.length }, null, 2);
              return {
                content: [{
                  type: "text" as const,
                  text: `${lines.join("\n")}\n---\n${rawJson}`,
                }],
              };
            }
          } catch (e: any) {
            // An intentional disconnect() from the abort handler throws a connection
            // error — break to the timeout path rather than returning an error response.
            if (aborted) break;
            return {
              content: [{ type: "text" as const, text: `Error reading events: ${e.message}` }],
              isError: true,
            };
          }
        }

      // TIMEOUT: Build a status snapshot of running tasks + detect dead agents
      const tasks = await graphManager.getAllTasks(graphId);
      const runningTasks = tasks.filter((t) => t.status === "running");
      const snapshot: any[] = [];
      let deadDetected = false;

      for (const task of runningTasks) {
        if (!task.sessionId) continue;

        // Re-fetch to catch exit handler completing the task during our processing window
        const freshTask = await graphManager.getTask(graphId, task.id);
        if (freshTask?.status === 'completed') continue;

        // k8s pod-mode tasks: liveness is Job status, not the peer record.
        // The peer record has a 60s TTL and can expire during long silent work
        // (npm ci, git clone, vitest, build) even while the worker pod is running.
        // Consulting peer/PID for these tasks would produce false dead-agent signals.
        if (task.podMode) {
          const elapsed = task.startedAt
            ? `${Math.round((Date.now() - task.startedAt) / 1000)}s`
            : "unknown";
          if (k8sJobStatus) {
            let jobStatus: K8sJobStatus;
            try {
              jobStatus = await k8sJobStatus(graphId, task.id);
            } catch {
              // Status check failed — treat as alive; health sweep will finalize.
              snapshot.push({ taskId: task.id, role: task.role, status: "k8s status check failed (retrying)", isAlive: true, elapsed });
              continue;
            }
            if (jobStatus === "active") {
              snapshot.push({ taskId: task.id, role: task.role, phase: "running (k8s)", isAlive: true, elapsed });
            } else if (jobStatus === "failed") {
              await graphManager.onTaskFailed(graphId, task.id, task.sessionId!, 1);
              deadDetected = true;
              snapshot.push({ taskId: task.id, role: task.role, status: "DEAD — k8s Job failed", elapsed });
            } else {
              // "succeeded" or "gone" (Job ran to completion and TTL-expired) — treat as completed.
              // Consistent with health-sweep's handling of the same statuses.
              await graphManager.onTaskCompleted(graphId, task.id, task.sessionId!, 0);
              deadDetected = true;
              snapshot.push({ taskId: task.id, role: task.role, status: `COMPLETED — k8s Job ${jobStatus}`, elapsed });
            }
          } else {
            // No k8sJobStatus accessor — skip dead detection to avoid false positives;
            // the health sweep will finalize this task once the Job reaches terminal state.
            const elapsed2 = task.startedAt
              ? `${Math.round((Date.now() - task.startedAt) / 1000)}s`
              : "unknown";
            snapshot.push({ taskId: task.id, role: task.role, phase: "running (k8s, liveness via health sweep)", isAlive: true, elapsed: elapsed2 });
          }
          continue;
        }

        const peerData = await redis.get(`peers:${task.sessionId}`);
        if (!peerData) {
          // Peer expired — agent is dead. Mark failed and return as event.
          await graphManager.onTaskFailed(graphId, task.id, task.sessionId, 1);
          deadDetected = true;
          snapshot.push({
            taskId: task.id, role: task.role, status: "DEAD — marked failed",
            elapsed: task.startedAt ? `${Math.round((Date.now() - task.startedAt) / 1000)}s` : "unknown",
          });
          continue;
        }

        const peer = JSON.parse(peerData);
        const isAlive = ProcessMonitor.isPidAlive(peer.pid);

        if (!isAlive) {
          await graphManager.onTaskFailed(graphId, task.id, task.sessionId, 1);
          deadDetected = true;
          snapshot.push({
            taskId: task.id, role: task.role, status: "DEAD (PID gone) — marked failed",
            elapsed: task.startedAt ? `${Math.round((Date.now() - task.startedAt) / 1000)}s` : "unknown",
          });
          continue;
        }

        const idleSeconds = Math.round((Date.now() - (peer.lastActivity || peer.startedAt)) / 1000);
        snapshot.push({
          taskId: task.id, role: task.role, phase: peer.phase,
          description: peer.description || "",
          isAlive: true, idleSeconds,
          elapsed: task.startedAt ? `${Math.round((Date.now() - task.startedAt) / 1000)}s` : "unknown",
        });
      }

      // Also include completion summary
      const completedCount = tasks.filter((t) => t.status === "completed").length;
      const graph = await graphManager.getGraph(graphId);

      const timeoutResponse = {
        type: "timeout",
        graphId,
        waitedSeconds: timeoutSeconds,
        graphStatus: graph?.status || "unknown",
        progress: `${completedCount}/${tasks.length} completed`,
        runningTasks: snapshot,
        deadAgentsRecovered: deadDetected,
        hint: deadDetected
          ? "Dead agents were detected and marked failed. Call await_graph_event again to get the resulting events."
          : snapshot.length > 0
            ? "All running agents are alive. They may be doing long-running work (e.g., installing dependencies, generating large files). Call await_graph_event again to continue waiting."
            : "No running tasks. Check get_task_graph for the final state.",
      };

      const shortId = graphId.slice(0, 8);
      const summary = await buildProgressSummary(project, graphId, graphManager, redis);
      const tableLines: string[] = [
        summary,
        "",
        `TIMEOUT after ${timeoutSeconds}s — Graph ${shortId} | ${completedCount}/${tasks.length} completed | status: ${graph?.status ?? "unknown"}`,
        "",
        `${"Task".padEnd(32)} ${"Status".padEnd(28)} ${"Phase".padEnd(20)} Idle`,
        `${"-".repeat(32)} ${"-".repeat(28)} ${"-".repeat(20)} ${"-".repeat(8)}`,
      ];
      for (const row of snapshot) {
        const status: string = row.status ?? (row.isAlive ? "running" : "?");
        const phase: string = row.phase ?? "";
        const idle: string = row.idleSeconds != null ? `${row.idleSeconds}s` : row.elapsed ?? "";
        tableLines.push(
          `${String(row.taskId).padEnd(32)} ${status.padEnd(28)} ${phase.padEnd(20)} ${idle}`,
        );
      }
      if (snapshot.length === 0) {
        tableLines.push("  (no running tasks)");
      }
      tableLines.push("");
      tableLines.push(timeoutResponse.hint);

      const rawJson = JSON.stringify(timeoutResponse, null, 2);
      return {
        content: [{
          type: "text" as const,
          text: `${tableLines.join("\n")}\n---\n${rawJson}`,
        }],
      };

      } finally {
        signal?.removeEventListener('abort', onAbort);
        // Quit the per-call client whether we returned events, timed out, or aborted.
        // For the abort case disconnect() already ran, so quit() will be a no-op.
        await blockingRedis.quit().catch(() => {});
      }
    },
    getContext,
  );
}
