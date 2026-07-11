import { readFileSync, existsSync } from 'node:fs';
import type pino from 'pino';
import { ProcessMonitor } from './process-monitor.js';
import { scanKeys } from './redis.js';
import type { RedisClient } from './redis.js';
import type { TaskGraphManager } from './task-graph.js';
import type { TaskGraph } from './types/graph.js';
import type { ActivityMonitor } from './activity-monitor.js';
import type { TestServiceManager } from './spawn/test-service-manager.js';
import { onTaskWarning, onTaskStale, onTaskDead, onTaskTimeout, onZombieDetected } from './telemetry/domain/health.js';
import { onTranscriptRead } from './telemetry/domain/transcript.js';
import type { K8sJobStatus } from './spawn/k8s-strategy.js';
import { interrogateTranscript } from './interrogator.js';
import { defaultWorkerBranch } from './spawn/k8s-dispatch.js';
import { pushDirective } from './directives.js';

export interface HealthSweepDeps {
  redis: RedisClient;
  sessionId: string;
  graphManager: TaskGraphManager;
  processMonitor: ProcessMonitor;
  activityMonitor: ActivityMonitor;
  log: pino.Logger;
  notify: (level: 'info' | 'warning' | 'error', message: string) => void;
  /** Restart-durable k8s exit detection: query a worker Job's status by graph/task.
   *  Set only when the active strategy is k8s. When undefined, pid<=0 tasks are skipped. */
  k8sJobStatus?: (graphId: string, taskId: string) => Promise<K8sJobStatus>;
  /** Gracefully terminate a worker session via the spawn strategy. For k8s this deletes
   *  the Job (→ SIGTERM with grace), letting the worker's entrypoint finalize() commit+push
   *  its WIP before the pod dies. Required for pid<=0 workers because processMonitor.killProcess
   *  is a no-op for them — without it the auto-kill paths never actually terminate the pod (#171 P1). */
  killWorker?: (sessionId: string, ctx?: { graphId: string; taskId: string; sessionLogPath?: string }) => boolean | void;
  /** When set and returns false, this replica is a follower — the sweep no-ops.
   *  When undefined (non-HA / tests), the sweep always runs. */
  isLeader?: () => boolean;
  /** Test-service broker. When set, the sweep renews every supervised ACTIVE graph's
   *  test-service leases each cycle, so a live worker's Redis/Postgres never expires under
   *  it (#233). Optional — undefined in local mode / tests without the broker. */
  testServiceManager?: TestServiceManager;
}

/**
 * Runs one iteration of the 30-second health sweep.
 *
 * Checks:
 * 1. Locally tracked processes — stale/dead detection + timeout kills
 * 2. Startup health gate — agents that produced no log output within 30s
 * 3. Cleanup of checkpoint branches and old logs
 * 4. Cross-session dead detection via Redis
 */
export async function runHealthSweep(deps: HealthSweepDeps): Promise<void> {
  if (deps.isLeader && !deps.isLeader()) return;

  const { redis, sessionId, graphManager, processMonitor, activityMonitor, log, notify, k8sJobStatus, killWorker, testServiceManager } = deps;

  // 1. Check locally tracked processes (spawned by this MCP server)
  const entries = processMonitor.getAll();
  for (const entry of entries) {
    if (entry.taskId && entry.graphId) {
      // Skip entries where handleExit is already processing — the exit handler
      // will handle completion/failure after its grace period (#112)
      if (processMonitor.isExitPending(entry.sessionId)) continue;

      const task = await graphManager.getTask(entry.graphId, entry.taskId);
      const staleMs = task?.staleAfterMs ?? 600_000;

      // Fetch peer phase for adaptive threshold (locally tracked processes)
      const peerData = await redis.get(`peers:${entry.sessionId}`);
      const peer = peerData ? JSON.parse(peerData) : null;

      // Fetch last activity timestamp
      const metrics = await activityMonitor.getMetrics(entry.sessionId);
      if (metrics) {
        const check = ProcessMonitor.checkStaleOrDead({
          pid: entry.pid,
          lastActivityMs: metrics.lastActivity,
          staleAfterMs: staleMs,
          phase: peer?.phase,
        });

        if (check.outcome === 'dead') {
          const inference = await ProcessMonitor.inferDeathOutcome({
            phase: peer?.phase,
            cwd: entry.cwd,
            taskStartedAt: entry.startedAt,
          });
          // Re-fetch task to catch exit handler completing it during our grace window
          const taskSnapshot = await graphManager.getTask(entry.graphId, entry.taskId);
          if (taskSnapshot?.status === 'completed' || taskSnapshot?.status === 'failed' || taskSnapshot?.status === 'canceled') {
            log.debug({ taskId: entry.taskId, status: taskSnapshot.status }, 'skipping dead detection: task already in terminal state');
            processMonitor.remove(entry.sessionId);
            continue;
          }
          const existingResult = await redis.get(`result:${entry.graphId}:${entry.taskId}`);
          if (existingResult) {
            log.debug({ taskId: entry.taskId }, 'skipping dead detection: result already exists in Redis');
            processMonitor.remove(entry.sessionId);
            continue;
          }
          log.warn(
            { agentSessionId: entry.sessionId, role: entry.role, taskId: entry.taskId, graphId: entry.graphId, inferredOutcome: inference.outcome, reason: inference.reason },
            `dead agent detected (PID gone) during health check — inferred ${inference.outcome}`,
          );
          if (inference.outcome === 'completed') {
            // Emit task_warning since exit code is unknown (inferred, not confirmed)
            await graphManager.emitEventPublic({
              type: 'task_warning', graphId: entry.graphId,
              taskId: entry.taskId, sessionId: entry.sessionId,
              timestamp: Date.now(), detail: `Agent died but inferred completed: ${inference.reason}`,
            });
            try { onTaskWarning({ taskId: entry.taskId, graphId: entry.graphId, role: entry.role, reason: 'pid_gone' }); } catch { /* swallow */ }
            await graphManager.onTaskCompleted(entry.graphId, entry.taskId, entry.sessionId, 0);
            processMonitor.remove(entry.sessionId);
          } else {
            await graphManager.onTaskFailed(entry.graphId, entry.taskId, entry.sessionId, 1);
          }
          // Re-check status: if exit handler already completed this task, suppress task_dead
          const taskAfterHandle = await graphManager.getTask(entry.graphId, entry.taskId);
          if (taskAfterHandle?.status !== 'completed') {
            await graphManager.emitEventPublic({
              type: 'task_dead', graphId: entry.graphId,
              taskId: entry.taskId, sessionId: entry.sessionId,
              timestamp: Date.now(), detail: check.detail,
            });
            try { onTaskDead({ taskId: entry.taskId, graphId: entry.graphId, role: entry.role, reason: 'pid_gone' }); } catch { /* swallow */ }
          }
          notify('warning', `[the-bureau] Agent ${entry.role} (task: ${entry.taskId}) PID gone — inferred ${inference.outcome}`);
        } else if (check.outcome === 'stale') {
          log.warn(
            { agentSessionId: entry.sessionId, role: entry.role, taskId: entry.taskId, graphId: entry.graphId, effectiveThresholdMs: check.effectiveThresholdMs },
            'stale agent detected',
          );
          await graphManager.emitEventPublic({
            type: 'task_stale', graphId: entry.graphId,
            taskId: entry.taskId, sessionId: entry.sessionId,
            timestamp: Date.now(), detail: check.detail,
          });
          try { onTaskStale({ taskId: entry.taskId, graphId: entry.graphId, role: entry.role, reason: 'heartbeat' }); } catch { /* swallow */ }
          notify('warning', `[the-bureau] Agent ${entry.role} (task: ${entry.taskId}) appears stale`);
        }
      }

      // Interrogation watcher: detect stuck workers BEFORE the hard timeoutMs kill.
      // All logic is fail-safe — exceptions are swallowed, never thrown into the sweep.
      // Never interrogate the sidecar's own diagnosis graph (project "interrogation"):
      // its diag task has a short timeoutMs, so its derived interrogateAfterMs (~0.4×)
      // could otherwise fire and recursively spawn another sidecar — an unbounded loop.
      {
        const elapsed = Date.now() - entry.startedAt;
        const interrogateAfterMs = task?.interrogateAfterMs ??
          (task?.timeoutMs ? Math.floor(task.timeoutMs * 0.4) : undefined);
        const pastTimeout = !!(task?.timeoutMs && elapsed > task.timeoutMs);
        const isInterrogationGraph = task?.project === 'interrogation';

        if (!isInterrogationGraph && !pastTimeout && interrogateAfterMs && elapsed > interrogateAfterMs) {
          try {
            // (1) Resolve transcript path
              let transcriptPath: string | null = null;
              if (task?.sessionLogPath) {
                transcriptPath = task.sessionLogPath;
              } else if (entry.logFile && !entry.logFile.startsWith('k8s://') && existsSync(entry.logFile)) {
                transcriptPath = entry.logFile;
              }

              if (transcriptPath) {
                // (2) Debounce per threshold class via Redis NX (900s = 15 min)
                const debounceKey = `interrogate:${entry.graphId}:${entry.taskId}:1`;
                const acquired = await redis.set(debounceKey, '1', 'EX', 900, 'NX');
                if (acquired) {
                  // (3) Read transcript tail
                  const tail = ProcessMonitor.readLogTail(transcriptPath, 16384);
                  // Visibility (#313-B P1): count the read outcome. Read semantics
                  // (16 KB tail) are unchanged — this only observes.
                  onTranscriptRead('interrogation', tail ? 'ok' : 'missing');
                  if (tail) {
                    // (4) Classify
                    const diag = interrogateTranscript(tail);
                    log.info(
                      { agentSessionId: entry.sessionId, taskId: entry.taskId, graphId: entry.graphId, verdict: diag.verdict, confidence: diag.confidence, loopSignature: diag.loopSignature },
                      `interrogation: ${diag.verdict} (confidence ${diag.confidence.toFixed(2)})`,
                    );

                    if (diag.verdict === 'stuck' && diag.confidence >= 0.7) {
                      // (5) D7 escalation: hint first, kill on second confident-stuck.
                      const hintedKey = `interrogate:hinted:${entry.graphId}:${entry.taskId}`;
                      const alreadyHinted = !!(await redis.exists(hintedKey));
                      if (!alreadyHinted && diag.recommendedHint) {
                        // First confident-stuck — push directive hint, don't kill yet.
                        log.info(
                          { agentSessionId: entry.sessionId, taskId: entry.taskId, graphId: entry.graphId, loopSignature: diag.loopSignature },
                          'interrogation: confident stuck — pushing hint directive (not killing yet)',
                        );
                        try {
                          await pushDirective(redis, entry.graphId, entry.taskId, {
                            author: 'engine-interrogator',
                            message: diag.recommendedHint,
                            ts: Date.now(),
                            provenance: { subject: 'engine-interrogator', graphId: entry.graphId, taskId: entry.taskId },
                          });
                        } catch { /* hint push failure must not break sweep */ }
                        await redis.set(hintedKey, '1', 'EX', 1800);
                      } else {
                        // Second confident-stuck (already hinted), or no hint available — kill.
                        log.warn(
                          { agentSessionId: entry.sessionId, taskId: entry.taskId, graphId: entry.graphId, loopSignature: diag.loopSignature, missing: diag.missing },
                          'interrogation: confident stuck — killing agent early',
                        );
                        if (task?.podMode && killWorker) {
                          // k8s: delete the Job (graceful SIGTERM) so the worker's finalize
                          // commits+pushes WIP before the pod dies; killProcess is a no-op for pid<=0.
                          // ctx enables kill-time cost accounting (#313 gap 1, sweep channel).
                          killWorker(entry.sessionId, { graphId: entry.graphId, taskId: entry.taskId, sessionLogPath: task.sessionLogPath });
                        } else {
                          await processMonitor.killProcess(entry.sessionId);
                        }
                        if (task?.podMode) {
                          // Record the branch the retry resumes from (worker pushes WIP on SIGTERM).
                          await graphManager.markCheckpointBranch(
                            entry.graphId, entry.taskId,
                            defaultWorkerBranch(entry.graphId, entry.taskId),
                          );
                        }
                        await graphManager.emitEventPublic({
                          type: 'task_timeout', graphId: entry.graphId,
                          taskId: entry.taskId, sessionId: entry.sessionId,
                          timestamp: Date.now(),
                          detail: `Interrogated stuck: ${JSON.stringify(diag)}`,
                        });
                        try { onTaskTimeout({ taskId: entry.taskId, graphId: entry.graphId, role: entry.role }); } catch { /* swallow */ }
                        notify('warning',
                          `[the-bureau] Agent ${entry.role} (task: ${entry.taskId}) stuck (${diag.loopSignature ?? 'unknown'}${diag.missing ? ' — ' + diag.missing : ''}) — killed early`,
                        );
                      }
                    }
                    // (8) PRODUCTIVE/UNCERTAIN — no-op; NX debounce already prevents re-interrogation for 900s
                  }
                }
              }
          } catch { /* interrogation failure must never throw into the sweep */ }
        }
      }

      if (task?.timeoutMs && (Date.now() - entry.startedAt) > task.timeoutMs) {
        log.warn(
          { agentSessionId: entry.sessionId, role: entry.role, taskId: entry.taskId, graphId: entry.graphId, timeoutMs: task.timeoutMs },
          'task timeout — killing agent',
        );
        if (task?.podMode && killWorker) {
          // k8s: delete the Job (graceful SIGTERM) so the worker's finalize commits+pushes
          // WIP before the pod dies; killProcess is a no-op for pid<=0.
          // ctx enables kill-time cost accounting (#313 gap 1, sweep channel).
          killWorker(entry.sessionId, { graphId: entry.graphId, taskId: entry.taskId, sessionLogPath: task.sessionLogPath });
        } else {
          await processMonitor.killProcess(entry.sessionId);
        }
        if (task?.podMode) {
          // Record the branch the retry resumes from (the worker pushes WIP to it on SIGTERM).
          await graphManager.markCheckpointBranch(
            entry.graphId, entry.taskId,
            defaultWorkerBranch(entry.graphId, entry.taskId),
          );
        }
        await graphManager.emitEventPublic({
          type: 'task_timeout', graphId: entry.graphId,
          taskId: entry.taskId, sessionId: entry.sessionId,
          timestamp: Date.now(), detail: `Killed after ${task.timeoutMs}ms`,
        });
        try { onTaskTimeout({ taskId: entry.taskId, graphId: entry.graphId, role: entry.role }); } catch { /* swallow */ }
      }
    }
  }

  // 1b. Startup health gate — agents that produced no log output within 30s.
  //     Alive but silent → warning. Dead and silent → mark failed immediately.
  //     Stalled (3+ consecutive warnings) → kill and mark failed.
  const startupResult = await processMonitor.checkStartupHealth(30_000, 3);
  for (const entry of startupResult.stalled) {
    if (entry.taskId && entry.graphId) {
      // k8s workers (pid=0) register with logFile="k8s://..." which never exists on
      // the engine's filesystem, and isPidAlive(0) is always true on Linux — so they
      // accumulate startup warnings and appear stalled even while their Job is Running.
      // The startup gate's log-file heuristic is meaningless for externally-managed
      // workers. Use Job status (the same signal as await_graph_event Part 1 and Section
      // 2 below) as the authoritative liveness check instead.
      if (entry.pid <= 0) {
        if (k8sJobStatus && entry.graphId && entry.taskId) {
          let jobStatus: K8sJobStatus;
          try {
            jobStatus = await k8sJobStatus(entry.graphId, entry.taskId);
          } catch {
            // Job API unavailable — skip kill conservatively; Section 2 will finalize.
            log.warn(
              { sessionId: entry.sessionId, role: entry.role, taskId: entry.taskId },
              'startup health: k8s job status check failed — skipping kill conservatively',
            );
            continue;
          }
          if (jobStatus === 'active') {
            log.info(
              { sessionId: entry.sessionId, role: entry.role, taskId: entry.taskId },
              'startup health: k8s worker Job active — not killing despite no local log output',
            );
            continue;
          }
          // Terminal (succeeded/failed/gone): the k8s strategy's 4s poll will fire onExit
          // → processMonitor.handleExit → onTaskCompleted/onTaskFailed. Killing here would
          // race with that path and could duplicate failure events. Skip — let onExit win.
          log.info(
            { sessionId: entry.sessionId, role: entry.role, taskId: entry.taskId, jobStatus },
            'startup health: k8s worker Job finished — deferring finalization to onExit handler',
          );
          continue;
        }
        // No k8sJobStatus accessor and pid=0 — skip kill conservatively.
        continue;
      }

      // Check liveness before killing — MCP tool call activity (metrics:<sessionId> in Redis)
      // is the sole liveness source; the shell-level heartbeat was removed with the k8s-only spawn refactor.
      const metrics = await activityMonitor.getMetrics(entry.sessionId);

      const mcpActive = metrics && metrics.toolCalls > 0 &&
        (Date.now() - metrics.lastActivity) < 120_000;

      if (mcpActive) {
        log.info(
          { sessionId: entry.sessionId, role: entry.role, taskId: entry.taskId, reason: `MCP activity (${metrics!.toolCalls} tool calls)` },
          'startup health: no stdout but agent is alive — not killing',
        );
        continue; // Don't kill — agent is working
      }

      // Read stderr and diagnostics for the stalled agent
      let stderrHint = '';
      try {
        const stderrFile = entry.logFile.replace(/output\.log$/, 'stderr.log');
        const stderr = readFileSync(stderrFile, 'utf-8').trim();
        if (stderr) stderrHint = ` Stderr: ${stderr.slice(-200)}`;
      } catch { /* best effort */ }

      log.warn(
        { sessionId: entry.sessionId, role: entry.role, taskId: entry.taskId, pid: entry.pid },
        'startup stall detected — killing agent after 3 consecutive no-output sweeps (no MCP activity either)',
      );
      await processMonitor.killProcess(entry.sessionId);

      // Check phase before marking failed — agent may have completed work via MCP
      // tools (set_handoff, set_status('done')) even though stdout was silent.
      let stalledPhase: string | undefined;
      try {
        const peerData = await redis.get(`peers:${entry.sessionId}`);
        if (peerData) stalledPhase = JSON.parse(peerData).phase;
      } catch { /* best effort */ }

      if (stalledPhase === 'done') {
        log.info({ sessionId: entry.sessionId, role: entry.role, taskId: entry.taskId },
          'stalled agent had phase=done — marking completed instead of failed');
        await graphManager.onTaskCompleted(entry.graphId, entry.taskId, entry.sessionId, 0);
      } else {
        await graphManager.onTaskFailed(entry.graphId, entry.taskId, entry.sessionId, 1);
      }
      await graphManager.emitEventPublic({
        type: 'task_dead', graphId: entry.graphId,
        taskId: entry.taskId, sessionId: entry.sessionId,
        timestamp: Date.now(),
        detail: `Agent (role: ${entry.role}, PID: ${entry.pid}) killed after producing no output for 3 health sweeps (~90s) and no MCP activity.${stderrHint || ' Check stderr.log and spawn-diag.log in ' + entry.logFile.replace(/output\.log$/, '')}`,
      });
      try { onTaskDead({ taskId: entry.taskId, graphId: entry.graphId, role: entry.role, reason: 'startup_gate' }); } catch { /* swallow */ }
      notify('error', `[the-bureau] Agent ${entry.role} (task: ${entry.taskId}) stalled at startup — killed after ~90s with no output or MCP activity.${stderrHint || ' Check stderr.log for details.'}`);
    }
  }
  for (const entry of startupResult.failed) {
    if (entry.taskId && entry.graphId) {
      let stderrHint = '';
      try {
        const stderrFile = entry.logFile.replace(/output\.log$/, 'stderr.log');
        const stderr = readFileSync(stderrFile, 'utf-8').trim();
        if (stderr) stderrHint = ` Stderr: ${stderr.slice(-200)}`;
      } catch { /* best effort */ }

      await graphManager.onTaskFailed(entry.graphId, entry.taskId, entry.sessionId, 1);
      await graphManager.emitEventPublic({
        type: 'task_dead', graphId: entry.graphId,
        taskId: entry.taskId, sessionId: entry.sessionId,
        timestamp: Date.now(),
        detail: `Agent (role: ${entry.role}, PID: ${entry.pid}) died without producing any log output.${stderrHint || ' Check stderr.log and spawn-diag.log in ' + entry.logFile.replace(/output\.log$/, '')}`,
      });
      try { onTaskDead({ taskId: entry.taskId, graphId: entry.graphId, role: entry.role, reason: 'silent_log' }); } catch { /* swallow */ }
      notify('error', `[the-bureau] Agent ${entry.role} (task: ${entry.taskId}) died at startup with empty log — marked failed.${stderrHint}`);
    }
  }

  // 1c. Clean up checkpoint branches older than 24h and session logs older than 48h.
  await ProcessMonitor.cleanupCheckpointBranches(process.cwd());
  ProcessMonitor.cleanupOldLogs(process.cwd());

  // 2. Scan Redis for running graph tasks with dead agents (cross-session detection).
  //    This catches cases where the spawning MCP server died or a different session
  //    is monitoring the graph.
  const graphIds = new Set<string>();
  for (const entry of entries) {
    if (entry.graphId) graphIds.add(entry.graphId);
  }

  // Also check graphs we're the orchestrator for
  const orchestratorKeys = await scanKeys(redis, 'graph:*:orchestrator');
  for (const key of orchestratorKeys) {
    const gid = key.split(':')[1];
    const owner = await redis.get(key);
    if (owner === sessionId) {
      graphIds.add(gid);
    } else if (!owner) {
      // Key expired between SCAN and GET — try to adopt atomically
      const adopted = await redis.set(`graph:${gid}:orchestrator`, sessionId, 'EX', 120, 'NX');
      if (adopted) graphIds.add(gid);
    }
    // else: another session owns it — skip
  }

  // Re-discover ACTIVE graphs whose orchestrator key has expired (e.g. orphaned by an engine
  // crash/restart). scanKeys cannot return an expired orchestrator key, and a restarted engine
  // has no local processMonitor entries for k8s workers — so without this an orphaned graph
  // would never be re-adopted and its pod-mode tasks would never be finalized. Every graph has
  // exactly one :taskIds set; enumerate via that and supervise the ones still active.
  //
  // #317 phase3 (Task 7): also re-discover `reworking` graphs [PT-loop-M4/PT-LOW-8] — without
  // this a restarted engine never re-adopts a mid-round graph and it is left to strand (no
  // resume driver ever sees it) or, worse, is eventually taken terminal by the stale-reaper on
  // round-0's stale age. Also re-discover `validating` graphs (Task 7, hand-off f) — a
  // validating graph whose completion lock is stranded (holder crashed mid-resolve) has no
  // live child left to re-trigger its resolution, so the sweep must be able to find it too.
  const taskIdKeys = await scanKeys(redis, 'graph:*:taskIds');
  for (const key of taskIdKeys) {
    const gid = key.split(':')[1];
    if (graphIds.has(gid)) continue;
    const g = await graphManager.getGraph(gid);
    if (g && (g.status === 'active' || g.status === 'reworking' || g.status === 'validating')) {
      graphIds.add(gid);
    }
  }

  for (const gid of graphIds) {
    // Refresh the orchestrator claim ONLY while the graph is active or reworking. A terminal
    // graph's key is therefore left to TTL out on its own (cleanup) — graph:<id> + tasks stay
    // in Redis for the API/TUI (their own 24h TTL). graph.status is the source of truth; no
    // separate "orchestration complete" marker is maintained.
    //
    // #317 phase3 (Task 7): `reworking` is included [PT-LOW-8] — otherwise the claim expires
    // while a round is mid-flight and supervision (hence re-adoption after a restart) is lost
    // at exactly the idle inter-step points the resume driver below exists to cover.
    // `validating` deliberately does NOT get a claim refresh here: it is driven passively by
    // its live validation child's completion callback, not by orchestrator ownership — the
    // taskIds re-discovery above is sufficient to reach it for the resume-drive call below.
    const supervised = await graphManager.getGraph(gid);
    if (supervised && (supervised.status === 'active' || supervised.status === 'reworking')) {
      await redis.set(`graph:${gid}:orchestrator`, sessionId, 'EX', 120);
      // #233: renew this graph's test-service leases while it is active + supervised, so a
      // live worker's Redis/Postgres is never reaped under it. 120s ≫ the 30s sweep cadence,
      // so the lease always stays ahead; the manager's own sweep still reaps orphaned graphs.
      if (supervised.status === 'active' && testServiceManager) {
        try {
          await testServiceManager.extendLeasesForGraph(gid, 120);
        } catch (err) {
          log.warn({ graphId: gid, err: String(err) }, 'failed to renew test-service leases');
        }
      }
    }

    // #317 phase3 (Task 7, PT-loop-H1) — the explicit resume driver. Re-adoption alone is
    // NOT sufficient: the sweep supervises tasks, not per-graph "advance" calls, so at the two
    // idle inter-step points — (a) after entry claim, before fix dispatch; (c) after the fix
    // child is terminal, before re-validation dispatch — nothing else re-drives the loop, and
    // the stale-reaper would otherwise take a healthy mid-round graph terminal. Idempotent and
    // safe to call every cycle (re-drives are no-ops once the round is waiting on a live child).
    if (supervised && supervised.status === 'reworking') {
      try {
        await graphManager.resumeReworkRound(gid);
      } catch (err) {
        log.warn({ graphId: gid, err: String(err) }, 'resumeReworkRound sweep-drive failed');
      }
    }

    // #317 phase3 (Task 7, hand-off f) — expired-lock re-drive for `validating` graphs. All
    // resolution sites now serialize behind a per-attempt completion lock (C4); a holder that
    // crashes after claiming the lock but before finishing the status write + promote leaves
    // the graph stranded once its validation children are already terminal — nothing else will
    // ever call checkGraphCompletion for it again. Conservative: checkGraphCompletion is a
    // no-op on a healthy graph with live children (returns at the "still waiting" branch), so
    // calling it unconditionally here every cycle is safe.
    if (supervised && supervised.status === 'validating') {
      try {
        await graphManager.checkGraphCompletion(gid);
      } catch (err) {
        log.warn({ graphId: gid, err: String(err) }, 'checkGraphCompletion sweep-drive failed');
      }
    }

    // Find tasks marked "running" and verify their agents are alive
    const tasks = await graphManager.getAllTasks(gid);
    for (const task of tasks) {
      // Yielded tasks have no alive PID — the agent exited cleanly and the yield
      // marker in Redis is the source of truth. Skip stale/dead detection entirely.
      if (task.status === 'yielded') continue;

      // Zombie detection: a running task with no sessionId means the dispatch
      // set status=running but spawn failed before the sessionId was stamped (#215).
      // Give tasks a 30s grace window so an in-flight dispatch isn't mis-classified.
      if (task.status === 'running' && !task.sessionId) {
        const ageMs = Date.now() - (task.startedAt ?? 0);
        if (ageMs < 30_000) continue;

        const claimKey = `deadagent:zombie:${gid}:${task.id}:claimed`;
        const claimed = await redis.set(claimKey, sessionId, 'EX', 300, 'NX');
        if (!claimed) continue;

        if (task.podMode && k8sJobStatus) {
          let jobStatus: K8sJobStatus;
          try {
            jobStatus = await k8sJobStatus(gid, task.id);
          } catch (err) {
            log.warn({ taskId: task.id, graphId: gid, err: String(err) }, "k8s job status check failed for zombie task (will retry next sweep)");
            await redis.del(claimKey);
            continue;
          }
          if (jobStatus === 'active') {
            // Job is running — sessionId may still be in transit; release claim and wait.
            await redis.del(claimKey);
            continue;
          }
          log.warn({ taskId: task.id, graphId: gid, jobStatus }, "zombie pod-mode task (running, null sessionId, terminal Job) — marking failed");
          notify('warning', `[the-bureau] zombie task '${task.id}' (running with null sessionId, Job ${jobStatus}) — marked failed`);
          try { onZombieDetected({ graphId: gid, taskId: task.id, role: task.role ?? '' }); } catch { /* swallow */ }
          await graphManager.onTaskFailed(gid, task.id, '', 1, { failureReason: 'dispatch.zombie_task' });
        } else if (!task.podMode) {
          log.warn({ taskId: task.id, graphId: gid }, "zombie task (running with null sessionId, non-pod) — marking failed");
          notify('warning', `[the-bureau] zombie task '${task.id}' (running with null sessionId) — marked failed`);
          try { onZombieDetected({ graphId: gid, taskId: task.id, role: task.role ?? '' }); } catch { /* swallow */ }
          await graphManager.onTaskFailed(gid, task.id, '', 1, { failureReason: 'dispatch.zombie_task' });
        }
        // pod-mode task with no k8sJobStatus accessor: skip conservatively.
        continue;
      }

      if (task.status !== 'running' || !task.sessionId) continue;
      // Skip if we're tracking this process locally (already handled above)
      if (processMonitor.get(task.sessionId)) continue;

      // Pod-mode (k8s) tasks: liveness is the Job status, NOT the peer record. The peer
      // record (60s TTL) expires ~when the engine dies — before the graph becomes adoptable
      // (120s orchestrator TTL) — so a restart must finalize orphaned workers from the
      // durable task record (task.podMode), independent of the volatile peer record.
      if (task.podMode && k8sJobStatus) {
        let jobStatus: K8sJobStatus;
        try {
          jobStatus = await k8sJobStatus(gid, task.id);
        } catch (err) {
          log.warn({ taskId: task.id, graphId: gid, err: String(err) }, "k8s job status check failed (will retry next sweep)");
          continue;
        }
        if (jobStatus === "active") continue;
        // Terminal status. The claim gates concurrent SWEEPS only; the poll-vs-sweep race is
        // covered by onTaskCompleted/onTaskFailed idempotency. 300s TTL is the self-healing horizon.
        const claimKey = `deadagent:${task.sessionId}:claimed`;
        const claimed = await redis.set(claimKey, sessionId, "EX", 300, "NX");
        if (!claimed) continue;
        // An exec/criterion pod's exit code IS its validation verdict (exit 0 = passed). A
        // "gone" Job means that verdict was never observed and is unrecoverable, so for exec
        // pods it must fail closed — the same class as a "failed" Job — never be treated as a
        // clean exit that silently promotes unverified work (#318). Normal workers keep the
        // gone-after-running → completed semantics (their product is the pushed branch).
        const execVerdictLost = jobStatus === "gone" && task.execMode === true;
        if (jobStatus === "failed" || execVerdictLost) {
          const why = execVerdictLost ? "exec criterion Job gone — verdict unrecoverable, failing closed (#318)" : "k8s worker Job failed — finalizing task as failed";
          log.warn({ taskId: task.id, graphId: gid, sessionId: task.sessionId, jobStatus }, why);
          // #317: thread the fail-closed reason so it lands on the task/graph record
          // (not just this sweep's log) for the trigger discriminator's allowlist.
          await graphManager.onTaskFailed(gid, task.id, task.sessionId, 1,
            execVerdictLost ? { failureReason: "exec_verdict_lost" } : undefined);
          try { onTaskDead({ taskId: task.id, graphId: gid, role: task.role, reason: "pid_gone" }); } catch { /* swallow */ }
          notify("warning", `[the-bureau] k8s worker for task '${task.id}' ${execVerdictLost ? "gone before its verdict was recorded — marked failed (fail-closed)" : "failed (Job status) — marked failed"}`);
        } else {
          // Confirmed clean exit (Job succeeded, or a non-exec worker gone after running) — no task_warning (not inferred).
          log.info({ taskId: task.id, graphId: gid, sessionId: task.sessionId, jobStatus }, "k8s worker Job finished — finalizing task as completed");
          await graphManager.onTaskCompleted(gid, task.id, task.sessionId, 0);
          notify("info", `[the-bureau] k8s worker for task '${task.id}' completed (recovered via Job status: ${jobStatus})`);
        }
        continue;
      }

      // Check if the agent's peer registration still exists
      const peerData = await redis.get(`peers:${task.sessionId}`);
      if (!peerData) {
        // Peer registration expired (TTL 60s) — agent is dead.
        // Atomically claim this dead agent so only one health sweep handles it.
        const claimKey = `deadagent:${task.sessionId}:claimed`;
        const claimed = await redis.set(claimKey, sessionId, 'EX', 300, 'NX');
        if (!claimed) {
          // Another health sweep already handling this agent
          continue;
        }

        // Peer data is gone so we can't read phase from it. Check whether the agent
        // called set_handoff before dying — if so, treat as 'done' (#88).
        let expiredPhase: import('./types.js').AgentPhase | undefined;
        try {
          const handoffExists = await redis.exists(`handoff:${gid}:${task.id}`);
          if (handoffExists) expiredPhase = 'done';
        } catch { /* best effort */ }

        const inference = await ProcessMonitor.inferDeathOutcome({
          phase: expiredPhase,
          cwd: task.cwd,
          taskStartedAt: task.startedAt,
        });
        log.warn(
          { agentSessionId: task.sessionId, taskId: task.id, graphId: gid, inferredOutcome: inference.outcome, reason: inference.reason },
          `dead agent detected (peer registration expired) — inferred ${inference.outcome}`,
        );
        notify('warning', `[the-bureau] Agent for task '${task.id}' (session ${task.sessionId.slice(0, 8)}) is dead — inferred ${inference.outcome}`);
        if (inference.outcome === 'completed') {
          await graphManager.emitEventPublic({
            type: 'task_warning', graphId: gid,
            taskId: task.id, sessionId: task.sessionId,
            timestamp: Date.now(), detail: `Agent died but inferred completed: ${inference.reason}`,
          });
          try { onTaskWarning({ taskId: task.id, graphId: gid, role: task.role, reason: 'pid_gone' }); } catch { /* swallow */ }
          await graphManager.onTaskCompleted(gid, task.id, task.sessionId, 0);
        } else {
          await graphManager.onTaskFailed(gid, task.id, task.sessionId, 1);
          try { onTaskDead({ taskId: task.id, graphId: gid, role: task.role, reason: 'pid_gone' }); } catch { /* swallow */ }
        }
        continue;
      }

      // Peer exists — verify PID is alive
      const peer = JSON.parse(peerData);
      // Pod-mode k8s tasks were finalized above (before the peer-record read). Any other
      // pid<=0 peer has no local process to PID-check — skip, as the pre-feature code did.
      if (peer.pid <= 0) continue;
      if (!ProcessMonitor.isPidAlive(peer.pid)) {
        // Atomically claim this dead agent so only one health sweep handles it.
        const claimKey = `deadagent:${task.sessionId}:claimed`;
        const claimed = await redis.set(claimKey, sessionId, 'EX', 300, 'NX');
        if (!claimed) {
          // Another health sweep already handling this agent
          continue;
        }

        const inference = await ProcessMonitor.inferDeathOutcome({
          phase: peer.phase,
          cwd: task.cwd,
          taskStartedAt: task.startedAt,
        });
        log.warn(
          { agentSessionId: task.sessionId, pid: peer.pid, taskId: task.id, graphId: gid, inferredOutcome: inference.outcome, reason: inference.reason },
          `dead agent detected (PID not alive) — inferred ${inference.outcome}`,
        );
        notify('warning', `[the-bureau] Agent for task '${task.id}' (PID ${peer.pid}) is dead — inferred ${inference.outcome}`);
        if (inference.outcome === 'completed') {
          await graphManager.emitEventPublic({
            type: 'task_warning', graphId: gid,
            taskId: task.id, sessionId: task.sessionId,
            timestamp: Date.now(), detail: `Agent died but inferred completed: ${inference.reason}`,
          });
          try { onTaskWarning({ taskId: task.id, graphId: gid, role: task.role, reason: 'pid_gone' }); } catch { /* swallow */ }
          await graphManager.onTaskCompleted(gid, task.id, task.sessionId, 0);
        } else {
          await graphManager.onTaskFailed(gid, task.id, task.sessionId, 1);
          try { onTaskDead({ taskId: task.id, graphId: gid, role: task.role, reason: 'pid_gone' }); } catch { /* swallow */ }
        }
      }
    }
  }

  // 3. Graph-stall detection: active graph with nothing running/ready but blocked on merges.
  for (const gid of graphIds) {
    const graph = await graphManager.getGraph(gid);
    if (!graph || graph.status !== 'active') continue;

    const stalledTasks = await graphManager.getAllTasks(gid);
    const runningCount = stalledTasks.filter(t => t.status === 'running').length;
    const readyCount = stalledTasks.filter(t => t.status === 'ready').length;
    if (runningCount > 0 || readyCount > 0) continue;

    // Check pending_merges set
    const pendingMerges = await redis.smembers(`graph:${gid}:pending_merges`);
    const hasPendingMerges = pendingMerges.length > 0;

    // Check for failed merge-* tasks
    const hasFailedMergeTask = stalledTasks.some(t => t.id.startsWith('merge-') && t.status === 'failed');

    // A pending non-failed merge is in-flight work that will produce task_ready
    // once it lands — not a stall. Only emit when nothing can make forward progress
    // (no pending merges) OR when a merge has actually failed.
    if (!hasPendingMerges || hasFailedMergeTask) {
      // Debounce: only notify once per 5-minute window per graph
      const stallClaimKey = `graph:stall:${gid}:notified`;
      const claimed = await redis.set(stallClaimKey, '1', 'EX', 300, 'NX');
      if (!claimed) continue; // already notified within 5 minutes

      const stallCause = hasFailedMergeTask && hasPendingMerges
        ? `blocked on pending merge and failed merge task`
        : hasFailedMergeTask
          ? `blocked on failed merge task`
          : `no running or ready tasks and no pending merges`;

      await graphManager.emitEventPublic({
        type: 'graph_stalled',
        graphId: gid,
        timestamp: Date.now(),
        detail: JSON.stringify({
          runningCount,
          readyCount,
          pendingMerges,
          hasFailedMergeTask,
        }),
      });
      notify('warning', `[the-bureau] Graph ${gid.slice(0, 8)} appears stalled — ${stallCause}`);
    }
  }

  // 4. Stale-graph reaping: finalize graphs stuck non-terminal with no live tasks (#232).
  await reapStaleGraphs(deps);
}

/**
 * A graph stuck in a non-terminal status (`active`/`validating`/`reworking`) with no live
 * tasks and no activity past STALE_GRAPH_MS is finalized to `failed` (#232). The per-task
 * sweep only finalizes live/zombie tasks; a graph whose tasks are all terminal but whose
 * status never advanced (e.g. a `validating` graph whose validator child died, or a
 * `reworking` graph whose loop is genuinely stuck — Task 7 item (c)) is otherwise immortal
 * and inflates `activeGraphs` forever. Conservative: requires ALL tasks terminal, no live
 * child graph (an in-flight validator/fix-round protects its parent), and a generous idle
 * horizon that also accounts for `reworking` round activity (Task 7 item (d), below).
 */
export const STALE_GRAPH_MS = 30 * 60_000;

export async function reapStaleGraphs(deps: HealthSweepDeps): Promise<void> {
  const { redis, sessionId, graphManager, log, notify } = deps;
  const taskIdKeys = await scanKeys(redis, 'graph:*:taskIds');
  if (taskIdKeys.length === 0) return;

  const graphs = new Map<string, TaskGraph>();
  for (const key of taskIdKeys) {
    const gid = key.split(':')[1];
    const g = await graphManager.getGraph(gid);
    if (g) graphs.set(gid, g);
  }

  // A graph with a still-live descendant (e.g. an in-flight validation child graph, or a
  // child graph itself mid-rework) must not be reaped — the child is the work that will
  // transition the parent.
  const parentsWithActiveChild = new Set<string>();
  for (const g of graphs.values()) {
    if (g.parentGraphId && (g.status === 'active' || g.status === 'validating' || g.status === 'reworking')) {
      parentsWithActiveChild.add(g.parentGraphId);
    }
  }

  const now = Date.now();
  for (const [gid, g] of graphs) {
    // #317 phase3 (Task 7, item c): `reworking` joins the reaper's status guard — without
    // it a genuinely-stuck reworking graph (broken fix loop, no resume driver ever able to
    // advance it) is immortal, with no backstop at all.
    if (g.status !== 'active' && g.status !== 'validating' && g.status !== 'reworking') continue;
    if (parentsWithActiveChild.has(gid)) continue;

    const tasks = await graphManager.getAllTasks(gid);
    const hasLiveTask = tasks.some(t => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'canceled');
    if (hasLiveTask) continue;

    let last = g.createdAt ?? 0;
    for (const t of tasks) {
      last = Math.max(last, t.createdAt ?? 0, t.startedAt ?? 0, t.completedAt ?? 0);
    }

    // #317 phase3 (Task 7, item d): a `reworking` graph's OWN tasks are already all terminal
    // (frozen at round entry, before the fix/re-validation children were ever dispatched) —
    // the round's actual activity lives in `currentRound` and the fix/re-validation CHILD
    // graphs, which the parent's own task timestamps never reflect. Without folding these in,
    // a healthy mid-round graph looks idle by its stale round-0 task timestamps and gets
    // reaped out from under a live fix agent — the opposite of restart-durable. Every child
    // graph is already present in `graphs` (it has its own :taskIds set), so this needs no
    // extra Redis round-trip.
    if (g.status === 'reworking') {
      last = Math.max(last, g.currentRound?.enteredAt ?? 0);
      for (const cid of g.childGraphIds ?? []) {
        const c = graphs.get(cid);
        if (!c) continue;
        last = Math.max(last, c.createdAt ?? 0, c.completedAt ?? 0);
      }
    }
    if (now - last < STALE_GRAPH_MS) continue;

    // HA-safe single-reaper claim; also debounces repeated attempts.
    const claimed = await redis.set(`graph:stalereap:${gid}:claimed`, sessionId, 'EX', 300, 'NX');
    if (!claimed) continue;

    const idleMin = Math.round((now - last) / 60_000);
    const reason = `${g.status} with no live tasks for ${idleMin}m`;
    log.warn({ graphId: gid, status: g.status, idleMin }, 'reaping stale graph (#232)');
    notify('warning', `[the-bureau] reaped stale graph ${gid.slice(0, 8)} — ${reason}`);
    try {
      await graphManager.reapStaleGraph(gid, reason);
    } catch (err) {
      log.warn({ graphId: gid, err: String(err) }, 'reapStaleGraph failed');
    }
  }
}

/**
 * Wraps `runHealthSweep` in a `setInterval` for production use.
 * Returns the interval handle so callers can clear it on shutdown.
 */
export function startHealthSweep(deps: HealthSweepDeps, intervalMs = 30_000): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      await runHealthSweep(deps);
    } catch { /* health check should never crash the server */ }
  }, intervalMs);
}
