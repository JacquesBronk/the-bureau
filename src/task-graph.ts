import { freemem } from "node:os";
import { v4 as uuidv4 } from "uuid";
import type { RedisClient } from "./redis.js";
import { logger } from "./logger.js";
import type {
  TaskGraph, TaskNode, TaskNodeInput, TaskStatus, TaskEvent,
  GraphStatus, CriterionDef,
} from "./types.js";
import { transition } from "./state-machine.js";
import type { YieldManager } from "./workspace/yield.js";
import type { YieldContext } from "./types/workspace.js";
import type { YieldEscalation } from "./workspace/yield-escalation.js";
import { getCacheAnomalyDetector, getLifecycleAnomalyDetector } from "./telemetry/domain/anomaly.js";
import { onTaskAdded } from "./telemetry/domain/task.js";
import { onDispatchThrottled } from "./telemetry/domain/health.js";
import { onWorktreeMergeCompleted } from "./telemetry/domain/worktree.js";
import { onCriterionEvaluated, onCriterionFixStarted } from "./telemetry/domain/criterion.js";
import { onValidationDispatched, onValidationResult, onValidationNoTestCommand } from "./telemetry/domain/validation.js";
import { DEFAULT_FIX_ROLE, DEFAULT_AGENT_CRITERION_ROLE } from "./criterion-engine.js";
import { defaultRetryPolicy, RetryPolicy } from "./retry-policy.js";
import type { RemoteMergeHooks, RemoteMergeOutcome } from "./spawn/remote-merge.js";
import { classifyGitError } from "./spawn/remote-merge.js";
import { cleanupReworkConflictBranches, resolveReworkConflictCleanupTargets } from "./rework/conflict-cleanup.js";
import { GraphRegistry, destKey } from "./workspace/graph-registry.js";
import type { ValidationFailure } from "./types/workspace.js";
import { buildValidationFailure } from "./workspace/validation-failure.js";
import { formatValidationFailureNote } from "./workspace/enrichment.js";
import type { CriterionResult } from "./types/graph.js";
import { VALIDATION_LEVEL_PRIORITY } from "./types/graph.js";
import { parseFileRefsFromDescription } from "./workspace/ledger.js";
import { resolveDestination, type GitDestination } from "./spawn/git-registry.js";
import { validateGraphInput, validateDAG as validateDAGInput } from "./graph-validate.js";
import { composeCoverageCommand } from "./coverage/coverage-command.js";
import { buildIntegrationPreflight, buildTestFileExistencePreflight } from "./validation-preflight.js";
import { ReworkManager } from "./rework-manager.js";
import type { ReworkEntry } from "./types/task.js";
import { evaluateFixIntegrity, findFailedCoverageCriterion, resolveIntegrityDiffRange, type DiffShapeInput, type GuardVerdict } from "./rework/fix-integrity.js";
import { readIntegrationHead, checkHeadPin, captureIntegrationHeadForPin } from "./rework/sha-pin.js";

const TTL = 86400;

/** #317 phase3 — bounded auto-rework loop constants (Task 6a). */
// Recursion / depth stop: a graph nested deeper than this in the parent chain is
// never auto-reworked (guards against rework-of-a-rework / runaway nesting).
const REWORK_MAX_DEPTH = 3;
// Hard cap on the per-graph auto-rework budget. Re-clamped at the CONSUMPTION site
// (reworkEligibility) as an invariant, independent of any declare-time clamp — a
// hand-seeded / legacy graph record with a larger maxAttempts still exhausts at 3.
const REWORK_MAX_ATTEMPTS_CAP = 3;
// Synthetic ReworkManager task id the per-graph validation budget is keyed by.
const REWORK_VALIDATION_TASK_ID = "__validation__";
// Fixable-reason ALLOWLIST — DEFAULT NON-FIXABLE. Only a genuine test/code
// failure is eligible for an auto-fix round; every other or unknown reason
// (undefined, exec_verdict_lost, integration_branch_missing, git_* transient/
// auth, dispatch.zombie_task, config errors, spawn failures) is NON-fixable and
// falls through to terminal validation_failed. A NEW failure reason becomes
// fixable ONLY by being added here — never fixable-by-default.
//   - "exit_nonzero": an exec/validation pod exited non-zero with real output
//     and NO git/infra classification (mcp-server.ts derives this) — the primary
//     mechanical-gate target. It is the genuine-test-failure CATCH-ALL: any
//     non-git, non-threaded infra exit that still surfaces as a bare non-zero
//     code (e.g. an OOM kill or a segfault mid-suite) is indistinguishable here
//     from a real test failure and so can burn ONE bounded rework round. Accepted
//     because the per-graph attempt budget bounds the waste; tighten (split out a
//     finer infra-exit reason upstream) only if this is actually observed.
//   - "test_failure": an explicit genuine-test-failure reason.
const FIXABLE_REWORK_REASONS: ReadonlySet<string> = new Set([
  "exit_nonzero",
  "test_failure",
]);

import type { TaskGraphCallbacks } from "./types/graph.js";
export type { TaskGraphCallbacks } from "./types/graph.js";

export class TaskGraphManager {
  private yieldManager?: YieldManager;
  private yieldEscalation?: YieldEscalation;
  private sessionId: string;
  private retryPolicy: RetryPolicy;
  /**
   * Pending retry timers keyed by graphId.  Each entry is the set of timers
   * scheduled to resume dispatch after backoff.  cancelGraph() clears all
   * timers for a graph so an in-flight backoff doesn't dispatch into a
   * canceled graph.
   */
  private retryTimers = new Map<string, Set<NodeJS.Timeout>>();
  private remoteMerge?: RemoteMergeHooks;
  setRemoteMerge(hooks: RemoteMergeHooks): void { this.remoteMerge = hooks; }

  constructor(
    private redis: RedisClient,
    private callbacks: TaskGraphCallbacks,
    sessionId?: string,
    retryPolicy?: RetryPolicy,
  ) {
    this.sessionId = sessionId ?? process.env.BUREAU_SESSION_ID ?? process.env.SESSION_ID ?? "";
    this.retryPolicy = retryPolicy ?? defaultRetryPolicy;
  }

  /** Replace callbacks after construction (for deferred wiring). */
  setCallbacks(cb: TaskGraphCallbacks): void {
    this.callbacks = cb;
  }

  /** Wire in the YieldManager after construction. */
  setYieldManager(ym: YieldManager): void {
    this.yieldManager = ym;
  }

  /** Wire the k8s-backed validation-pod-log reader after construction (#306).
   *  Deferred because the K8sApi is built async at startup; the callbacks object
   *  is set synchronously at module load. Best-effort reader — MUST never throw. */
  setValidationPodLogReader(reader: (childGraphId: string) => Promise<string | undefined>): void {
    this.callbacks.readValidationPodLog = reader;
  }

  /** Wire in the YieldEscalation after construction. */
  setYieldEscalation(ye: YieldEscalation): void {
    this.yieldEscalation = ye;
  }

  private graphRegistry?: GraphRegistry;
  private gitDestinations: GitDestination[] = [];

  /** Wire in the GraphRegistry + git destinations (for baseRef resolution) after construction. */
  setGraphRegistry(reg: GraphRegistry, gitDestinations: GitDestination[]): void {
    this.graphRegistry = reg;
    this.gitDestinations = gitDestinations;
  }

  async declareGraph(
    project: string,
    cwd: string,
    inputs: TaskNodeInput[],
    opts?: { maxConcurrency?: number; acceptanceCriteria?: CriterionDef[]; parentGraphId?: string; destination?: string; defaultToolchain?: string; selfImprove?: boolean; autoRework?: { maxAttempts: number; fixRole?: string }; isReworkFixChild?: boolean; attempt?: number },
  ): Promise<{ graphId: string; readyTasks: string[]; totalTasks: number }> {
    const graphId = uuidv4();
    validateGraphInput(inputs, opts?.acceptanceCriteria);

    // Worker isolation is provided per-pod under k8s dispatch: each worker Job
    // blobless-clones the destination repo into its own workspace volume and
    // pushes its own branch (integrated via the pod-mode remote merge). There is
    // no engine-side git worktree to prepare. (Local PTY/raw worktree isolation
    // was removed — see the k8s-only spawn epic.)
    const resolvedInputs = inputs;

    // Aggregate validation level (max: integration > unit > self), test commands, and
    // test services across all tasks before persisting the graph, so the gate has them at completion time.
    const _levelPriority = VALIDATION_LEVEL_PRIORITY;
    let _maxValidationLevel: 'self' | 'unit' | 'integration' | undefined;
    let _validationInstallCmd: string | undefined;
    let _validationToolchain: string | undefined;
    let _validationTestCmd: string | undefined;
    let _validationIntegrationTestCmd: string | undefined;
    const _testServicesSet = new Set<string>();
    for (const input of resolvedInputs) {
      if (input.validation) {
        const p = _levelPriority[input.validation] ?? 0;
        if (_maxValidationLevel === undefined || p > (_levelPriority[_maxValidationLevel] ?? 0)) {
          _maxValidationLevel = input.validation;
        }
        // The mechanical validation pod clones fresh and runs token-free — it must install deps
        // before the suite (a Python package is not importable without `pip install`). Capture the
        // install command from the first unit-or-higher task that declares one.
        if (!_validationInstallCmd && input.install && p >= 2) {
          _validationInstallCmd = input.install;
        }
        if (!_validationToolchain && input.toolchain && p >= 2) {
          _validationToolchain = input.toolchain;
        }
        if (!_validationTestCmd && input.test && p >= 2) {
          _validationTestCmd = input.test;
        }
        if (!_validationIntegrationTestCmd && input.integrationTest && p >= 3) {
          _validationIntegrationTestCmd = input.integrationTest;
        }
        if (input.validation === 'integration' && Array.isArray(input.testServices)) {
          for (const s of input.testServices) _testServicesSet.add(s);
        }
      }
    }

    const graph: TaskGraph = {
      id: graphId, project, cwd, status: "active",
      createdAt: Date.now(), maxConcurrency: opts?.maxConcurrency,
      acceptanceCriteria: opts?.acceptanceCriteria,
      parentGraphId: opts?.parentGraphId,
      destination: opts?.destination,
      defaultToolchain: opts?.defaultToolchain,
      selfImprove: opts?.selfImprove,
      autoRework: opts?.autoRework,
      // #317 phase3 (Task 6b): mark a rework fix child so it can never itself
      // auto-rework (maybeStartRework hard-returns) and completion routing can
      // derive fix-child existence by marker scan (M1). undefined ⇒ dropped by JSON.
      ...(opts?.isReworkFixChild ? { isReworkFixChild: true } : {}),
      // #317 phase3 (Task 6b): the round index this child fixes — the marker scan
      // matches `isReworkFixChild && attempt === currentRound.attempt` (M1/MEDIUM-2).
      ...(opts?.attempt !== undefined ? { attempt: opts.attempt } : {}),
      ...(_maxValidationLevel && { validationLevel: _maxValidationLevel }),
      ...(_validationInstallCmd && { validationInstallCmd: _validationInstallCmd }),
      ...(_validationToolchain && { validationToolchain: _validationToolchain }),
      ...(_validationTestCmd && { validationTestCmd: _validationTestCmd }),
      ...(_validationIntegrationTestCmd && { validationIntegrationTestCmd: _validationIntegrationTestCmd }),
      ...(_testServicesSet.size > 0 && { testServices: [..._testServicesSet] }),
    };
    await this.redis.set(`graph:${graphId}`, JSON.stringify(graph), "EX", TTL);

    // Register in the GraphRegistry for workspace-awareness (#235)
    if (this.graphRegistry) {
      try {
        const dk = destKey(opts?.destination ?? null, cwd);
        const baseRef = resolveDestination(this.gitDestinations, opts?.destination)?.baseRef ?? null;
        const predictedFiles = [
          ...new Set(resolvedInputs.flatMap((i) => parseFileRefsFromDescription(i.task ?? ""))),
        ];
        await this.graphRegistry.register(dk, {
          graphId, project, status: "active",
          destination: opts?.destination ?? null, baseRef,
          focus: resolvedInputs.map((i) => i.task ?? "").filter(Boolean).slice(0, 8),
          predictedFiles,
          startedAt: Date.now(), updatedAt: Date.now(),
        });
      } catch { /* advisory — never block declare */ }
    }

    // Register this graph as a child of the parent
    if (opts?.parentGraphId) {
      const parentRaw = await this.redis.get(`graph:${opts.parentGraphId}`);
      if (parentRaw) {
        const parent: TaskGraph = JSON.parse(parentRaw);
        parent.childGraphIds = parent.childGraphIds ?? [];
        if (!parent.childGraphIds.includes(graphId)) {
          parent.childGraphIds.push(graphId);
        }
        await this.redis.set(`graph:${opts.parentGraphId}`, JSON.stringify(parent), "EX", TTL);
      }
    }

    const pipeline = this.redis.pipeline();
    for (const input of resolvedInputs) {
      const node: TaskNode = {
        id: input.id, graphId, role: input.role, task: input.task,
        cwd: input.cwd || cwd, project, branch: input.branch,
        dependsOn: input.dependsOn || [], requireApproval: input.requireApproval || false,
        status: "pending", retries: 0, maxRetries: input.maxRetries || 0,
        createdAt: Date.now(), timeoutMs: input.timeoutMs,
        warnAfterMs: input.warnAfterMs, interrogateAfterMs: input.interrogateAfterMs,
        staleAfterMs: input.staleAfterMs,
        reviewLoop: input.reviewLoop,
        model: input.model, toolchain: input.toolchain, execMode: input.execMode,
        service: input.service, install: input.install, build: input.build,
        test: input.test, integrationTest: input.integrationTest,
        lint: input.lint, validation: input.validation,
        podMode: input.podMode, gitBaseRef: input.gitBaseRef, gitBranch: input.gitBranch,
        // #317 phase3 (Task 6b): carry the rework attempt index onto the fix task
        // node so graph-dispatch tags its invoke_agent span (bureau.task.attempt).
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      };
      pipeline.set(`graph:${graphId}:tasks:${input.id}`, JSON.stringify(node), "EX", TTL);

      if (input.dependsOn && input.dependsOn.length > 0) {
        pipeline.sadd(`graph:${graphId}:deps:${input.id}`, ...input.dependsOn);
        pipeline.expire(`graph:${graphId}:deps:${input.id}`, TTL);
        for (const dep of input.dependsOn) {
          pipeline.sadd(`graph:${graphId}:rdeps:${dep}`, input.id);
          pipeline.expire(`graph:${graphId}:rdeps:${dep}`, TTL);
        }
      }
    }

    // Add all task IDs to a set for efficient lookup
    pipeline.sadd(`graph:${graphId}:taskIds`, ...resolvedInputs.map(i => i.id));
    pipeline.expire(`graph:${graphId}:taskIds`, TTL);

    // Initialize the completed set (empty)
    pipeline.sadd(`graph:${graphId}:completed`, "__init__");
    pipeline.srem(`graph:${graphId}:completed`, "__init__");
    pipeline.expire(`graph:${graphId}:completed`, TTL);
    await pipeline.exec();

    await this.emitEvent({
      type: "graph_declared",
      graphId,
      timestamp: Date.now(),
      project,
      parentGraphId: opts?.parentGraphId,
      taskCount: resolvedInputs.length,
    });

    const readyTasks: string[] = [];
    for (const input of resolvedInputs) {
      if (!input.dependsOn || input.dependsOn.length === 0) {
        readyTasks.push(input.id);
        await this.updateTaskStatus(graphId, input.id, "ready");
        await this.emitEvent({ type: "task_ready", graphId, taskId: input.id, timestamp: Date.now() });
      }
    }

    // Claim orchestrator ownership for this graph
    if (this.sessionId) {
      await this.redis.set(`graph:${graphId}:orchestrator`, this.sessionId, "EX", 120);
    }

    await this.dispatchReadyTasks(graphId, readyTasks);
    return { graphId, readyTasks, totalTasks: resolvedInputs.length };
  }

  async onTaskCompleted(
    graphId: string, taskId: string, sessionId: string, exitCode: number,
  ): Promise<string[]> {
    // If this graph was merged into another, redirect so in-flight tasks complete in the right graph
    const currentGraph = await this.getGraph(graphId);
    if (currentGraph?.status === 'merged' && currentGraph.mergedIntoGraphId) {
      return this.onTaskCompleted(currentGraph.mergedIntoGraphId, taskId, sessionId, exitCode);
    }

    const existing = await this.getTask(graphId, taskId);
    if (existing?.status === 'completed' || existing?.status === 'canceled' || existing?.status === 'failed') {
      return []; // Already in terminal state — skip double-completion
    }
    await this.updateTaskStatus(graphId, taskId, "completed", { sessionId, exitCode, completedAt: Date.now() });
    await this.redis.sadd(`graph:${graphId}:completed`, taskId);

    // #311: when a conflict coordinator finishes and its dep's merge lands in integration,
    // the ORIGINAL task's dependents (blocked earlier by areDepsMerged) must be re-evaluated.
    let reintegratedTaskId: string | undefined;

    // Handle merge-coordinator task completion: re-attempt the original branch merge
    if (taskId.startsWith("merge-")) {
      const origTaskId = taskId.slice("merge-".length);
      const origTask = await this.getTask(graphId, origTaskId);
      // Pod-mode: re-merge the resolved conflict branch into integration (ancestor-guarded).
      if (this.remoteMerge && origTask?.podMode) {
        const coordTask = await this.getTask(graphId, taskId);
        const conflictBr = coordTask?.gitBranch ?? `bureau/${graphId.slice(0, 8)}/conflict-${origTaskId}`;
        const resolveStart = Date.now();
        try {
          const out = await this.remoteMerge.resolveAfterCoordinator(graphId, origTaskId, conflictBr, currentGraph?.destination);
          const resolved = out.strategy === "ff" || out.strategy === "merge" || out.strategy === "noop";
          if (resolved) {
            // Integration now contains the resolved work: clear the pending slot so dependents
            // (gated by areDepsMerged) can dispatch. #311.
            await this.redis.srem(`graph:${graphId}:pending_merges`, origTaskId);
            reintegratedTaskId = origTaskId;
            await this.emitEvent({ type: "worktree_merged", graphId, taskId: origTaskId, timestamp: Date.now(),
              detail: JSON.stringify({ mode: "pod", strategy: "agent-resolved" }) });
          } else {
            // Resolve failed: the dep's work is NOT on integration. Re-populate pending_merges so
            // areDepsMerged keeps dependents blocked and the graph hangs loudly (worktree_merge_failed)
            // instead of dispatching onto stale integration. Recover via retry_task on this merge-* task. #311.
            await this.redis.sadd(`graph:${graphId}:pending_merges`, origTaskId);
            await this.emitEvent({ type: "worktree_merge_failed", graphId, taskId: origTaskId, timestamp: Date.now(),
              detail: JSON.stringify({ mode: "pod", strategy: out.strategy, output: out.output }) });
          }
          try { onWorktreeMergeCompleted({ graphId, project: currentGraph?.project ?? "", taskId: origTaskId, status: resolved ? 'success' : 'failed', durationMs: Date.now() - resolveStart }); } catch { /* swallow */ }
        } catch (err) {
          // Same as the failure branch: keep the dep un-integrated so dependents stay blocked. #311.
          await this.redis.sadd(`graph:${graphId}:pending_merges`, origTaskId);
          await this.emitEvent({ type: "worktree_merge_failed", graphId, taskId: origTaskId, timestamp: Date.now(),
            detail: JSON.stringify({ mode: "pod", reason: "resolve_failed", output: String(err) }) });
        }
        // Fall through to task_completed + checkGraphCompletion (skip the host-mode block).
      }
      // Fall through to task_completed + checkGraphCompletion below.
      // coordinator tasks have no rdeps, so newlyReady will be [] naturally.
    }

    const task = await this.getTask(graphId, taskId);

    // #317 phase3 [C1]: set when a rework-fix task's merge into the PARENT integration
    // branch conflicts — handled AFTER the merge block (fail the fix round → terminal),
    // never by injecting a merge-coordinator into the reworking parent.
    let reworkFixMergeConflict = false;
    // #323: the pushed conflict branch + the fix task's own branch, captured
    // at the point the conflict is detected below — best-effort deleted from
    // origin AFTER the round is failed terminally so they don't linger.
    let reworkConflictCleanupBranches: (string | undefined)[] = [];

    // Pod-mode (k8s): the worker pushed its branch; integrate it remotely.
    if (this.remoteMerge && task?.podMode && task?.branch
        && !taskId.startsWith("merge-")) {
      const podGraph = currentGraph;
      // #317 phase3 [C1]: a rework-fix child owns nothing of its own to integrate — its
      // fix commit must land on the PARENT's integration branch (bureau/<parent8>/
      // integration), the merged candidate the re-validation gate re-runs against.
      // integrationBranch()/conflictBranch() derive PURELY from the id passed to
      // mergeTaskIntoIntegration, so routing the merge through the parent id lands the
      // fix on the parent integ ref with no RemoteMerge change (the task branch is passed
      // explicitly, so it is unaffected). Without this the fix would land on the fix
      // child's own throwaway integ branch → parent HEAD never moves → empty-fix terminal.
      const isReworkFix = !!(podGraph?.isReworkFixChild && podGraph.parentGraphId);
      const mergeGraphId = isReworkFix ? podGraph!.parentGraphId! : graphId;
      // Add to pending_merges unconditionally so checkGraphCompletion gates on it
      // regardless of whether this engine is capable of performing the merge.
      await this.redis.sadd(`graph:${graphId}:pending_merges`, taskId);

      if (!this.remoteMerge.hasMergeCapability()) {
        // Capability gate: this engine has no working merge clone.
        // Fail loudly — do NOT emit worktree_merging (false promise) and do NOT
        // silently no-op while reporting the graph as completed.
        // pending_merges stays populated so checkGraphCompletion blocks.
        await this.emitEvent({ type: "worktree_merge_failed", graphId, taskId, timestamp: Date.now(),
          detail: JSON.stringify({ mode: "pod", reason: "no_merge_clone",
            hint: "BUREAU_MERGE_CLONE_DIR must be set on the merge-capable (in-cluster) engine" }) });
        try { onWorktreeMergeCompleted({ graphId, project: podGraph?.project ?? "", taskId, status: 'failed', durationMs: 0 }); } catch { /* swallow */ }
      } else {
        await this.emitEvent({ type: "worktree_merging", graphId, taskId, timestamp: Date.now() });
        let outcome: RemoteMergeOutcome;
        const mergeStart = Date.now();
        try {
          outcome = await this.remoteMerge.mergeTaskIntoIntegration(mergeGraphId, taskId, task.branch, currentGraph?.destination);
        } catch (err) {
          outcome = { strategy: "error" as const, output: String(err) };
        }
        // Clear pending_merges only when the merge definitively resolves:
        // success (ff/merge/noop) or conflict (coordinator task takes over the slot).
        // On error/transient keep it populated so the graph cannot silently complete.
        const mergeResolved = outcome.strategy === "ff" || outcome.strategy === "merge"
          || outcome.strategy === "noop" || outcome.strategy === "conflict";
        if (mergeResolved) {
          await this.redis.srem(`graph:${graphId}:pending_merges`, taskId);
        }
        if (outcome.strategy === "ff" || outcome.strategy === "merge" || outcome.strategy === "noop") {
          await this.emitEvent({ type: "worktree_merged", graphId, taskId, timestamp: Date.now(),
            detail: JSON.stringify({ mode: "pod", strategy: outcome.strategy }) });
          try { onWorktreeMergeCompleted({ graphId, project: podGraph?.project ?? "", taskId, status: 'success', durationMs: Date.now() - mergeStart }); } catch { /* swallow */ }
        } else if (outcome.strategy === "conflict") {
          if (isReworkFix) {
            // #317 phase3 [C1]: a rework-fix merge conflict must NOT inject a
            // merge-coordinator into the reworking parent — that would spawn an unbounded
            // human-resolve task in the middle of the bounded auto-rework loop. Simplest
            // safe policy: fail the fix round → the reconciler's fix-child-failed path
            // (resumeReworkRound STEP 2) takes the round terminal (validation_failed).
            // Deferred to after the merge block so we return cleanly.
            await this.emitEvent({ type: "merge_conflict", graphId, taskId, sessionId, timestamp: Date.now(),
              detail: JSON.stringify({ mode: "pod", rework: true, conflictFiles: outcome.conflictFiles }) });
            try { onWorktreeMergeCompleted({ graphId, project: podGraph?.project ?? "", taskId, status: 'conflict', durationMs: Date.now() - mergeStart }); } catch { /* swallow */ }
            reworkFixMergeConflict = true;
            reworkConflictCleanupBranches = resolveReworkConflictCleanupTargets({
              isReworkFix, strategy: outcome.strategy, conflictBranch: outcome.conflictBranch,
              mergeGraphId, taskId, taskBranch: task.branch,
            });
          } else {
            await this.emitEvent({ type: "merge_conflict", graphId, taskId, sessionId, timestamp: Date.now(),
              detail: JSON.stringify({ mode: "pod", conflictFiles: outcome.conflictFiles, conflictBranch: outcome.conflictBranch }) });
            const g8 = graphId.slice(0, 8);
            const conflictBr = outcome.conflictBranch ?? `bureau/${g8}/conflict-${taskId}`;
            try {
              await this.addTask(graphId, {
                id: `merge-${taskId}`,
                role: "merge-coordinator",
                task: `Resolve the git merge conflict on the checked-out branch ${conflictBr}.\n`
                  + `These files contain standard conflict markers (<<<<<<< / ======= / >>>>>>>): `
                  + `${(outcome.conflictFiles ?? []).join(", ")}.\n`
                  + `Edit each file to reconcile BOTH sides into a single coherent result, remove all conflict markers, then commit the resolution. Finish by calling set_status done.\n`
                  + `Do NOT push to the integration or base branch — the engine re-integrates your resolved branch automatically.`,
                autoAdded: true,
                podMode: true,
                gitBaseRef: conflictBr,
                gitBranch: conflictBr,
              });
            } catch {
              // Graph may have already completed; the conflict is captured in the merge_conflict event.
            }
            try { onWorktreeMergeCompleted({ graphId, project: podGraph?.project ?? "", taskId, status: 'conflict', durationMs: Date.now() - mergeStart }); } catch { /* swallow */ }
          }
        } else {
          // error or transient: fail loudly. pending_merges stays populated to block graph completion.
          await this.emitEvent({ type: "worktree_merge_failed", graphId, taskId, timestamp: Date.now(),
            detail: JSON.stringify({ mode: "pod", strategy: outcome.strategy, output: outcome.output }) });
          const mergeErrClass = outcome.output ? classifyGitError(outcome.output) : null;
          const mergeErrorType = mergeErrClass && mergeErrClass.type !== 'other' ? mergeErrClass.type : undefined;
          try { onWorktreeMergeCompleted({ graphId, project: podGraph?.project ?? "", taskId, status: 'failed', durationMs: Date.now() - mergeStart, errorType: mergeErrorType }); } catch { /* swallow */ }
        }
      }
    }

    // #317 phase3 [C1]: a rework-fix task whose merge into the parent integration branch
    // conflicted → fail the fix child graph terminally (rather than injecting a
    // merge-coordinator). The reconciler's fix-child-failed path (resumeReworkRound STEP 2)
    // then takes the round to validation_failed. Return before task_completed processing —
    // this graph is terminal; its only obligation is to notify + re-drive the parent.
    if (reworkFixMergeConflict) {
      // [6b-M3 hand-off / Task 7 (h)] stamp the reason on the fix child's OWN graph
      // record (not just the event detail) so anything reading the child via
      // getGraph(childId) — e.g. a future STEP-2 fixFailed diagnostic — sees why it
      // failed, not just that it did.
      await this.updateGraphStatus(graphId, "failed", undefined, "rework_fix_merge_conflict");
      await this.emitEvent({ type: "graph_failed", graphId, timestamp: Date.now(),
        detail: JSON.stringify({ reason: "rework_fix_merge_conflict" }) });
      // #323: the round is already terminal — best-effort delete the pushed
      // conflict branch + the fix task's own branch so they don't linger as
      // origin litter. Never throws; a per-branch failure is only logged.
      await cleanupReworkConflictBranches(
        this.remoteMerge, reworkConflictCleanupBranches, currentGraph?.destination,
        (result) => logger.warn(
          { graphId, taskId, branch: result.branch, out: result.out },
          "rework-fix conflict cleanup: best-effort branch delete failed",
        ),
      );
      const fixGraph = await this.getGraph(graphId);
      if (fixGraph?.parentGraphId) {
        await this.emitEvent({ type: "child_graph_completed", graphId: fixGraph.parentGraphId,
          timestamp: Date.now(), detail: graphId, childGraphId: graphId });
        await this.checkGraphCompletion(fixGraph.parentGraphId);
      }
      return [];
    }

    await this.emitEvent({ type: "task_completed", graphId, taskId, sessionId, timestamp: Date.now() }, currentGraph);

    // Footprint capture: accumulate actual changed files in the registry (#235).
    if (this.graphRegistry) {
      try {
        const g = await this.getGraph(graphId);
        const handoff = await this.callbacks.getHandoff?.(graphId, taskId);
        const files = (handoff?.filesChanged ?? []).map((f: { path: string }) => f.path).filter(Boolean);
        if (g && files.length > 0) {
          await this.graphRegistry.addActualFiles(this.graphDestKey(g), graphId, files);
        }
      } catch { /* best-effort footprint capture */ }
    }

    const newlyReady: string[] = [];
    await this.readyDependentsOf(graphId, taskId, currentGraph, newlyReady);

    // #311 Part 2b: a conflict coordinator (merge-<orig>) has no rdeps of its own, so readying
    // its dependents above is a no-op. Re-evaluate the ORIGINAL task's dependents now that its
    // work is integrated — they were held back by the areDepsMerged gate while the coordinator ran.
    if (reintegratedTaskId) {
      await this.readyDependentsOf(graphId, reintegratedTaskId, currentGraph, newlyReady);
    }

    // Check if any yielded tasks were waiting on this completed task and can now resume
    if (this.yieldManager) {
      const activeYields = await this.yieldManager.getActiveYields(graphId);
      const completedKey = `graph:${graphId}:completed`;
      for (const yc of activeYields) {
        if (!yc.agents.includes(taskId)) continue;
        // Check if all yield-specific agents are completed (not areDepsReady, which
        // mixes static graph deps with runtime yield deps and can deadlock on self-deps)
        const agentStatuses = await Promise.all(
          yc.agents.map((a) => this.redis.sismember(completedKey, a)),
        );
        if (!agentStatuses.every(Boolean)) continue;

        // Resolve yield marker and transition task back to ready
        const resolvedContext = await this.yieldManager.resolveYield(graphId, yc.taskId);
        if (!resolvedContext) continue;

        // Build handoff context from the agents that were waited on
        let handoffContext = "";
        if (resolvedContext.agents.length > 0) {
          const handoffSections: string[] = [];
          for (const agentId of resolvedContext.agents) {
            const handoffData = await this.redis.get(`handoff:${graphId}:${agentId}`);
            if (handoffData) handoffSections.push(handoffData);
          }
          handoffContext = handoffSections.join("\n\n");
        }

        const resumeContext = this.yieldManager.buildResumeContext(
          resolvedContext,
          handoffContext ? { [taskId]: handoffContext } : {},
        );

        // Update task node with resume context for the next dispatch
        await this.updateTaskFields(graphId, yc.taskId, {
          task: (await this.getTask(graphId, yc.taskId))?.task ?? yc.taskId,
        });

        await this.updateTaskStatus(graphId, yc.taskId, "ready");
        newlyReady.push(yc.taskId);

        // Store resume context in Redis so dispatch handler can include it in the spawn
        await this.redis.set(
          `resume:${graphId}:${yc.taskId}`,
          resumeContext,
          "EX", TTL,
        );

        // Cancel any pending escalation timer for this yielded task
        this.yieldEscalation?.cancelEscalation(graphId, yc.taskId);
      }
    }

    // Fetch tasks once: reused for maxConcurrency throttle pick-up, dispatch concurrency
    // check, and completion check — avoids repeated SMEMBERS + pipeline GET* round-trips.
    const cachedTasks = await this.getAllTasks(graphId);

    // Also pick up tasks that were ready but throttled by maxConcurrency
    if (currentGraph?.maxConcurrency) {
      const throttled = cachedTasks
        .filter((t) => t.status === "ready" && !newlyReady.includes(t.id))
        .map((t) => t.id);
      newlyReady.push(...throttled);
    }

    // Authoritative: a worker just completed, so this engine is the execution
    // driver — dispatch the unblocked dependents even if a monitoring session holds
    // the ownership lease (issue #178).
    if (newlyReady.length > 0) await this.dispatchReadyTasks(graphId, newlyReady, cachedTasks, { authoritative: true });
    await this.checkGraphCompletion(graphId, cachedTasks);
    return newlyReady;
  }

  async onTaskYielded(
    graphId: string, taskId: string, yieldContext: YieldContext,
  ): Promise<void> {
    // Guard: if the task was already auto-resolved by yield escalation (which fires
    // via setTimeout(0) when the yield marker is written), don't overwrite the status.
    // This prevents a race where escalation resolves → sets "ready" → onTaskYielded
    // from ProcessMonitor sets it back to "yielded", stalling the graph.
    const currentTask = await this.getTask(graphId, taskId);
    if (currentTask && currentTask.status !== "running" && currentTask.status !== "yielded") {
      return; // Already resolved or dispatched — don't regress
    }

    await this.updateTaskStatus(graphId, taskId, "yielded");
    await this.updateTaskFields(graphId, taskId, { completedAt: undefined });

    // NOTE: yield marker is already in Redis — written by the agent's yield_to tool call
    // before process exit. Do NOT re-write it here; the double-write created a corruption
    // window where onTaskCompleted could resolve the marker between the two writes (#113).

    await this.emitEvent({
      type: "task_yielded", graphId, taskId, timestamp: Date.now(),
      detail: yieldContext.reason,
    });

    // Add runtime dependencies: for each agent this task is waiting for,
    // register a reverse dependency so that when that agent completes, we
    // re-evaluate whether the yielded task can resume.
    if (yieldContext.agents.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const agentId of yieldContext.agents) {
        pipeline.sadd(`graph:${graphId}:deps:${taskId}`, agentId);
        pipeline.expire(`graph:${graphId}:deps:${taskId}`, TTL);
        pipeline.sadd(`graph:${graphId}:rdeps:${agentId}`, taskId);
        pipeline.expire(`graph:${graphId}:rdeps:${agentId}`, TTL);
      }
      await pipeline.exec();
    }

    // Start escalation ladder: auto-resolve check + 5-minute fallback
    if (this.yieldEscalation) {
      const task = await this.getTask(graphId, taskId);
      // Pod-mode workers run in their own pod workspace, never a local worktree.
      this.yieldEscalation.startEscalation(graphId, taskId, false);
    }
  }

  async onTaskFailed(
    graphId: string, taskId: string, sessionId: string, exitCode: number,
    options?: { skipRetry?: boolean; failureReason?: string },
  ): Promise<void> {
    // If this graph was merged into another, redirect so in-flight tasks fail in the right graph
    const currentGraph = await this.getGraph(graphId);
    if (currentGraph?.status === 'merged' && currentGraph.mergedIntoGraphId) {
      return this.onTaskFailed(currentGraph.mergedIntoGraphId, taskId, sessionId, exitCode, options);
    }

    const task = await this.getTask(graphId, taskId);
    if (!task) return;
    if (task.status === 'completed' || task.status === 'canceled' || task.status === 'failed') {
      return; // Already in terminal state — don't cascade again
    }

    if (!options?.skipRetry) {
      // Auto-retry once on OOM kill (SIGKILL=137) or SEGFAULT (139), even if maxRetries is 0
      if ((exitCode === 137 || exitCode === 139) && task.retries === 0) {
        await this.updateTaskStatus(graphId, taskId, 'ready');
        await this.updateTaskFields(graphId, taskId, { retries: 1, sessionId: undefined });
        await this.emitEvent({
          type: 'task_failed', graphId, taskId, sessionId, timestamp: Date.now(),
          detail: `Agent killed (exit ${exitCode}). Auto-retrying once.`,
        });
        // Authoritative: worker-failure-driven re-dispatch on the processing engine (#178).
        await this.dispatchReadyTasks(graphId, [taskId], undefined, { authoritative: true });
        return;
      }

      if (task.retries < task.maxRetries) {
        const retriesBefore = task.retries; // pre-increment value → nextBackoffMs(0) = first retry
        await this.resetTaskForRetry(graphId, taskId, retriesBefore + 1);
        const delayMs = this.retryPolicy.nextBackoffMs(retriesBefore);
        if (delayMs <= 0) {
          // Zero-delay path: used for test injection / disabled-backoff policies.
          await this.resumeDispatch(graphId);
        } else {
          // NOTE — operator carve-out: retryTask and resume_graph call resumeDispatch
          // unconditionally, so a task mid-backoff (pending, deps satisfied) will be
          // dispatched early by those actions.  This is intentional — operator intent
          // overrides the backoff window (consistent with retryTask being immediate by
          // design).  When that happens, the late-firing timer below becomes a no-op:
          // resumeDispatch only dispatches tasks in "ready" or "pending" status, so a
          // task already running/completed is safely skipped.
          //
          // NOTE — cleanup tool timer leak: cleanup_graph / cleanup_all (src/tools/cleanup.ts)
          // delete Redis keys directly without calling cancelGraph(), so they do not clear
          // retryTimers.  This is safe: when the timer fires it calls getGraph(), which
          // returns null for a deleted graph, and the status guard prevents any dispatch.
          // The timer self-heals on fire and does not block process exit (it is unref'd).
          const timer = setTimeout(() => {
            // Remove this timer from the registry first
            const timers = this.retryTimers.get(graphId);
            if (timers) {
              timers.delete(timer);
              if (timers.size === 0) this.retryTimers.delete(graphId);
            }
            // Guard: do not dispatch if the graph was canceled/cleaned while we waited.
            // resumeDispatch is awaited inside the chain so a rejection (e.g. transient
            // Redis error) is caught here rather than escaping as an unhandled rejection
            // that would trigger the global handler in mcp-server.ts and exit the process.
            this.getGraph(graphId)
              .then(async (g) => {
                if (g && g.status !== "canceled" && g.status !== "completed" && g.status !== "failed") {
                  await this.resumeDispatch(graphId);
                }
              })
              .catch((err) => {
                logger.warn({ graphId, err: String(err) }, "backoff re-dispatch failed");
              });
          }, delayMs);
          // Unref so this timer does not prevent the process from exiting
          timer.unref();
          // Register the timer so cancelGraph() can clear it
          let timers = this.retryTimers.get(graphId);
          if (!timers) { timers = new Set(); this.retryTimers.set(graphId, timers); }
          timers.add(timer);
        }
        return;
      }
    }

    // #317 phase3 hop 1: persist the reason onto the TaskNode (previously it only
    // rode the transient task_failed event below) so the graph's own
    // checkGraphCompletion — and eventually the parent's trigger discriminator via
    // getGraph(childId) — can read WHY this task failed, not just THAT it failed.
    await this.updateTaskStatus(graphId, taskId, "failed", {
      sessionId, exitCode, completedAt: Date.now(),
      ...(options?.failureReason !== undefined ? { failureReason: options.failureReason } : {}),
    });
    await this.emitEvent({
      type: "task_failed", graphId, taskId, sessionId, timestamp: Date.now(),
      exitCode,
      failureReason: options?.failureReason,
    });
    await this.cascadeCancel(graphId, taskId);
    await this.checkGraphCompletion(graphId);
  }

  async approveTask(graphId: string, taskId: string): Promise<void> {
    const task = await this.getTask(graphId, taskId);
    if (!task || task.status !== "awaiting_approval") {
      throw new Error(`Task ${taskId} is not awaiting approval (status: ${task?.status})`);
    }
    await this.updateTaskStatus(graphId, taskId, "ready");
    await this.dispatchReadyTasks(graphId, [taskId]);
  }

  async resumeDispatch(graphId: string): Promise<string[]> {
    const tasks = await this.getAllTasks(graphId);
    const toDispatch: string[] = [];

    for (const task of tasks) {
      if (task.status === "ready") {
        toDispatch.push(task.id);
      } else if (task.status === "pending" && await this.depsReadyAndMerged(graphId, task.id)) {
        await this.updateTaskStatus(graphId, task.id, "ready");
        toDispatch.push(task.id);
      } else if (task.status === "yielded" && this.yieldManager) {
        // Check if yield conditions are resolved (all waited-on agents completed)
        const yc = await this.yieldManager.getYieldContext(graphId, task.id);
        if (!yc) {
          // Yield marker expired or missing — retry via state machine: yielded → pending → ready
          await this.updateTaskStatus(graphId, task.id, "pending");
          await this.updateTaskStatus(graphId, task.id, "ready");
          toDispatch.push(task.id);
          continue;
        }
        const completedKey = `graph:${graphId}:completed`;
        const agentStatuses = await Promise.all(
          yc.agents.map((a) => this.redis.sismember(completedKey, a)),
        );
        if (agentStatuses.every(Boolean)) {
          // All agents the task was waiting on have completed — resolve and re-dispatch
          const resolvedContext = await this.yieldManager.resolveYield(graphId, task.id);
          if (resolvedContext) {
            let handoffContext = "";
            const handoffSections: string[] = [];
            for (const agentId of resolvedContext.agents) {
              const handoffData = await this.redis.get(`handoff:${graphId}:${agentId}`);
              if (handoffData) handoffSections.push(handoffData);
            }
            handoffContext = handoffSections.join("\n\n");

            const resumeContext = this.yieldManager.buildResumeContext(
              resolvedContext,
              handoffContext ? { [task.id]: handoffContext } : {},
            );
            await this.redis.set(
              `resume:${graphId}:${task.id}`,
              resumeContext,
              "EX", TTL,
            );
          }
          // Transition via state machine: yielded → pending → ready
          await this.updateTaskStatus(graphId, task.id, "pending");
          await this.updateTaskStatus(graphId, task.id, "ready");
          toDispatch.push(task.id);
        }
      }
    }

    if (toDispatch.length > 0) {
      await this.dispatchReadyTasks(graphId, toDispatch);
    }

    return toDispatch;
  }

  async retryTask(
    graphId: string,
    taskId: string,
    resetDependents = true,
  ): Promise<{ retriedTask: string; resetTasks: string[]; graphReactivated: boolean }> {
    const graph = await this.getGraph(graphId);
    if (!graph) throw new Error(`Graph ${graphId} not found`);

    const task = await this.getTask(graphId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found in graph ${graphId}`);

    if (task.status !== "failed" && task.status !== "canceled" && task.status !== "yielded") {
      throw new Error(
        `Task ${taskId} cannot be retried (status: ${task.status}). Only failed, canceled, or yielded tasks can be retried.`,
      );
    }

    // Clean up yield marker if retrying a yielded task
    if (task.status === "yielded" && this.yieldManager) {
      await this.yieldManager.resolveYield(graphId, taskId);
      this.yieldEscalation?.cancelEscalation(graphId, taskId);
    }

    const resetTasks = await this.resetTaskForRetry(graphId, taskId, 0, resetDependents);

    // Reactivate the graph if it was failed (clear completedAt too)
    let graphReactivated = false;
    if (graph.status === "failed" || graph.status === "canceled") {
      const currentGraph = await this.getGraph(graphId);
      if (currentGraph) {
        currentGraph.status = "active";
        currentGraph.completedAt = undefined;
        // #317 phase3 review: a reactivated graph is starting a fresh round — the
        // previous round's failureReason (landed on the graph record by hop 3) must
        // not survive, or a fail -> retry -> success sequence leaves a stale reason
        // on an otherwise-successful graph forever.
        delete currentGraph.failureReason;
        await this.redis.set(`graph:${graphId}`, JSON.stringify(currentGraph), "EX", TTL);
        graphReactivated = true;
      }
    }

    // Dispatch any tasks that are now ready (retried task + eligible dependents)
    await this.resumeDispatch(graphId);

    return { retriedTask: taskId, resetTasks, graphReactivated };
  }

  async cancelGraph(graphId: string): Promise<number> {
    // Clear any pending retry timers so an in-flight backoff doesn't dispatch
    // into a graph that has just been canceled.
    const timers = this.retryTimers.get(graphId);
    if (timers) {
      for (const t of timers) clearTimeout(t);
      this.retryTimers.delete(graphId);
    }

    const tasks = await this.getAllTasks(graphId);
    let canceled = 0;
    for (const task of tasks) {
      if (task.status !== "completed" && task.status !== "failed" && task.status !== "canceled") {
        // A `running` task has a live worker (k8s Job under pod-mode). Tear it down
        // BEFORE we lose the in-memory state — otherwise the pod keeps running until
        // its own timeout and can still commit & push its branch (#184).
        const hadLiveWorker = task.status === "running";
        await this.updateTaskStatus(graphId, task.id, "canceled");
        if (hadLiveWorker) await this.killTaskWorker(task);
        canceled++;
      }
    }
    await this.updateGraphStatus(graphId, "canceled");
    await this.emitEvent({
      type: "graph_canceled",
      graphId,
      timestamp: Date.now(),
      detail: `${canceled} task(s) canceled`,
    });
    return canceled;
  }

  /** Reap a graph that is stuck in a non-terminal status (`active`/`validating`/
   *  `reworking`) with no live tasks and no activity — the gap nothing else closes
   *  (#232). Marks it `failed`, emits `graph_failed`, and lets the orchestrator key
   *  TTL out. Idempotent: a graph that has since reached a terminal status is left
   *  untouched. Does NOT kill workers (the precondition is that none are live); use
   *  cancelGraph for graphs with live tasks.
   *
   *  #317 phase3 pre-merge sweep item 5(b): `reworking` MUST be accepted here, not
   *  just at the health-sweep call site (health-sweep.ts's reapStaleGraphs already
   *  added `reworking` to ITS OWN staleness scan per Task 7, item c/d). Before this
   *  fix, the two guards disagreed: health-sweep would identify a genuinely-stuck
   *  `reworking` graph as stale, claim the single-reaper lock, and call this method —
   *  which then silently returned `false` because its status check only allowed
   *  `active`/`validating`. The stalereap:claimed debounce key still gets set on
   *  that no-op attempt, so the graph was never actually reaped AND could never be
   *  retried — a stuck reworking graph was permanently immortal despite passing
   *  every staleness check. */
  async reapStaleGraph(graphId: string, reason: string): Promise<boolean> {
    const graph = await this.getGraph(graphId);
    if (!graph) return false;
    if (graph.status !== "active" && graph.status !== "validating" && graph.status !== "reworking") return false;
    const timers = this.retryTimers.get(graphId);
    if (timers) {
      for (const t of timers) clearTimeout(t);
      this.retryTimers.delete(graphId);
    }
    await this.updateGraphStatus(graphId, "failed");
    await this.emitEvent({
      type: "graph_failed",
      graphId,
      timestamp: Date.now(),
      detail: `reaped stale graph — ${reason}`,
    });
    return true;
  }

  /** Best-effort: tear down a task's running worker via the injected kill seam
   *  (#184). Under k8s (pod-mode) this deletes the worker Job so a canceled/killed
   *  task's pod stops holding cluster resources and can no longer push its branch.
   *  No-ops when the task has no session or no seam is wired; never throws. */
  async killTaskWorker(task: TaskNode): Promise<void> {
    if (!task.sessionId || !this.callbacks.killWorker) return;
    try {
      await this.callbacks.killWorker(task.sessionId, task);
    } catch (err) {
      logger.warn({ graphId: task.graphId, taskId: task.id, err: String(err) }, "killWorker seam threw (best effort)");
    }
  }

  async addTask(
    graphId: string,
    input: TaskNodeInput,
  ): Promise<void> {
    const graph = await this.getGraph(graphId);
    if (!graph) throw new Error(`Graph ${graphId} not found`);
    if (graph.status !== "active") throw new Error(`Graph is ${graph.status}, cannot add tasks`);

    const existing = await this.getTask(graphId, input.id);
    if (existing) throw new Error(`Task ${input.id} already exists in graph`);

    if (input.dependsOn) {
      const taskIds = await this.redis.smembers(`graph:${graphId}:taskIds`);
      for (const dep of input.dependsOn) {
        if (!taskIds.includes(dep)) {
          throw new Error(`Dependency "${dep}" not found in graph`);
        }
      }
    }

    // Validate no cycles
    const allTasks = await this.getAllTasks(graphId);
    const allInputs: TaskNodeInput[] = allTasks.map((t) => ({
      id: t.id, role: t.role, task: t.task, dependsOn: t.dependsOn,
    }));
    allInputs.push(input);
    this.validateDAG(allInputs);

    const node: TaskNode = {
      id: input.id, graphId, role: input.role, task: input.task,
      cwd: input.cwd || graph.cwd, project: graph.project, branch: input.branch,
      dependsOn: input.dependsOn || [], requireApproval: input.requireApproval || false,
      status: "pending", retries: 0, maxRetries: input.maxRetries || 0,
      createdAt: Date.now(), timeoutMs: input.timeoutMs,
      warnAfterMs: input.warnAfterMs, interrogateAfterMs: input.interrogateAfterMs,
      staleAfterMs: input.staleAfterMs,
      reviewLoop: input.reviewLoop, autoAdded: input.autoAdded,
      model: input.model, toolchain: input.toolchain, execMode: input.execMode,
      service: input.service, install: input.install, build: input.build,
      test: input.test, integrationTest: input.integrationTest,
      lint: input.lint, validation: input.validation,
      podMode: input.podMode, gitBaseRef: input.gitBaseRef, gitBranch: input.gitBranch,
    };

    const pipeline = this.redis.pipeline();
    pipeline.set(`graph:${graphId}:tasks:${input.id}`, JSON.stringify(node), "EX", 86400);
    pipeline.sadd(`graph:${graphId}:taskIds`, input.id);

    if (input.dependsOn && input.dependsOn.length > 0) {
      pipeline.sadd(`graph:${graphId}:deps:${input.id}`, ...input.dependsOn);
      pipeline.expire(`graph:${graphId}:deps:${input.id}`, 86400);
      for (const dep of input.dependsOn) {
        pipeline.sadd(`graph:${graphId}:rdeps:${dep}`, input.id);
        pipeline.expire(`graph:${graphId}:rdeps:${dep}`, 86400);
      }
    }

    await pipeline.exec();

    await this.emitEvent({
      type: "task_added", graphId, taskId: input.id, timestamp: Date.now(),
    });
    try { onTaskAdded({ graphId, taskId: input.id, role: input.role, timestamp: Date.now() }); } catch { /* swallow */ }

    if (await this.depsReadyAndMerged(graphId, input.id)) {
      await this.updateTaskStatus(graphId, input.id, "ready");
      await this.dispatchReadyTasks(graphId, [input.id]);
    }
  }

  async mergeGraphs(
    targetGraphId: string,
    sourceGraphId: string,
    opts?: {
      remapIds?: Record<string, string>;
      bridgeDeps?: Array<{ taskId: string; dependsOn: string[] }>;
    },
  ): Promise<void> {
    const targetGraph = await this.getGraph(targetGraphId);
    if (!targetGraph) throw new Error(`Target graph ${targetGraphId} not found`);
    if (targetGraph.status !== "active") {
      throw new Error(`Target graph is ${targetGraph.status}, must be active to merge into`);
    }

    const sourceGraph = await this.getGraph(sourceGraphId);
    if (!sourceGraph) throw new Error(`Source graph ${sourceGraphId} not found`);
    if (sourceGraph.status !== "active") {
      throw new Error(`Source graph is ${sourceGraph.status}, must be active to merge`);
    }

    const sourceTasks = await this.getAllTasks(sourceGraphId);
    const remapIds = opts?.remapIds ?? {};

    // Check for task ID collisions
    const targetTaskIds = await this.redis.smembers(`graph:${targetGraphId}:taskIds`);
    for (const sourceTask of sourceTasks) {
      const newId = remapIds[sourceTask.id] ?? sourceTask.id;
      if (targetTaskIds.includes(newId)) {
        throw new Error(`Task ID collision: "${newId}" already exists in target graph. Use remapIds to resolve.`);
      }
    }

    // Build combined task list for DAG validation
    const targetTasks = await this.getAllTasks(targetGraphId);
    const allForValidation: TaskNodeInput[] = [
      ...targetTasks.map((t) => ({ id: t.id, role: t.role, task: t.task, dependsOn: t.dependsOn })),
      ...sourceTasks.map((t) => {
        const newId = remapIds[t.id] ?? t.id;
        const newDeps = (t.dependsOn ?? []).map((dep) => remapIds[dep] ?? dep);
        return { id: newId, role: t.role, task: t.task, dependsOn: newDeps };
      }),
    ];

    // Apply bridgeDeps to the validation inputs
    if (opts?.bridgeDeps) {
      for (const bridge of opts.bridgeDeps) {
        const entry = allForValidation.find((t) => t.id === bridge.taskId);
        if (entry) {
          entry.dependsOn = [...(entry.dependsOn ?? []), ...bridge.dependsOn];
        }
      }
    }

    this.validateDAG(allForValidation);

    // Copy source tasks into target graph
    const pipeline = this.redis.pipeline();
    const completedTaskIds: string[] = [];

    for (const sourceTask of sourceTasks) {
      const newId = remapIds[sourceTask.id] ?? sourceTask.id;
      const newDeps = (sourceTask.dependsOn ?? []).map((dep) => remapIds[dep] ?? dep);

      const node: TaskNode = { ...sourceTask, id: newId, graphId: targetGraphId, dependsOn: newDeps };
      pipeline.set(`graph:${targetGraphId}:tasks:${newId}`, JSON.stringify(node), "EX", TTL);
      pipeline.sadd(`graph:${targetGraphId}:taskIds`, newId);

      if (newDeps.length > 0) {
        pipeline.sadd(`graph:${targetGraphId}:deps:${newId}`, ...newDeps);
        pipeline.expire(`graph:${targetGraphId}:deps:${newId}`, TTL);
        for (const dep of newDeps) {
          pipeline.sadd(`graph:${targetGraphId}:rdeps:${dep}`, newId);
          pipeline.expire(`graph:${targetGraphId}:rdeps:${dep}`, TTL);
        }
      }

      if (sourceTask.status === "completed") {
        completedTaskIds.push(newId);
      }
    }

    if (completedTaskIds.length > 0) {
      pipeline.sadd(`graph:${targetGraphId}:completed`, ...completedTaskIds);
    }

    await pipeline.exec();


    // Re-point running agents' peer data to target graph
    for (const sourceTask of sourceTasks) {
      if (sourceTask.status === "running" && sourceTask.sessionId) {
        const peerKey = `peers:${sourceTask.sessionId}`;
        const peerRaw = await this.redis.get(peerKey);
        if (peerRaw) {
          const peer = JSON.parse(peerRaw);
          peer.graphId = targetGraphId;
          peer.project = targetGraph.project;
          const ttl = await this.redis.ttl(peerKey);
          await this.redis.set(peerKey, JSON.stringify(peer), "EX", ttl > 0 ? ttl : 300);
        }
      }
    }
    // Apply bridgeDeps — update deps/rdeps sets and task nodes
    if (opts?.bridgeDeps) {
      const bridgePipeline = this.redis.pipeline();
      for (const bridge of opts.bridgeDeps) {
        if (bridge.dependsOn.length > 0) {
          bridgePipeline.sadd(`graph:${targetGraphId}:deps:${bridge.taskId}`, ...bridge.dependsOn);
          bridgePipeline.expire(`graph:${targetGraphId}:deps:${bridge.taskId}`, TTL);
          for (const dep of bridge.dependsOn) {
            bridgePipeline.sadd(`graph:${targetGraphId}:rdeps:${dep}`, bridge.taskId);
            bridgePipeline.expire(`graph:${targetGraphId}:rdeps:${dep}`, TTL);
          }
        }
      }
      await bridgePipeline.exec();

      // Update each bridged task's dependsOn array in its node
      for (const bridge of opts.bridgeDeps) {
        const validEntry = allForValidation.find((t) => t.id === bridge.taskId);
        if (validEntry) {
          await this.updateTaskFields(targetGraphId, bridge.taskId, {
            dependsOn: validEntry.dependsOn ?? [],
          });
        }
      }
    }

    // Mark source graph as 'merged' with pointer to target
    const updatedSource = await this.getGraph(sourceGraphId);
    if (updatedSource) {
      updatedSource.status = "merged";
      updatedSource.mergedIntoGraphId = targetGraphId;
      await this.redis.set(`graph:${sourceGraphId}`, JSON.stringify(updatedSource), "EX", TTL);
    }

    await this.emitEvent({
      type: "graphs_merged",
      graphId: targetGraphId,
      timestamp: Date.now(),
      detail: JSON.stringify({ sourceGraphId, tasksMerged: sourceTasks.length }),
    });

    // Dispatch pending/ready source tasks that are now ready in target
    const toDispatch: string[] = [];
    for (const sourceTask of sourceTasks) {
      if (sourceTask.status === "pending" || sourceTask.status === "ready") {
        const newId = remapIds[sourceTask.id] ?? sourceTask.id;
        if (await this.depsReadyAndMerged(targetGraphId, newId)) {
          await this.updateTaskStatus(targetGraphId, newId, "ready");
          toDispatch.push(newId);
        }
      }
    }
    if (toDispatch.length > 0) {
      await this.dispatchReadyTasks(targetGraphId, toDispatch);
    }
  }

  async emitEventPublic(event: TaskEvent): Promise<void> {
    await this.emitEvent(event);
  }

  /**
   * Resolves a yielded task and re-dispatches it. Called by YieldEscalation for
   * auto-resolve and 5-minute fallback scenarios.
   * @param autoReason - appended to the resume context so the agent knows why it was auto-resumed
   */
  async resumeYieldedTask(graphId: string, taskId: string, autoReason?: string): Promise<void> {
    if (!this.yieldManager) return;

    const resolvedContext = await this.yieldManager.resolveYield(graphId, taskId);
    if (!resolvedContext) return;

    let resumeContext = this.yieldManager.buildResumeContext(resolvedContext, {});
    if (autoReason) {
      resumeContext += `\n\n**Auto-resolved:** ${autoReason}`;
    }

    await this.redis.set(`resume:${graphId}:${taskId}`, resumeContext, "EX", TTL);
    await this.updateTaskStatus(graphId, taskId, "ready");

    await this.emitEvent({
      type: "yield_auto_resolved",
      graphId,
      taskId,
      timestamp: Date.now(),
      detail: autoReason ?? "yield resolved",
    });

    try {
      await this.dispatchReadyTasks(graphId, [taskId]);
    } catch (err: any) {
      // Dispatch failed — revert to yielded so retry_task can recover (#113)
      await this.updateTaskStatus(graphId, taskId, "failed");
      await this.emitEvent({
        type: "task_failed",
        graphId,
        taskId,
        timestamp: Date.now(),
        detail: `yield resume dispatch failed: ${err.message}`,
      });
      await this.checkGraphCompletion(graphId);
    }
  }

  async onValidationCompleted(graphId: string, passed: boolean): Promise<void> {
    if (passed) {
      await this.updateGraphStatus(graphId, "validated");
      await this.emitEvent({ type: "graph_validated", graphId, timestamp: Date.now() });
    } else {
      await this.updateGraphStatus(graphId, "validation_failed");
      await this.emitEvent({ type: "graph_validation_failed", graphId, timestamp: Date.now() });
    }
  }

  async getGraph(graphId: string): Promise<TaskGraph | null> {
    const data = await this.redis.get(`graph:${graphId}`);
    return data ? JSON.parse(data) as TaskGraph : null;
  }

  /**
   * Returns how many levels deep this graph is in the parent chain.
   * Root graphs (no parentGraphId) return 0. A direct child returns 1, etc.
   * Caps at 10 to guard against corrupt/circular data.
   */
  async getGraphDepth(graphId: string): Promise<number> {
    let depth = 0;
    let currentId: string | undefined = graphId;
    while (currentId && depth <= 10) {
      const graph = await this.getGraph(currentId);
      if (!graph?.parentGraphId) break;
      depth++;
      currentId = graph.parentGraphId;
    }
    return depth;
  }

  async getTask(graphId: string, taskId: string): Promise<TaskNode | null> {
    const data = await this.redis.get(`graph:${graphId}:tasks:${taskId}`);
    return data ? JSON.parse(data) as TaskNode : null;
  }

  async getAllTasks(graphId: string): Promise<TaskNode[]> {
    const taskIds = await this.redis.smembers(`graph:${graphId}:taskIds`);
    if (taskIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const id of taskIds) {
      pipeline.get(`graph:${graphId}:tasks:${id}`);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const tasks: TaskNode[] = [];
    for (const [err, data] of results) {
      if (err || !data) continue;
      tasks.push(JSON.parse(data as string) as TaskNode);
    }
    return tasks;
  }

  async getGraphVisualization(graphId: string): Promise<string> {
    const graph = await this.getGraph(graphId);
    if (!graph) return "Graph not found.";
    const tasks = await this.getAllTasks(graphId);
    if (tasks.length === 0) return "No tasks in graph.";

    const statusIcon: Record<string, string> = {
      pending: "\u23f3", ready: "\u25cb", awaiting_approval: "\u23f8",
      running: "\u25cf", completed: "\u2713", failed: "\u2715",
      canceled: "\u2013",
      verifying: "\u2699", verification_failed: "\u2717",
    };

    const completedCount = tasks.filter((t) => t.status === "completed").length;
    const wallClock = graph.completedAt
      ? Math.round((graph.completedAt - graph.createdAt) / 1000)
      : Math.round((Date.now() - graph.createdAt) / 1000);

    const lines: string[] = [
      `Graph: ${graphId.slice(0, 8)} | Status: ${graph.status} | ${completedCount}/${tasks.length} completed | ${wallClock}s elapsed`,
      "",
    ];

    for (const task of tasks) {
      const icon = statusIcon[task.status] || "?";
      const deps = task.dependsOn.length > 0 ? ` (depends on: ${task.dependsOn.join(", ")})` : "";

      let timing = "";
      if (task.startedAt && task.completedAt) {
        timing = ` ${Math.round((task.completedAt - task.startedAt) / 1000)}s`;
      } else if (task.startedAt) {
        timing = ` ${Math.round((Date.now() - task.startedAt) / 1000)}s+`;
      }

      lines.push(`  [${task.id} ${task.role} ${icon}${task.status}${timing}]${deps}`);
    }

    lines.push("");
    lines.push("Legend: \u2713=completed \u25cf=running \u25cb=ready \u23f3=pending \u2715=failed \u23f8=approval \u2013=canceled");
    return lines.join("\n");
  }

  private validateDAG(inputs: TaskNodeInput[]): void {
    validateDAGInput(inputs);
  }

  private async areDepsReady(graphId: string, taskId: string): Promise<boolean> {
    const depsKey = `graph:${graphId}:deps:${taskId}`;
    const completedKey = `graph:${graphId}:completed`;
    const depsExist = await this.redis.exists(depsKey);
    if (!depsExist) return true;
    const unmet = await this.redis.sdiff(depsKey, completedKey);
    return unmet.length === 0;
  }

  /**
   * Handoff-integration gate (#311): a dependent may only dispatch once each dep's work
   * is actually on the integration branch — not merely status=completed. A dep is "not yet
   * integrated" while it sits in pending_merges (merge in flight / transient-failed) or while
   * a merge-<dep> conflict coordinator is unresolved (its work is on a conflict branch). Returns
   * true for non-pod / no-merge graphs (empty pending_merges, no merge tasks), so callers may
   * apply it unconditionally.
   */
  private async areDepsMerged(graphId: string, taskId: string): Promise<boolean> {
    const deps = await this.redis.smembers(`graph:${graphId}:deps:${taskId}`);
    if (deps.length === 0) return true;
    const pending = new Set(await this.redis.smembers(`graph:${graphId}:pending_merges`));
    for (const dep of deps) {
      if (pending.has(dep)) return false;
      const mergeTask = await this.getTask(graphId, `merge-${dep}`);
      if (mergeTask && mergeTask.status !== "completed") return false;
    }
    return true;
  }

  /** The single dispatch-readiness predicate (#311): deps completed AND their merges integrated. */
  private async depsReadyAndMerged(graphId: string, taskId: string): Promise<boolean> {
    return (await this.areDepsReady(graphId, taskId)) && (await this.areDepsMerged(graphId, taskId));
  }

  /**
   * Ready every pending dependent of `ofTaskId` that has all deps completed (areDepsReady)
   * AND all deps integrated (areDepsMerged, #311), appending readied ids to `newlyReady`.
   * Factored out of onTaskCompleted so the merge-coordinator path can re-evaluate the
   * ORIGINAL task's dependents after a conflict merge lands (they were blocked by the gate).
   */
  private async readyDependentsOf(
    graphId: string,
    ofTaskId: string,
    currentGraph: TaskGraph | null,
    newlyReady: string[],
  ): Promise<void> {
    const dependents = await this.redis.smembers(`graph:${graphId}:rdeps:${ofTaskId}`);
    for (const depId of dependents) {
      if (!(await this.depsReadyAndMerged(graphId, depId))) continue;
      const task = await this.getTask(graphId, depId);
      if (task && task.status === "pending") {
        // Acquire dispatch lock to prevent duplicate dispatch
        const lockKey = `graph:${graphId}:lock:${depId}`;
        const acquired = await this.redis.set(lockKey, "1", "EX", 60, "NX");
        if (!acquired) continue; // Another handler already claimed this task

        if (task.requireApproval) {
          await this.updateTaskStatus(graphId, depId, "awaiting_approval");
          await this.emitEvent({ type: "task_approval_required", graphId, taskId: depId, timestamp: Date.now() }, currentGraph);
        } else {
          newlyReady.push(depId);
          await this.updateTaskStatus(graphId, depId, "ready");
          await this.emitEvent({ type: "task_ready", graphId, taskId: depId, timestamp: Date.now() }, currentGraph);
        }
      }
    }
  }

  private async dispatchReadyTasks(graphId: string, taskIds: string[], cachedTasks?: TaskNode[], opts?: { authoritative?: boolean }): Promise<void> {
    // Ownership check: skip dispatch if another active session owns this graph.
    // If unclaimed or owned by us, claim/renew. This makes dispatch safe to call
    // from any context without requiring callers to explicitly claim first.
    //
    // `authoritative` dispatch (driven by a worker completion/failure) bypasses the
    // foreign-owner skip and claims ownership atomically here, immediately before
    // the dispatch loop. This is required for issue #178: in k8s-dispatch mode the
    // completion-processing engine differs from the declaring/monitoring owner, and
    // the monitor renews its lease every 30s (await_graph_event) — so claiming any
    // earlier (e.g. at onTaskCompleted entry, before a multi-second pod-mode merge)
    // lets the renewal overwrite ownership before we reach this point and the
    // dependent task is starved. Claiming here, with no await before the dispatch
    // loop, closes that window.
    if (this.sessionId) {
      const ownerKey = `graph:${graphId}:orchestrator`;
      if (!opts?.authoritative) {
        const owner = await this.redis.get(ownerKey);
        if (owner && owner !== this.sessionId) {
          void this.emitEvent({ type: "task_stale", graphId, timestamp: Date.now(), detail: `dispatch skipped: graph owned by ${owner}, not ${this.sessionId}` });
          return;
        }
      }
      // Claim or renew lease (authoritative dispatch takes over a foreign lease).
      await this.redis.set(ownerKey, this.sessionId, "EX", 120);
    }

    const graph = await this.getGraph(graphId);
    if (!graph) return;
    let toDispatch = [...taskIds];

    if (graph.maxConcurrency) {
      const allTasks = cachedTasks ?? await this.getAllTasks(graphId);
      const runningCount = allTasks.filter((t) => t.status === "running").length;
      const available = graph.maxConcurrency - runningCount;
      if (available <= 0) return;
      toDispatch = toDispatch.slice(0, available);
    }

    // Memory-aware throttling. Disable via BUREAU_DISABLE_MEM_THROTTLE=1
    // (used by the test suite and by users on memory-constrained hosts).
    const freeGB = freemem() / (1024 ** 3);
    if (process.env.BUREAU_DISABLE_MEM_THROTTLE !== '1' && freeGB < 2.0) {
      await this.emitEvent({
        type: 'task_stale', graphId,
        timestamp: Date.now(),
        detail: `Dispatch throttled: ${freeGB.toFixed(1)}GB free (min 2.0GB). ${toDispatch.length} tasks waiting.`,
      }, graph);
      try { onDispatchThrottled({ reason: 'memory_pressure' }); } catch { /* swallow */ }
      return;
    }

    // Emit graph_started on the first task dispatch for this graph (fire-once via Redis NX flag).
    const startedFlagKey = `graph:${graphId}:started_flag`;
    const isFirstDispatch = await this.redis.set(startedFlagKey, '1', 'EX', TTL, 'NX');
    if (isFirstDispatch) {
      await this.emitEvent({
        type: 'graph_started',
        graphId,
        timestamp: Date.now(),
        project: graph.project,
        parentGraphId: graph.parentGraphId,
      }, graph);
    }

    for (const taskId of toDispatch) {
      const task = await this.getTask(graphId, taskId);
      if (!task) continue;

      // Prepare a git worktree for isolated tasks
      let dispatchTask = { ...task, status: "running" as TaskStatus, startedAt: Date.now() };

      await this.updateTaskStatus(graphId, taskId, "running", { startedAt: Date.now() });
      await this.emitEvent({ type: "task_started", graphId, taskId, timestamp: Date.now() }, graph);
      await this.callbacks.onDispatch(graphId, dispatchTask);
    }
  }

  private async cascadeCancel(graphId: string, failedTaskId: string): Promise<void> {
    const queue = [failedTaskId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = await this.redis.smembers(`graph:${graphId}:rdeps:${current}`);
      for (const depId of dependents) {
        if (visited.has(depId)) continue;
        visited.add(depId);
        const task = await this.getTask(graphId, depId);
        if (task && task.status !== "completed" && task.status !== "running") {
          await this.updateTaskStatus(graphId, depId, "canceled");
          queue.push(depId);
        }
      }
    }
  }

  /**
   * Pod-mode (k8s): promote the per-graph integration branch into the destination
   * base ref. Returns true when there is nothing to promote (no remote-merge hooks
   * wired, or no pod-mode tasks) OR the promote succeeds (ff/merge/noop/deferred).
   * Returns false when the promote fails loudly (error/transient/conflict): in that
   * case the graph is marked `failed`, graph_failed is emitted, and the parent graph
   * (if any) is notified — exactly as the inline completion path did before this was
   * extracted. Callers must NOT advance the graph (to completed/validated) on false.
   */
  private async promoteIntegrationIfPod(
    graphId: string,
    graph: TaskGraph | null,
    tasks: TaskNode[],
  ): Promise<boolean> {
    if (!this.remoteMerge) return true;
    // #317 phase3 [C1]: a rework-fix child has NOTHING of its own to promote — its fix
    // commit already merged into the PARENT's integration branch (see the redirect at
    // onTaskCompleted). Promoting here would push the parent's UN-REVALIDATED integration
    // branch to the destination baseRef — the exact un-gated promote this phase exists to
    // prevent. The ONLY main-writer is the parent's guarded validated-resolution
    // (resumeReworkRound STEP 3, after the re-validation gate passes). Treat as success:
    // no promote, no event, so the fix child completes cleanly and drives the parent.
    if (graph?.isReworkFixChild) return true;
    // Exec-mode pods run a command directly — no git work, no integration branch to promote.
    const anyPod = tasks.some(t => t.podMode && !t.execMode);
    if (!anyPod) return true;

    const promoteStart = Date.now();
    let promoteSucceeded = false;
    let promoteDetail: string | undefined;
    try {
      const out = await this.remoteMerge.promoteIntegration(graphId, graph?.destination);
      // ff/merge/noop are true promotions; "deferred" is a pr-only destination
      // intentionally NOT promoting the base ref (work delivered on the integration
      // branch, awaiting a PR/human gate) — also a success. error/transient/conflict fail loudly.
      if (out.strategy === "ff" || out.strategy === "merge" || out.strategy === "noop" || out.strategy === "deferred") {
        promoteSucceeded = true;
        // "__integration__" is a synthetic taskId — graph-scoped merge event, no real task row.
        const mergedDetail = out.strategy === "deferred"
          ? JSON.stringify({ mode: "pod", promote: false, branch: out.conflictBranch })
          : JSON.stringify({ mode: "pod", promote: true, strategy: out.strategy });
        await this.emitEvent({ type: "worktree_merged", graphId, taskId: "__integration__",
          timestamp: Date.now(), detail: mergedDetail });
        try { onWorktreeMergeCompleted({ graphId, project: graph?.project ?? "", taskId: "__integration__", status: 'success', durationMs: Date.now() - promoteStart }); } catch { /* swallow */ }
      } else {
        promoteDetail = JSON.stringify({ mode: "pod", reason: "promote_failed", strategy: out.strategy, output: out.output });
      }
    } catch (err) {
      promoteDetail = JSON.stringify({ mode: "pod", reason: "promote_failed", output: String(err) });
    }
    if (!promoteSucceeded) {
      // Fail loudly: do NOT report the graph as completed/validated with unpromoted work.
      // "__integration__" is a synthetic taskId — graph-scoped merge event, no real task row.
      await this.emitEvent({ type: "worktree_merge_failed", graphId, taskId: "__integration__",
        timestamp: Date.now(), detail: promoteDetail });
      try { onWorktreeMergeCompleted({ graphId, project: graph?.project ?? "", taskId: "__integration__", status: 'failed', durationMs: Date.now() - promoteStart }); } catch { /* swallow */ }
      await this.updateGraphStatus(graphId, "failed");
      await this.emitEvent({ type: "graph_failed", graphId, timestamp: Date.now(),
        detail: JSON.stringify({ reason: "promote_integration_failed" }) });
      const failedGraph = await this.getGraph(graphId);
      if (failedGraph?.parentGraphId) {
        await this.emitEvent({ type: "child_graph_completed", graphId: failedGraph.parentGraphId,
          timestamp: Date.now(), detail: graphId, childGraphId: graphId });
        await this.checkGraphCompletion(failedGraph.parentGraphId);
      }
      return false;
    }
    return true;
  }

  /** Graph statuses that are terminal for completion purposes — once a graph is
   *  here, checkGraphCompletion must be a no-op. NOTE: "validating" is NOT terminal
   *  (a criterion child completing must re-enter to resolve it → validated). */
  private static readonly TERMINAL_GRAPH_STATUSES: ReadonlySet<string> = new Set([
    "completed", "validated", "validation_failed", "failed", "merged", "canceled",
  ]);

  /**
   * Serializes the validated→promote resolution of a single graph/attempt so two
   * concurrent checkGraphCompletion invocations (e.g. two exec-criteria validation
   * children finishing in the same tick) cannot both pass the non-atomic
   * TERMINAL_GRAPH_STATUSES/"validating" read and both promote (Safety-4, #317).
   *
   * SET-NX claim-and-forget: the winner never releases the key. The lock must cover
   * the ENTIRE resolution through promoteIntegrationIfPod — releasing right after the
   * status write (and before promote) would reopen the race for the promote call
   * itself. TTL is a self-healing horizon only, not a release mechanism.
   *
   * `attempt` comes from `graph.currentRound?.attempt ?? 0` — always 0 today
   * (currentRound is not yet set by any code path); the auto-rework loop (#317
   * phase 3) will populate it per round so each rework attempt gets its own claim.
   */
  private async tryClaimResolution(graphId: string, attempt: number): Promise<boolean> {
    const claimed = await this.redis.set(
      `completionlock:${graphId}:${attempt}`,
      this.sessionId || "unknown",
      "EX", 300, "NX",
    );
    return claimed === "OK";
  }

  /**
   * PUBLIC (Task 7, hand-off f): a `validating` graph whose completion-lock holder
   * crashed mid-resolve after all its validation children went terminal has no live
   * child left to re-trigger this — the health-sweep calls it directly for supervised
   * `validating` graphs each cycle to re-drive a stranded resolution. Conservative:
   * a healthy graph with live children returns at the "still waiting" branch below, so
   * this is a no-op the vast majority of the time it is called.
   */
  async checkGraphCompletion(graphId: string, cachedTasks?: TaskNode[]): Promise<void> {
    // Idempotency guard (#192): a graph already in a terminal state must not re-run
    // validation/completion logic. Without this, anything that re-invokes
    // checkGraphCompletion on a finished graph — notably a self-improvement analyzer
    // child graph (parentGraphId = this graph) completing and emitting
    // child_graph_completed — re-enters the acceptanceCriteria dispatch and re-emits
    // graph_validated/graph_completed, which re-triggers the analyzer → an unbounded
    // validation/analysis re-entrancy loop.
    const currentGraph = await this.getGraph(graphId);
    if (currentGraph && TaskGraphManager.TERMINAL_GRAPH_STATUSES.has(currentGraph.status)) {
      return;
    }

    // #317 phase3 (Task 6b) — M2 routing. A `reworking` graph is non-terminal, so a
    // fix-child OR re-validation-child completion re-enters here. Route it into the
    // reconciler INSTEAD of the legacy validationLevel/acceptanceCriteria re-dispatch
    // below: the reconciler scans ONLY currentRound.validationChildIds (C1 — never the
    // accumulated childGraphIds), keeps the parent status "reworking" (HIGH-1), and
    // runs the empty-fix/fix-integrity guards. Falling through would re-dispatch the
    // whole gate, bypass the guards, and reintroduce the C1 poison. This branch also
    // shields the exec-gate + config fail sites below from a lock-burn on re-entry
    // (they are never reached while reworking).
    if (currentGraph?.status === "reworking") {
      await this.resumeReworkRound(graphId);
      return;
    }

    const tasks = cachedTasks ?? await this.getAllTasks(graphId);
    if (tasks.length === 0) return;

    const allDone = tasks.every(
      (t) => t.status === "completed" || t.status === "canceled" || t.status === "failed",
    );
    if (!allDone) return;

    // Rework tasks (id starts with "rework-") and auto-added tasks (e.g. merge-*) are
    // best-effort — original tasks already completed, so their failure is non-fatal.
    const fatalFailures = tasks.filter(
      (t) => t.status === "failed" && !t.id.startsWith("rework-") && !t.autoAdded,
    );
    if (fatalFailures.length > 0) {
      // #317 phase3 hop 2a: surface the failed task's reason (e.g. "test_failure",
      // "exec_verdict_lost") onto this graph's own record. Most exec/criterion
      // child graphs carry exactly one task, so the first fatal failure's reason
      // wins when several are present.
      const failureReason = fatalFailures.find((t) => t.failureReason)?.failureReason;
      await this.updateGraphStatus(graphId, "failed", undefined, failureReason);
      await this.emitEvent({
        type: "graph_failed", graphId, timestamp: Date.now(),
        detail: `Fatal failures: ${fatalFailures.map((t) => t.id).join(", ")}`,
      });
      return;
    }

    let graph = await this.getGraph(graphId);

    // Gate: don't spawn acceptance criteria until all worktree/pod-mode merges have completed.
    // Covers pod-mode (k8s) graphs — every worker pushes a branch merged remotely.
    // pending_merges is kept populated on error/transient outcomes so a failed merge
    // cannot silently advance the graph to completed.
    const hasPodMergeTasks = tasks.some(t => t.podMode && !t.id.startsWith("merge-"));
    if (hasPodMergeTasks) {
      const pendingCount = await this.redis.scard(`graph:${graphId}:pending_merges`);
      if (pendingCount > 0) return; // merges still in flight or failed
    }

    // If graph is validating, check whether the validation child graph finished
    if (graph?.status === "validating") {
      if (graph.childGraphIds?.length) {
        for (const childId of graph.childGraphIds) {
          const child = await this.getGraph(childId);
          if (child && !["completed", "validated", "failed", "merged", "validation_failed"].includes(child.status)) {
            return; // still waiting on a child
          }
        }
        // All children done — check if any validation child failed
        let allPassed = true;
        let failedChildId: string | undefined;
        // #317 phase3 hop 2b: the failed child's OWN failureReason (already landed on
        // its graph record via hop 2a/3) — this is the exec-gate area the trigger
        // discriminator (a later task) reads via getGraph(childId) on THIS graph.
        let failedChildReason: string | undefined;
        for (const childId of graph.childGraphIds) {
          const child = await this.getGraph(childId);
          if (child?.status === "failed" || child?.status === "validation_failed") {
            allPassed = false;
            failedChildId = childId;
            failedChildReason = child.failureReason;
            break;
          }
        }
        if (allPassed) {
          // Serialize the validated→promote resolution: two exec-criteria children
          // finishing in the same tick must not both pass this point (#317 Safety-4).
          // Claim BEFORE emitting telemetry — a losing concurrent racer must not
          // emit a duplicate 'pass' event for a round it didn't win (pre-merge
          // sweep item 1; mirrors the fail branch below, which already claims
          // first per Task 6a).
          if (!(await this.tryClaimResolution(graphId, graph?.currentRound?.attempt ?? 0))) return;
          // #325 — first-pass SHA-pin guard: refuse terminally if the live
          // integration HEAD no longer matches the SHA captured when the FIRST
          // validation child was dispatched (mirrors checkHeadPinForPromote for
          // rework re-validation). No-op (ok:true) when no pin was ever
          // captured (no gate, or no remote-merge hooks wired).
          const firstPassPin = await this.checkValidationDispatchPin(graphId, graph);
          if (!firstPassPin.ok) {
            logger.warn(`[sha-pin] graph ${graphId}: refused first-pass promote — ${firstPassPin.reason}`);
            const pinFailure = buildValidationFailure(graphId, graph?.validationLevel, [
              { name: "integration-head-pin", type: "assertion", result: firstPassPin.reason },
            ]);
            await this.updateGraphStatus(graphId, "validation_failed", pinFailure, this.pinFailureReason(firstPassPin.reason));
            await this.emitEvent({ type: "graph_validation_failed", graphId, timestamp: Date.now() });
            return;
          }
          if (graph?.validationLevel) {
            try { onValidationResult({ graphId, level: graph.validationLevel, result: 'pass' }); } catch { /* fault isolation */ }
          }
          await this.updateGraphStatus(graphId, "validated");
          await this.emitEvent({ type: "graph_validated", graphId, timestamp: Date.now() });
          // Pod-mode: promote the integration branch now that validation passed.
          // (Helper marks the graph failed + notifies the parent on promote failure.)
          await this.promoteIntegrationIfPod(graphId, graph, tasks);
        } else {
          // #317 phase3 (Task 6a fix, H6) — serialize the ENTIRE fail resolution
          // behind the SAME per-graph/attempt completion lock the pass branch
          // uses (tryClaimResolution, key completionlock:<g>:<attempt>). Pass and
          // fail are mutually-exclusive outcomes of ONE round — child terminal
          // states are monotonic — so exactly one resolution (pass OR fail) may
          // ever win a given graph+attempt. Without this, two concurrent
          // checkGraphCompletion drives both reach maybeStartRework below: the
          // `reworkclaim` SET-NX loser returns false and its caller runs full
          // Phase-2 terminal teardown (recordValidationFailure drops `:files`,
          // emits graph_validation_failed) while the winner is still parked in
          // getIntegrationHead, then overwrites the status to `reworking` — a
          // reworking graph with a torn-down workspace (the H6 violation this
          // feature must never produce). The loser now returns having done
          // NOTHING (no teardown, no event, no maybeStartRework); the winner
          // alone decides rework-vs-terminal.
          //
          // Crash story (acceptable): a winner that dies mid-resolution leaves
          // the graph `validating`; the 300s lock TTL is a self-healing horizon
          // so Task 7's sweep/reaper re-drives after expiry. Loser-returns is the
          // same semantics the pass branch has had since the C4 completion lock.
          if (!(await this.tryClaimResolution(graphId, graph?.currentRound?.attempt ?? 0))) return;
          if (graph?.validationLevel) {
            try { onValidationResult({ graphId, level: graph.validationLevel, result: 'fail', failedCount: 1 }); } catch { /* fault isolation */ }
          }
          // #306: surface the failed validation pod's log tail (e.g. the checker's
          // "uncovered: [E-03, E-07]") as the failure detail. Best-effort, k8s-only
          // (reader wired at the composition root); MUST never throw into completion.
          // Read BEFORE the status update so the log tail can seed the recorded
          // ValidationFailure (workspace-awareness), not just the emitted event.
          let detail: string | undefined;
          if (this.callbacks.readValidationPodLog && failedChildId) {
            try { detail = await this.callbacks.readValidationPodLog(failedChildId); }
            catch { /* best-effort: never throw into completion */ }
          }
          // #317 phase3 (Task 8) — recover the REAL criterion name (not a synthetic
          // placeholder) so the fix-integrity guard's structured tier can match this
          // failure back to a coverage-gated criterion by name. Best-effort: falls
          // back to "validation-gate" when unresolvable (single-task-per-child
          // invariant is dispatchExecValidationChildren's; a broken assumption here
          // must never throw into completion).
          const criterionName = (failedChildId && await this.resolveFailedCriterionName(failedChildId)) || "validation-gate";
          const failure = buildValidationFailure(graphId, graph?.validationLevel, [
            { name: criterionName, type: "exec", result: detail ?? "validation pod failed (no log captured)" },
          ]);
          // #317 phase3 (Task 6a) — teardown-deferral interception for the EXEC
          // MECHANICAL GATE (the primary auto-rework target). This site resolves
          // the failure DIRECTLY via updateGraphStatus (it does NOT pass through
          // markValidationFailed), so the deferral MUST be here or auto-rework is
          // silently disabled on the exec gate. An eligible+fixable failure takes
          // over → reworking (no teardown); otherwise fall through to terminal.
          if (await this.maybeStartRework(graphId, failure, failedChildReason)) return;
          await this.updateGraphStatus(graphId, "validation_failed", failure, failedChildReason);
          await this.emitEvent({
            type: "graph_validation_failed", graphId, timestamp: Date.now(),
            ...(detail ? { detail } : {}),
          });
        }
      }
      return;
    }

    // Unit validation gate: synthesize an exec criterion from the aggregated test command
    // when validationLevel === 'unit' and no explicit exec criteria are defined.
    // The synthetic criterion is added to the local graph copy only (not persisted to Redis);
    // the existing exec dispatch path below handles it identically to an explicit criterion.
    if (graph?.validationLevel === 'unit' && graph.validationTestCmd) {
      const hasExplicitExec = graph.acceptanceCriteria?.some(c => c.type === 'exec') ?? false;
      if (!hasExplicitExec) {
        try { onValidationDispatched({ graphId, level: 'unit', testCmd: graph.validationTestCmd }); } catch { /* fault isolation */ }
        // onFail:'fail' marks the parent graph validation_failed when the test pod exits
        // non-zero. Fix-on-red for async exec child graphs is dispatched via a separate
        // fix-dispatcher mechanism (2g scope), not through the onFail field.
        // Prepend the install command so the fresh-clone validation pod is buildable before the
        // suite runs. Empty/absent install → check is exactly the test command (the Node path).
        // #324 belt-and-braces: dry-run/declare warn authors about this, but older clients may
        // have declared the graph before that lint existed — log here too.
        if (!graph.validationInstallCmd) {
          logger.warn({ graphId, level: 'unit' }, "[gate-no-install] synthesizing unit validation gate with no install command — the fresh-clone pod will run the bare test command");
        }
        const unitToolchain = graph.validationToolchain ?? graph.defaultToolchain;
        const unitCriterion: CriterionDef = {
          name: 'unit-validation',
          type: 'exec',
          check: [graph.validationInstallCmd, graph.validationTestCmd].filter(Boolean).join(' && '),
          onFail: 'fail',
          // Boot the validation pod on the graph's toolchain image (e.g. python → uv/pytest),
          // not the default node image. Absent → node default (the dogfood path, unchanged).
          ...(unitToolchain ? { inputs: { toolchain: unitToolchain } } : {}),
        };
        graph = {
          ...graph,
          acceptanceCriteria: [...(graph.acceptanceCriteria ?? []), unitCriterion],
        };
      }
    }

    // Integration validation gate: synthesize an exec criterion from the aggregated integration-test
    // command when validationLevel === 'integration' and no explicit exec criteria are defined.
    // Engine-side service leasing happens in graph-dispatch.ts when the exec child task is dispatched
    // (TestServiceManager, identified by parentGraph.validationLevel === 'integration').
    //
    // #312: fall back to the aggregated unit `test` command when no dedicated `integrationTest`
    // was declared. The declare-time no-test guard only requires `task.test`, so an integration
    // graph frequently carries `validationTestCmd` but not `validationIntegrationTestCmd`; without
    // this fallback the gate was silently skipped and the work promoted ungated.
    const integrationCmd = graph?.validationIntegrationTestCmd ?? graph?.validationTestCmd;
    if (graph?.validationLevel === 'integration' && integrationCmd) {
      const hasExplicitExec = graph.acceptanceCriteria?.some(c => c.type === 'exec') ?? false;
      if (!hasExplicitExec) {
        try { onValidationDispatched({ graphId, level: 'integration', testCmd: integrationCmd }); } catch { /* fault isolation */ }
        // Prepend the install command (same rationale as the unit gate above).
        const integrationToolchain = graph.validationToolchain ?? graph.defaultToolchain;
        // Fail-fast preflight: if a leased test service is unreachable (e.g. NetworkPolicy
        // egress gap, #268), bound the wait so the gate fails in seconds instead of hanging
        // on an infinite client reconnect until task timeout. No-op once the service is up.
        const preflight = buildIntegrationPreflight(graph.testServices);
        const baseCheck = [graph.validationInstallCmd, integrationCmd].filter(Boolean).join(' && ');
        const integrationCriterion: CriterionDef = {
          name: 'integration-validation',
          type: 'exec',
          check: preflight ? `${preflight} && ${baseCheck}` : baseCheck,
          onFail: 'fail',
          ...(integrationToolchain ? { inputs: { toolchain: integrationToolchain } } : {}),
        };
        graph = {
          ...graph,
          acceptanceCriteria: [...(graph.acceptanceCriteria ?? []), integrationCriterion],
        };
      }
    }

    // #312 belt-and-suspenders: a graph that declared a mechanical validation level
    // (unit/integration) but resolved NO runnable gate — no synthesized criterion above
    // and no explicit exec criterion — must NOT promote silently as if validation passed.
    // Fail loud instead, mirroring the pod-merge "never silently complete" invariant.
    // ('self' is agent-based and legitimately has no mechanical gate, so it is excluded.)
    if (graph?.validationLevel === 'unit' || graph?.validationLevel === 'integration') {
      const hasExecGate = graph.acceptanceCriteria?.some(c => c.type === 'exec') ?? false;
      if (!hasExecGate) {
        try { onValidationNoTestCommand({ graphId, level: graph.validationLevel, taskId: '__validation__' }); } catch { /* fault isolation */ }
        // #317 phase3 (Task 6a): hooked for uniformity — a config failure
        // (no runnable command) has no fixable reason, so maybeStartRework
        // returns false here and this falls through to terminal, as intended.
        // Serialize like the pass/fail resolutions above behind the same
        // completion lock (tryClaimResolution) so two concurrent drives cannot
        // both tear down + double-emit (H6 / double-teardown).
        if (!(await this.tryClaimResolution(graphId, graph?.currentRound?.attempt ?? 0))) return;
        if (await this.maybeStartRework(graphId)) return;
        await this.updateGraphStatus(graphId, "validation_failed");
        await this.emitEvent({
          type: "graph_validation_failed", graphId, timestamp: Date.now(),
          detail: JSON.stringify({ reason: "validation_no_runnable_command", level: graph.validationLevel }),
        });
        return;
      }
    }

    // Evaluate acceptance criteria if present
    if (graph?.acceptanceCriteria?.length) {
      await this.updateGraphStatus(graphId, "validating");
      await this.emitEvent({ type: "graph_validating", graphId, timestamp: Date.now() });

      // Split criteria: command/script/assertion run inline, agent/exec-type dispatches as child graph
      const inlineCriteria = graph.acceptanceCriteria.filter((c) => c.type !== "agent" && c.type !== "exec");
      const agentCriteria = graph.acceptanceCriteria.filter((c) => c.type === "agent");
      const execCriteria = graph.acceptanceCriteria.filter((c) => c.type === "exec");

      // Run inline criteria directly via CriterionEngine
      let inlineAllPassed = true;
      // Hoisted to outer scope: the failed inline results are captured inside the
      // block below but consumed at the record sites AFTER the block closes.
      let inlineFailed: CriterionResult[] = [];
      if (inlineCriteria.length > 0) {
        const { CriterionEngine } = await import("./criterion-engine.js");
        // Under k8s/pod dispatch the engine runs in-cluster and graph.cwd is an
        // orchestrator-side path that does not exist in the engine pod. Skip
        // command/script criteria in that case so a missing cwd cannot spuriously
        // block promote (see issue #174). Workers always run in-cluster (k8s).
        //
        // When a remote merge is configured, prefer the engine-side merge clone
        // directory (where worker branches are integrated) over graph.cwd — the
        // latter is the orchestrator's local path and may be inaccessible in the
        // engine pod, or may point to the wrong location (e.g. /workspace in a
        // k8s orchestrator pod rather than the merged clone at
        // /workspace/bureau-merge/<dest>). Issue #225.
        const criterionCwd = this.remoteMerge?.getCloneDir(graph.destination) ?? graph.cwd;
        const engine = new CriterionEngine({
          cwd: criterionCwd,
          graphId,
          skipCommandsIfCwdInaccessible: true,
          onDispatch: async (role: string, prompt: string) => {
            await this.declareGraph(
              graph.project,
              graph.cwd,
              [{ id: `fix-${Date.now()}`, role, task: prompt }],
              { parentGraphId: graphId },
            );
            return { passed: true, evidence: `Fix agent dispatched: ${role}` };
          },
          onFixStarted: (criterion, fixRole) => {
            const criterionTaskId = `criterion-${criterion.name}`;
            // Fire-and-forget: emitEvent is async; must not block evaluateAll
            void this.emitEvent({
              type: "criterion_fix_started",
              graphId,
              taskId: criterionTaskId,
              timestamp: Date.now(),
              detail: `fix agent: ${fixRole}`,
            }).catch(() => { /* fault isolation */ });
            try { onCriterionFixStarted({ criterionName: criterion.name, fixRole }); } catch { /* fault isolation */ }
          },
        });
        const results = await engine.evaluateAll(inlineCriteria);
        // 'skipped' is treated as passing — a skipped criterion does not block promote.
        // This covers command/script criteria that were skipped because graph.cwd is
        // not accessible on the engine host under k8s/pod dispatch (#174).
        inlineAllPassed = results.every((r) => r.status === "passed" || r.status === "skipped");
        // Capture the failed subset for the record sites below. 'skipped' counts
        // as passing (matches inlineAllPassed above), so it is excluded here.
        inlineFailed = results.filter((r) => r.status !== "passed" && r.status !== "skipped");

        // Emit per-criterion lifecycle events and telemetry.
        // criterion_passed / criterion_failed / criterion_skipped are emitted ALONGSIDE
        // the generic task_completed / task_failed (dashboard compatibility requires both).
        for (const r of results) {
          const criterionTaskId = `criterion-${r.name}`;
          const detail = r.evidence || r.diagnostic || undefined;

          // Generic events (dashboard depends on these — do NOT remove).
          // Skipped criteria map to task_completed so they do not appear as failures.
          await this.emitEvent({
            type: (r.status === "passed" || r.status === "skipped") ? "task_completed" : "task_failed",
            graphId,
            taskId: criterionTaskId,
            timestamp: Date.now(),
            detail,
          });

          // Criterion-specific lifecycle events
          const criterionEventType =
            r.status === "passed"  ? "criterion_passed"  :
            r.status === "skipped" ? "criterion_skipped" :
            "criterion_failed";
          await this.emitEvent({
            type: criterionEventType,
            graphId,
            taskId: criterionTaskId,
            timestamp: Date.now(),
            detail,
          });

          // OTel metrics
          try {
            onCriterionEvaluated({
              graphId,
              taskId: criterionTaskId,
              criterionName: r.name,
              criterionType: r.type,
              status: r.status,
              durationMs: r.durationMs,
              attempt: r.attempt,
            });
          } catch { /* fault isolation — telemetry must never throw into the eval path */ }
        }
      }

      // Dispatch agent-type criteria as a child graph (they need a Claude session).
      // Agent criteria surface pass/fail via child-graph completion, not criterion_* events.
      // Mixing agent + exec criteria in the same graph is rejected at declare_task_graph time.
      if (agentCriteria.length > 0) {
        const validationTasks: TaskNodeInput[] = agentCriteria.map((criterion) => ({
          id: `criterion-${criterion.name}`,
          // Evaluation default (verdict only, no fix/commit); distinct from DEFAULT_FIX_ROLE
          role: criterion.fixRole || DEFAULT_AGENT_CRITERION_ROLE,
          task: criterion.check,
          maxRetries: criterion.maxRetries ?? (criterion.onFail === "retry" ? 1 : 0),
        }));

        // #325 — capture the integration-branch HEAD at the moment this FIRST
        // validation child is dispatched (retry-once; see captureIntegrationHeadForPin).
        // Persisted below so a restart between dispatch and promote does not lose it.
        const firstPassHead = await captureIntegrationHeadForPin(this.remoteMerge, graphId, graph.destination);
        await this.declareGraph(
          graph.project,
          graph.cwd,
          validationTasks,
          // Inherit the parent's repo + toolchain so the validation pod clones the SAME
          // repo the work merged into (a non-default destination's integration branch
          // doesn't exist on the default repo) and boots the right image.
          { parentGraphId: graphId, destination: graph.destination, defaultToolchain: graph.defaultToolchain },
        );
        await this.persistValidationDispatchHead(graphId, firstPassHead);
        // If inline criteria already failed, mark validation_failed now
        if (!inlineAllPassed) {
          const failure = buildValidationFailure(graphId, graph?.validationLevel,
            inlineFailed.map((r) => ({ name: r.name, type: r.type, result: r.diagnostic ?? r.evidence ?? "", ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}) })));
          await this.markValidationFailed(graphId, failure);
        }
        return;
      }

      // Dispatch exec criteria as child graphs pinned to the integration ref.
      // Each exec criterion spawns a mechanical validation pod that clones the
      // integration branch (merged candidate) rather than base — ensuring the pod
      // validates the actual combined diff, not the pre-merge state.
      if (execCriteria.length > 0) {
        // #325 — capture the integration-branch HEAD at the moment this FIRST
        // validation child is dispatched (retry-once). Read BEFORE dispatch so it
        // reflects the exact pre-dispatch state, mirroring STEP-2's revalidationHead
        // capture in resumeReworkRound.
        const firstPassHead = await captureIntegrationHeadForPin(this.remoteMerge, graphId, graph.destination);
        // Dispatch each exec criterion as a child graph pinned to the integration
        // branch (shared with the rework reconciler's re-validation — one dispatch
        // helper, so the initial gate and the re-validation gate cannot diverge).
        await this.dispatchExecValidationChildren(graphId, graph, execCriteria);
        await this.persistValidationDispatchHead(graphId, firstPassHead);
        if (!inlineAllPassed) {
          const failure = buildValidationFailure(graphId, graph?.validationLevel,
            inlineFailed.map((r) => ({ name: r.name, type: r.type, result: r.diagnostic ?? r.evidence ?? "", ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}) })));
          await this.markValidationFailed(graphId, failure);
        }
        return;
      }

      // No agent or exec criteria — resolve based on inline results alone
      if (inlineAllPassed) {
        // Serialize the validated→promote resolution (#317 Safety-4) — see tryClaimResolution.
        if (!(await this.tryClaimResolution(graphId, graph?.currentRound?.attempt ?? 0))) return;
        // #325 — same first-pass SHA-pin guard as the exec/agent-gate resolution
        // above. This path never dispatches a validation child (inline-only
        // criteria), so validationDispatchHead is never set here and the guard
        // is always a no-op — kept for defense-in-depth/symmetry.
        const firstPassPin = await this.checkValidationDispatchPin(graphId, graph);
        if (!firstPassPin.ok) {
          logger.warn(`[sha-pin] graph ${graphId}: refused first-pass promote — ${firstPassPin.reason}`);
          const pinFailure = buildValidationFailure(graphId, graph?.validationLevel, [
            { name: "integration-head-pin", type: "assertion", result: firstPassPin.reason },
          ]);
          await this.updateGraphStatus(graphId, "validation_failed", pinFailure, this.pinFailureReason(firstPassPin.reason));
          await this.emitEvent({ type: "graph_validation_failed", graphId, timestamp: Date.now() });
          return;
        }
        await this.updateGraphStatus(graphId, "validated");
        await this.emitEvent({ type: "graph_validated", graphId, timestamp: Date.now() });
        // Pod-mode: promote the integration branch now that validation passed.
        // (Helper marks the graph failed + notifies the parent on promote failure.)
        await this.promoteIntegrationIfPod(graphId, graph, tasks);
      } else {
        const failure = buildValidationFailure(graphId, graph?.validationLevel,
          inlineFailed.map((r) => ({ name: r.name, type: r.type, result: r.diagnostic ?? r.evidence ?? "", ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}) })));
        await this.markValidationFailed(graphId, failure);
      }
      return;
    }

    // Don't complete parent until all child graphs have also finished
    if (graph?.childGraphIds?.length) {
      const terminalStatuses = ["completed", "validated", "failed", "merged", "validation_failed"] as const;
      for (const childId of graph.childGraphIds) {
        const childGraph = await this.getGraph(childId);
        if (childGraph && !(terminalStatuses as readonly string[]).includes(childGraph.status)) {
          await this.emitEvent({
            type: "graph_awaiting_children",
            graphId,
            timestamp: Date.now(),
            detail: `Waiting for child graph ${childId}`,
          });
          return;
        }
      }
    }

    // Serialize the completion→promote resolution (#317 Safety-4) — see tryClaimResolution.
    if (!(await this.tryClaimResolution(graphId, graph?.currentRound?.attempt ?? 0))) return;

    // Pod-mode: promote the per-graph integration branch into the base ref.
    // On promote failure the helper marks the graph failed + notifies the parent,
    // so we stop here rather than reporting the graph as completed.
    if (!(await this.promoteIntegrationIfPod(graphId, graph, tasks))) return;

    await this.updateGraphStatus(graphId, "completed");
    await this.emitEvent({ type: "graph_completed", graphId, timestamp: Date.now() });

    // Fire-and-forget: D4 cache.ttl_expired_thrash anomaly detection
    void (async () => {
      try {
        const taskRows = await Promise.all(
          tasks
            .filter(t => t.status === "completed")
            .map(async t => {
              const raw = await this.redis.get(`telemetry:${graphId}:${t.id}`);
              if (!raw) return null;
              const tel = JSON.parse(raw) as {
                cacheReadInputTokens?: number;
                cacheCreationInputTokens?: number;
                model?: string;
              };
              return {
                role: t.role,
                startedAtMs: t.startedAt ?? 0,
                cacheRead: tel.cacheReadInputTokens ?? 0,
                cacheCreate: tel.cacheCreationInputTokens ?? 0,
                writeTokens: tel.cacheCreationInputTokens ?? 0,
                model: tel.model ?? "",
              };
            }),
        );
        const completedTasks = taskRows.filter((r): r is NonNullable<typeof r> => r !== null);
        void getCacheAnomalyDetector()?.observeGraphCompleted(graphId, completedTasks).catch(() => {});
      } catch {
        // detector errors must never block graph completion
      }
    })();

    // Fire-and-forget: lifecycle absence-detection anomaly detector.
    // Checks that every completed task called set_handoff and set_status.
    void (() => {
      try {
        const completedForLifecycle = tasks
          .filter(t => t.status === "completed")
          .map(t => ({ taskId: t.id, role: t.role }));
        getLifecycleAnomalyDetector()?.observeGraphTerminated(graphId, completedForLifecycle);
      } catch {
        // detector errors must never block graph completion
      }
    })();

    // Notify parent graph that this child completed
    const completedGraph = await this.getGraph(graphId);
    if (completedGraph?.parentGraphId) {
      await this.emitEvent({
        type: "child_graph_completed",
        graphId: completedGraph.parentGraphId,
        timestamp: Date.now(),
        detail: graphId,
        childGraphId: graphId,
      });
      // Re-evaluate parent — its own tasks may already be done and only needed us to finish
      await this.checkGraphCompletion(completedGraph.parentGraphId);
    }
  }

  /**
   * Reset a task's execution state in preparation for a retry. Shared by the
   * manual `retryTask` MCP tool and the automatic retry path in `onTaskFailed`.
   *
   * @param newRetries - The retries value to store (0 for manual retry, task.retries+1 for auto).
   * @param resetDependents - When true, walk forward through rdeps and reset canceled tasks
   *   whose all dependencies are now completed or pending.
   * @returns IDs of dependent tasks that were reset.
   */
  /** Record the branch the k8s worker pushed as a WIP checkpoint, for E1 retry-resume. */
  async markCheckpointBranch(graphId: string, taskId: string, branch: string): Promise<void> {
    const task = await this.getTask(graphId, taskId);
    if (!task) return;
    task.checkpointBranch = branch;
    await this.redis.set(`graph:${graphId}:tasks:${taskId}`, JSON.stringify(task), "EX", TTL);
  }

  private async resetTaskForRetry(
    graphId: string,
    taskId: string,
    newRetries: number,
    resetDependents = false,
  ): Promise<string[]> {
    const existingTask = await this.getTask(graphId, taskId);
    const extraFields: Omit<Partial<TaskNode>, "status"> = {
      sessionId: undefined,
      exitCode: undefined,
      startedAt: undefined,
      completedAt: undefined,
      // #317 phase3 review: clear a previous round's failureReason — a fresh retry
      // round has no reason yet, and Object.assign in updateTaskStatus would
      // otherwise leave the prior round's reason on the task node forever.
      failureReason: undefined,
      retries: newRetries,
    };
    // E1: resume from the checkpoint branch the worker pushed on SIGTERM
    if (existingTask?.podMode && existingTask.checkpointBranch) {
      extraFields.gitBaseRef = existingTask.checkpointBranch;
      extraFields.gitBranch = existingTask.checkpointBranch;
    }
    await this.updateTaskStatus(graphId, taskId, "pending", extraFields);

    const resetTasks: string[] = [];

    if (resetDependents) {
      // BFS forward through rdeps, reset canceled dependents whose all deps are completed or pending
      const queue = [taskId];
      const visited = new Set<string>([taskId]);

      while (queue.length > 0) {
        const current = queue.shift()!;
        const dependents = await this.redis.smembers(`graph:${graphId}:rdeps:${current}`);
        for (const depId of dependents) {
          if (visited.has(depId)) continue;
          visited.add(depId);

          const depTask = await this.getTask(graphId, depId);
          if (!depTask || depTask.status !== "canceled") continue;

          // Only reset if all of this task's deps are completed or pending
          const deps = await this.redis.smembers(`graph:${graphId}:deps:${depId}`);
          let allOk = true;
          for (const d of deps) {
            const dTask = await this.getTask(graphId, d);
            if (!dTask || (dTask.status !== "completed" && dTask.status !== "pending")) {
              allOk = false;
              break;
            }
          }

          if (allOk) {
            await this.updateTaskStatus(graphId, depId, "pending", {
              sessionId: undefined,
              exitCode: undefined,
              startedAt: undefined,
              completedAt: undefined,
              // Pre-merge sweep item 2: keep in lockstep with the primary
              // reset literal above — a canceled dependent being reset to
              // pending must not carry forward a stale failureReason, even
              // though today failureReason is only ever written on `failed`
              // (canceled tasks don't set it), so this branch is currently
              // unreachable-in-practice. Kept in sync to close the drift trap.
              failureReason: undefined,
            });
            resetTasks.push(depId);
            queue.push(depId);
          }
        }
      }
    }

    await this.emitEvent({
      type: "task_retried",
      graphId,
      taskId,
      timestamp: Date.now(),
      detail: `Retrying task (attempt ${newRetries + 1}). ${resetTasks.length} dependent(s) reset.`,
    });

    return resetTasks;
  }

  private async updateTaskStatus(
    graphId: string, taskId: string, newStatus: TaskStatus,
    extraFields?: Omit<Partial<TaskNode>, 'status'>,
  ): Promise<void> {
    const task = await this.getTask(graphId, taskId);
    if (!task) return;
    const transitionName = transition(task.status, newStatus, taskId, graphId);
    if (transitionName === undefined) return; // idempotent no-op
    task.status = newStatus;
    if (extraFields) Object.assign(task, extraFields);
    await this.redis.set(`graph:${graphId}:tasks:${taskId}`, JSON.stringify(task), "EX", TTL);
  }

  private async updateTaskFields(graphId: string, taskId: string, fields: Partial<TaskNode>): Promise<void> {
    if (fields.status !== undefined) {
      throw new Error(
        `updateTaskFields called with a status field — use updateTaskStatus instead to enforce transition validation`,
      );
    }
    const task = await this.getTask(graphId, taskId);
    if (!task) return;
    Object.assign(task, fields);
    await this.redis.set(`graph:${graphId}:tasks:${taskId}`, JSON.stringify(task), "EX", TTL);
  }

  private async updateGraphStatus(
    graphId: string, status: GraphStatus, failure?: ValidationFailure, reason?: string,
  ): Promise<void> {
    const graph = await this.getGraph(graphId);
    if (!graph) return;
    graph.status = status;
    // #317 phase3 hop 3: land the failed task's reason on the GRAPH record so the
    // parent's trigger discriminator can read it via getGraph(childId) — no reason
    // means unchanged behavior (existing callers all omit this param).
    if (reason !== undefined) graph.failureReason = reason;
    if (["completed", "failed", "canceled", "verified", "verification_failed"].includes(status)) {
      graph.completedAt = Date.now();
    }
    await this.redis.set(`graph:${graphId}`, JSON.stringify(graph), "EX", TTL);

    // Registry status sync (#235): keep the workspace-awareness view current.
    if (this.graphRegistry) {
      try {
        const dk = this.graphDestKey(graph);
        if (status === "validating") {
          await this.graphRegistry.setStatus(dk, graphId, "validating");
        } else if (status === "reworking") {
          // Non-terminal (#317): keep the graph a live file-holder while its fix
          // child runs, but also surface it via getRecentFailures so peers on the
          // same destination see the in-flight rework as a caution signal.
          await this.graphRegistry.setStatus(dk, graphId, "reworking");
        } else if (status === "validation_failed" && failure) {
          // Retain the failure record (workspace-awareness, Phase 2) instead of
          // tearing the summary down. keepSummary preserves the meta entry so
          // getRecentFailures surfaces it to later peers on the same destination.
          await this.graphRegistry.recordValidationFailure(dk, graphId, failure);
          await this.teardownGraph(graphId, { keepSummary: true });
        } else if (TaskGraphManager.TERMINAL_GRAPH_STATUSES.has(status)) {
          // Mark done first (so concurrent addActualFiles no-ops if it races here),
          // then tear down: deregister + clear workspace keys.
          await this.graphRegistry.setStatus(dk, graphId, "done");
          // Destination-scoped clear on success: a validated/completed graph
          // supersedes prior failures on the same destination. `validated` does
          // not stamp completedAt, so the Date.now() fallback clears all older
          // failures (intended — success wins).
          if (status === "validated" || status === "completed") {
            await this.graphRegistry.clearFailuresOlderThan(dk, graph.completedAt ?? Date.now()).catch(() => {});
          }
          await this.teardownGraph(graphId);
        }
      } catch { /* best-effort registry sync */ }
    }
  }

  /** destKey for a graph derived from its destination and cwd. */
  private graphDestKey(graph: { destination?: string; cwd: string }): string {
    return destKey(graph.destination ?? null, graph.cwd);
  }

  /** Single teardown path: deregister from the registry and clear workspace keys.
   *  Fixes the previously-uncalled WorkspaceLedger/DiscoveryStore.cleanupGraph (#235). */
  private async teardownGraph(graphId: string, opts?: { keepSummary?: boolean }): Promise<void> {
    try {
      const graph = await this.getGraph(graphId);
      // keepSummary retains the registry meta entry (e.g. a recorded validation
      // failure) while still clearing the transient workspace keys below.
      if (graph && this.graphRegistry && !opts?.keepSummary) {
        await this.graphRegistry.deregister(this.graphDestKey(graph), graphId);
      }
      // Clear intent/conflict/discovery keys via the (until now) orphaned cleanups.
      await this.callbacks.cleanupWorkspace?.(graphId);
    } catch { /* best-effort teardown */ }
  }

  /**
   * #317 phase3 (Task 6a) — bounded auto-rework ENTRY.
   *
   * Returns true when it TOOK OVER a validation failure (atomically entered the
   * non-terminal `reworking` state), false to fall through to the normal terminal
   * `validation_failed` path. Safe to call from ANY failure site: the cheap
   * ineligibility checks (reads only) run first, so the false path performs no
   * Redis writes.
   *
   * H6 teardown deferral: an eligible failure transitions STRAIGHT to `reworking`
   * — it never calls recordValidationFailure (which would drop the `:files` set),
   * never runs cleanupWorkspace, and never occupies `validation_failed`. The graph
   * stays a live file-holder (getActiveGraphs still lists it) until the loop
   * ultimately gives up, at which point terminal teardown fires normally (6b).
   *
   * @param graphId the graph whose validation just failed.
   * @param failure the Phase-2 ValidationFailure for the current round (recorded
   *   by 6b when seeding the fix agent; unused for entry gating).
   * @param reason  the CURRENT round's failure reason (the failing child's
   *   `failureReason` at the exec-gate site). Falls back to the graph record.
   *   Undefined / not-on-allowlist ⇒ non-fixable ⇒ returns false.
   */
  private async maybeStartRework(
    graphId: string,
    failure?: ValidationFailure,
    reason?: string,
  ): Promise<boolean> {
    const graph = await this.getGraph(graphId);
    if (!graph) return false;

    // The round reason is the explicitly-passed reason (exec gate: the failing
    // child's failureReason), falling back to the graph record.
    const roundReason = reason ?? graph.failureReason;
    const elig = await this.reworkEligibility(graph, roundReason);
    if (!elig) return false;

    // ── Idempotent re-entry into an IN-FLIGHT round [PT-loop-L1/C3] ──
    // The durable marker is the graph record itself (status "reworking" +
    // currentRound). A crash/concurrent re-drive from a FAIL SITE while already
    // reworking must NOT consume budget again — just re-run the reconciler and
    // report take-over. (Advancing to the NEXT round is a DIFFERENT operation the
    // reconciler performs directly via enterReworkRound, bypassing this guard —
    // see resumeReworkRound's failed-round branch — so this guard never blocks a
    // legitimate round advance.)
    if (graph.status === "reworking" && graph.currentRound) {
      await this.resumeReworkRound(graphId);
      return true;
    }

    return this.enterReworkRound(graphId, graph, failure, roundReason!, elig.fixRole, elig.maxAttempts);
  }

  /**
   * #317 phase3 (Task 6b) — the shared eligibility gate (no writes). Returns the
   * resolved fixRole+maxAttempts when the graph may auto-rework for `reason`, else
   * null. Used by BOTH the fresh-entry path (maybeStartRework) and the round-advance
   * path (resumeReworkRound) so a fix-of-a-fix / non-fixable-reason / depth-cap can
   * never slip through one path but not the other.
   */
  private async reworkEligibility(
    graph: TaskGraph,
    reason: string | undefined,
  ): Promise<{ maxAttempts: number; fixRole: string } | null> {
    if (!graph.autoRework) return null;                       // opt-in, default off
    if (graph.isReworkFixChild) return null;                  // no rework of a rework
    if (graph.selfImprove) return null;                       // retro graphs excluded
    // Re-clamp the budget at the consumption site (not just at declare time) so a
    // hand-seeded / legacy record carrying a larger maxAttempts still exhausts at the
    // hard cap — the cap is a consumption-site invariant.
    const maxAttempts = Math.min(graph.autoRework.maxAttempts ?? 0, REWORK_MAX_ATTEMPTS_CAP);
    if (maxAttempts < 1) return null;
    // Fixable-reason ALLOWLIST (default NON-fixable). Unknown/undefined ⇒ non-fixable.
    if (!reason || !FIXABLE_REWORK_REASONS.has(reason)) return null;
    // Recursion / depth stop.
    if ((await this.getGraphDepth(graph.id)) > REWORK_MAX_DEPTH) return null;
    return { maxAttempts, fixRole: graph.autoRework.fixRole ?? DEFAULT_FIX_ROLE };
  }

  /**
   * #317 phase3 (Task 6b) — the SHARED atomic-entry primitive [PT-P5]. Consumes one
   * budget unit and writes a fresh `currentRound` for the next attempt in a single
   * graph:<id> set, then hands to the reconciler. Called by maybeStartRework (fresh
   * entry from a fail site) AND directly by resumeReworkRound (advance to round N+1)
   * — the latter deliberately bypasses maybeStartRework's re-entry guard, which is
   * only meant to absorb a crash re-drive of the SAME in-flight round. Returns true
   * iff this call won the entry (budget remained AND the round claim was uncontested).
   */
  private async enterReworkRound(
    graphId: string,
    graph: TaskGraph,
    failure: ValidationFailure | undefined,
    reason: string,
    fixRole: string,
    maxAttempts: number,
  ): Promise<boolean> {
    const rework = new ReworkManager(this.redis);

    // ── Budget check ──
    if (!(await rework.canRework(graphId, REWORK_VALIDATION_TASK_ID, maxAttempts))) {
      rework.recordExhaustion(fixRole);
      return false; // budget exhausted → caller goes terminal
    }

    // Derive the attempt index from the DURABLE state (currentRound), NOT from
    // getReworkCount — so a crash between recordRejection and the currentRound
    // write recomputes the SAME attempt and the SET-NX round claim collides,
    // preventing a double-consume. First round = 1.
    const nextAttempt = (graph.currentRound?.attempt ?? 0) + 1;

    // (a) SET-NX round claim (TTL mirrors the completion lock's 300s;
    //     claim-and-forget, never released early). Two concurrent entries for the
    //     same next round → exactly one wins; the loser returns without consuming.
    const claimed = await this.redis.set(
      `reworkclaim:${graphId}:${nextAttempt}`,
      this.sessionId || "unknown",
      "EX", 300, "NX",
    );
    if (claimed !== "OK") return false;

    // (b) consume budget (the round claim above guarantees exactly-once).
    const entry: ReworkEntry = {
      iteration: nextAttempt,
      reason,
      rejectedBy: REWORK_VALIDATION_TASK_ID,
      timestamp: Date.now(),
    };
    await rework.recordRejection(graphId, REWORK_VALIDATION_TASK_ID, entry, { role: fixRole });

    // (c) capture the integration-branch HEAD at entry (best-effort, injectable via
    //     the remote-merge hooks seam). "" = unknown → the empty-fix guard fails
    //     safe (re-validate rather than short-circuit to terminal).
    const startHead = await readIntegrationHead(this.remoteMerge, graphId, graph.destination);

    // (d) write status="reworking" AND currentRound in a SINGLE graph:<id> set — a
    //     concurrent M2 branch must never observe `reworking` without currentRound.
    //     Carry the round's ValidationFailure so the reconciler can seed the fix
    //     prompt and replay it as the terminal failure when the loop gives up.
    const fresh = (await this.getGraph(graphId)) ?? graph;
    // Fix-integrity baseline: captured ONCE at the FIRST round's entry and carried
    // FORWARD unchanged on every advance (round 1 → startHead; round N+1 → the prior
    // round's baselineHead). checkFixIntegrity diffs `baselineHead..HEAD` so damage a
    // non-greening earlier round committed stays visible to a later round's guard. ""
    // (unknown) carries forward unchanged and is handled best-effort like startHead.
    const baselineHead = fresh.currentRound?.baselineHead ?? startHead;
    fresh.status = "reworking";
    fresh.currentRound = {
      attempt: nextAttempt,
      startHead,
      baselineHead,
      enteredAt: Date.now(),
      validationChildIds: [],
      ...(failure ? { failure } : {}),
    };
    await this.redis.set(`graph:${graphId}`, JSON.stringify(fresh), "EX", TTL);

    // Registry sync (H6): setStatus ONLY — do NOT recordValidationFailure (drops
    // `:files`) and do NOT teardown. The graph stays a live file-holder; peers on
    // the same destination see it via getRecentFailures as an in-flight caution.
    if (this.graphRegistry) {
      try { await this.graphRegistry.setStatus(this.graphDestKey(fresh), graphId, "reworking"); }
      catch { /* best-effort registry sync */ }
    }

    // Hand off to the shared reconciler (fix-child dispatch → re-validation → resolve).
    await this.resumeReworkRound(graphId);
    return true;
  }

  /** Terminal statuses a child graph can be in for completion-scan purposes.
   *  "canceled" is terminal: a canceled fix/re-validation child must resolve the round
   *  promptly (as a failed round) rather than park it until the 30-min reaper. */
  private static readonly CHILD_TERMINAL_STATUSES: readonly string[] = [
    "completed", "validated", "failed", "merged", "validation_failed", "canceled",
  ];

  /** Terminal statuses that count a child as a FAILED round. "canceled" is included:
   *  a canceled child produced no verdict and carries no failureReason → the
   *  fixable-reason allowlist defaults it NON-fixable → terminal validation_failed
   *  (never a promote on an unobserved verdict, never a re-validation loop). */
  private static readonly CHILD_FAILED_STATUSES: readonly string[] = [
    "failed", "validation_failed", "canceled",
  ];

  /**
   * #317 phase3 (Task 6b) — the SINGLE dispatch/resolution path [PT-P5]. Reconciles a
   * `reworking` graph from its persisted `currentRound` (idempotently), so the inline
   * entry path (enterReworkRound) and the sweep-driven crash-recovery path (Task 7)
   * cannot diverge. Every step is idempotent and re-drivable after a restart:
   *   (1) no fix child for attempt N  → dispatch it (marker-derived existence, M1);
   *   (2) fix child terminal, no re-validation yet → empty-fix HEAD guard (M3), then
   *       either terminal (proven-empty / broken fixer) or dispatch re-validation
   *       pinned to the updated integration branch — WITHOUT flipping status off
   *       "reworking" (HIGH-1);
   *   (3) re-validation children all terminal → scan ONLY currentRound.validationChildIds
   *       (C1): all pass → fix-integrity guard → validated + promote; any fail →
   *       advance to N+1 (budget/reason permitting) or terminal;
   *   (4) children still running → no-op (the child's completion callback re-drives).
   *
   * PUBLIC (Task 7, PT-loop-H1): the health-sweep calls this directly for every
   * supervised `reworking` graph so the two idle inter-step points — (a) after entry
   * claim, before fix dispatch; (c) after the fix child is terminal, before
   * re-validation dispatch — get re-driven after a restart or a crashed resolver.
   * Exposed as-is (no wrapper) rather than adding a `driveReworkingGraph` indirection:
   * this method is already the single reconcile-from-`currentRound` routine [PT-P5]
   * both the inline entry path and the sweep must funnel through, so the sweep calling
   * it by its real name keeps that "one dispatch path" invariant visible at the call
   * site instead of behind an extra layer.
   */
  async resumeReworkRound(graphId: string): Promise<void> {
    const graph = await this.getGraph(graphId);
    if (!graph || graph.status !== "reworking" || !graph.currentRound) return;
    const round = graph.currentRound;
    const attempt = round.attempt;
    const childIds = graph.childGraphIds ?? [];
    const isTerminal = (s: string) => TaskGraphManager.CHILD_TERMINAL_STATUSES.includes(s);

    // ── Locate the fix child for THIS attempt (MARKER-DERIVED, never stored [M1]) ──
    let fixChild: TaskGraph | null = null;
    for (const cid of childIds) {
      const c = await this.getGraph(cid);
      if (c?.isReworkFixChild && c.attempt === attempt) { fixChild = c; break; }
    }

    // ── STEP 1: no fix child yet → dispatch it ──
    if (!fixChild) {
      await this.dispatchReworkFixChild(graphId, graph, round);
      return;
    }

    // ── STEP 4: fix child still running → wait (its completion re-drives us) ──
    if (!isTerminal(fixChild.status)) return;
    const fixFailed = TaskGraphManager.CHILD_FAILED_STATUSES.includes(fixChild.status);

    // ── STEP 2: fix child terminal, no re-validation dispatched yet ──
    if (round.validationChildIds.length === 0) {
      // Fix agent itself crashed/failed → terminal (never loop on a broken fixer:
      // the round produced nothing to validate). Documented 6b policy.
      if (fixFailed) {
        if (!(await this.tryClaimResolution(graphId, attempt))) return;
        await this.resolveReworkTerminal(graphId, round);
        return;
      }

      // Empty-fix HEAD guard [M3]. startHead unknown ("") means we CANNOT prove the
      // fix was empty → fail safe: skip the short-circuit and re-validate (conservative
      // spend, correct outcome). A proven-unchanged HEAD → terminal with the ORIGINAL
      // failure (don't spend budget re-running an identical gate).
      //
      // #325: capture WITH ONE RETRY (captureIntegrationHeadForPin) — this same read
      // becomes `currentRound.revalidationHead` below, which checkHeadPin now fails
      // CLOSED on if it lands as "" (capture attempted, hooks wired, both reads
      // failed). `undefined` here means no capture capability at all (no remote-merge
      // hooks) — never compares equal to round.startHead, so the guard below falls
      // through to re-validate exactly as it did for a plain "" before #325.
      const head = await captureIntegrationHeadForPin(this.remoteMerge, graphId, graph.destination);
      if (round.startHead !== "" && head === round.startHead) {
        if (!(await this.tryClaimResolution(graphId, attempt))) return;
        await this.resolveReworkTerminal(graphId, round);
        return;
      }

      // HEAD moved (or unknown) → re-dispatch the SAME gate pinned to the updated
      // integration branch. A defensive terminal if the gate resolves to nothing.
      const execCriteria = this.resolveExecCriteria(graph);
      if (execCriteria.length === 0) {
        if (!(await this.tryClaimResolution(graphId, attempt))) return;
        await this.resolveReworkTerminal(graphId, round);
        return;
      }
      // Concurrency guard: exactly one drive dispatches re-validation for this round.
      const claimed = await this.redis.set(
        `reworkreval:${graphId}:${attempt}`, this.sessionId || "unknown", "EX", 300, "NX",
      );
      if (claimed !== "OK") return;
      // [PT-HIGH-1, LOAD-BEARING]: dispatch WITHOUT flipping status to "validating".
      // Status stays "reworking" so re-validation-child completions route through the
      // M2 branch (which scans only currentRound.validationChildIds), never the legacy
      // accumulated-childGraphIds scan (C1 poison) or a crash-strand.
      //
      // TELEMETRY NOTE: no graph_validating event / onValidationDispatched hook is
      // emitted per rework round (deliberate — status stays "reworking", not
      // "validating", so a re-validation round is not surfaced as a fresh validation
      // dispatch). The costed-span/telemetry surface belongs to the initial gate only.
      const newIds = await this.dispatchExecValidationChildren(graphId, graph, execCriteria);
      const afterDispatch = await this.getGraph(graphId);
      if (afterDispatch?.currentRound) {
        afterDispatch.currentRound.validationChildIds = newIds;
        // #322/#325 — pin THIS round's re-validation to the exact SHA it was
        // dispatched against (`head`, already read+retried above for the empty-fix
        // guard — no extra remote call). checkFixIntegrity diffs against this SHA
        // (not the live HEAD at check time) and the validated-resolution promote
        // below refuses if the live HEAD has since moved — closing the TOCTOU
        // window between re-validation and promote. `undefined` (no capture
        // capability) carries forward the same best-effort-OPEN semantics as
        // startHead/baselineHead; `""` (capture attempted and failed) is now a
        // distinct CLOSED state — see checkHeadPin.
        afterDispatch.currentRound.revalidationHead = head;
        await this.redis.set(`graph:${graphId}`, JSON.stringify(afterDispatch), "EX", TTL);
      }
      return;
    }

    // ── STEP 3: re-validation children present — scan ONLY currentRound.validationChildIds [C1] ──
    let allPassed = true;
    let anyRunning = false;
    let failedReason: string | undefined; // H7: THIS round's failed child reason
    let failedChildId: string | undefined; // I1: the failed re-validation child (fresh-failure source)
    for (const cid of round.validationChildIds) {
      const c = await this.getGraph(cid);
      if (!c) {
        // [6b-M2 hand-off / Task 7 (g)] a vanished re-validation child record (e.g.
        // TTL-expired) is an unrecoverable verdict — the same #318 hazard class as a
        // gone exec pod — and MUST count as FAILED, never neutral. A silent
        // `continue` here would let a round with a gone child still reach
        // `allPassed === true` if every OTHER child happened to pass, promoting on an
        // unobserved verdict. `exec_verdict_lost` is not on the fixable-reason
        // allowlist, so this routes to terminal rather than burning another attempt
        // on an unrecoverable read.
        allPassed = false;
        if (!failedReason) { failedReason = "exec_verdict_lost"; failedChildId = cid; }
        continue;
      }
      if (!isTerminal(c.status)) { anyRunning = true; continue; }
      // A canceled re-validation child (CHILD_FAILED_STATUSES) counts as FAILED — it
      // produced no verdict, so it must never let the round reach allPassed and promote
      // on an unobserved result. It carries no failureReason → non-fixable → terminal.
      if (TaskGraphManager.CHILD_FAILED_STATUSES.includes(c.status)) {
        allPassed = false;
        if (!failedReason) { failedReason = c.failureReason; failedChildId = cid; }
      }
    }
    if (anyRunning) return; // STEP 4: still waiting on a re-validation child

    // Serialize the round resolution (pass/terminal) behind the per-attempt completion
    // lock — two re-validation children finishing in one tick must resolve once.
    if (!(await this.tryClaimResolution(graphId, attempt))) return;

    if (allPassed) {
      // Fix-integrity guard (Task 8 implements the real diff-shape/coverage-id check;
      // ship the seam now). A rejected "fix" (e.g. deleted the failing test) is
      // terminal-to-operator, never promoted.
      if (await this.checkFixIntegrity(graphId, round)) {
        // #322 — the SHA-pin guard: refuse terminally if the live integration HEAD
        // has moved since re-validation was dispatched. Checked AFTER fix-integrity
        // (which reads round.revalidationHead, not the live HEAD, so it's unaffected
        // by a moved HEAD) and BEFORE any status flip, so a refusal here promotes
        // nothing and leaves the graph's prior state intact until the terminal write.
        const pin = await this.checkHeadPinForPromote(graphId, graph, round);
        if (!pin.ok) {
          logger.warn(`[sha-pin] graph ${graphId} attempt ${round.attempt}: refused promote — ${pin.reason}`);
          const failure = buildValidationFailure(graphId, graph.validationLevel, [
            { name: "integration-head-pin", type: "assertion", result: pin.reason },
          ]);
          await this.resolveReworkTerminal(graphId, round, failure, this.pinFailureReason(pin.reason));
          return;
        }
        if (graph.validationLevel) {
          try { onValidationResult({ graphId, level: graph.validationLevel, result: 'pass' }); } catch { /* fault isolation */ }
        }
        await this.updateGraphStatus(graphId, "validated");
        await this.emitEvent({ type: "graph_validated", graphId, timestamp: Date.now() });
        const tasks = await this.getAllTasks(graphId);
        await this.promoteIntegrationIfPod(graphId, graph, tasks);
        return;
      }
      await this.resolveReworkTerminal(graphId, round);
      return;
    }

    // A re-validation child genuinely failed → loop to attempt N+1 if the round's
    // reason is fixable and budget remains, else terminal. enterReworkRound is called
    // DIRECTLY (not via maybeStartRework) so the re-entry guard doesn't block the
    // advance; it derives N+1 from the durable currentRound and consumes budget.
    //
    // [I1] Seed round N+1's fix agent with THIS round's re-validation failure, NOT the
    // stale prior-round failure carried in round.failure — round N's fix may have
    // changed WHAT fails. Mirror the exec-gate construction (buildValidationFailure +
    // best-effort readValidationPodLog on the failed child). Keep round.failure only as
    // the fallback when there is no identifiable failed child to reconstruct from.
    let advanceFailure = round.failure;
    if (failedChildId) {
      let detail: string | undefined;
      if (this.callbacks.readValidationPodLog) {
        try { detail = await this.callbacks.readValidationPodLog(failedChildId); }
        catch { /* best-effort: never throw into the reconciler */ }
      }
      // #317 phase3 (Task 8) — real criterion name (see the twin site above).
      const criterionName = (await this.resolveFailedCriterionName(failedChildId)) || "validation-gate";
      advanceFailure = buildValidationFailure(graphId, graph?.validationLevel, [
        { name: criterionName, type: "exec", result: detail ?? "validation pod failed (no log captured)" },
      ]);
    }
    const elig = await this.reworkEligibility(graph, failedReason);
    if (elig && await this.enterReworkRound(graphId, graph, advanceFailure, failedReason!, elig.fixRole, elig.maxAttempts)) {
      return;
    }
    await this.resolveReworkTerminal(graphId, round);
  }

  /**
   * #317 phase3 (Task 6b) — dispatch the fix child graph for the current round. Single
   * real-agent task (execMode:false → gets the costed span) pinned to the parent's
   * integration branch, seeded with the round's Phase-2 failure context, marked
   * isReworkFixChild + attempt=N (so it can never itself rework and completion routing
   * finds it by marker), inheriting the parent's destination + toolchain. validationLevel/
   * autoRework/selfImprove are NOT passed → buildconfig cannot re-attach a gate/loop [C5].
   */
  private async dispatchReworkFixChild(
    graphId: string,
    graph: TaskGraph,
    round: NonNullable<TaskGraph["currentRound"]>,
  ): Promise<void> {
    const attempt = round.attempt;
    // Concurrency guard: exactly one drive dispatches the fix child for this attempt
    // (the durable marker scan in the caller handles the sequential/restart case).
    const claimed = await this.redis.set(
      `reworkfix:${graphId}:${attempt}`, this.sessionId || "unknown", "EX", 300, "NX",
    );
    if (claimed !== "OK") return;

    const fixRole = graph.autoRework?.fixRole ?? DEFAULT_FIX_ROLE;
    const integrationRef = `bureau/${graphId.slice(0, 8)}/integration`;
    const failureNote = round.failure ? formatValidationFailureNote(round.failure) : "";
    const prompt = [
      `A pre-promote validation gate FAILED on the integration branch \`${integrationRef}\` (auto-rework attempt ${attempt}).`,
      `Your job: fix the underlying CODE so the gate passes on re-run. Do NOT delete, rename, .skip, or otherwise weaken the failing test(s) — a fix that removes coverage is rejected by the integrity guard. Fix the root cause and commit to the integration branch.`,
      failureNote ? `\nRecorded failure (no need to re-run the full suite to rediscover it):\n${failureNote}` : "",
    ].filter(Boolean).join("\n");

    const fixTask: TaskNodeInput = {
      // NOT "rework-*" — checkGraphCompletion treats a "rework-"-prefixed task as a
      // best-effort review-loop task and IGNORES its failure (`:startsWith("rework-")`),
      // which would let a crashed fix agent silently "complete" the fix child.
      id: `fix-${attempt}`,
      role: fixRole,
      task: prompt,
      // Real agent (costed span with bureau.task.attempt), pinned to the parent's
      // integration branch (the merged candidate the fix must repair).
      execMode: false,
      gitBaseRef: integrationRef,
      attempt,
    };
    await this.declareGraph(graph.project, graph.cwd, [fixTask], {
      parentGraphId: graphId,
      destination: graph.destination,
      defaultToolchain: graph.defaultToolchain,
      isReworkFixChild: true,
      attempt,
    });
  }

  /**
   * #317 phase3 (Task 8) — recover the real criterion name behind a failed exec
   * validation CHILD graph. dispatchExecValidationChildren dispatches exactly one
   * task per child, with a deterministic id `criterion-<name>` — so the child's own
   * task list is the only durable place the real name survives (the failure-record
   * construction above historically collapsed it to a synthetic "validation-gate").
   * Best-effort: returns undefined (never throws) when the child/task is gone or
   * doesn't match the naming convention — callers fall back to the synthetic name.
   */
  private async resolveFailedCriterionName(childGraphId: string): Promise<string | undefined> {
    try {
      const tasks = await this.getAllTasks(childGraphId);
      const t = tasks.find((x) => x.id.startsWith("criterion-"));
      return t ? t.id.slice("criterion-".length) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * #317 phase3 (Task 6b) — the effective exec-gate criteria to re-dispatch on
   * re-validation. Explicit exec acceptance criteria win; otherwise the synthesized
   * unit/integration criterion (mirrors checkGraphCompletion's synthesis) so the
   * re-validation gate is byte-equivalent to the one that failed.
   *
   * NOTE: a re-validation round re-runs ONLY exec criteria — inline (non-exec) criteria
   * are deliberately excluded here. Inline criteria are k8s-skipped in pod mode anyway
   * (#174), so they never gated the merged candidate to begin with; re-running them on
   * re-validation would neither reproduce the original gate nor be runnable in the pod.
   */
  private resolveExecCriteria(graph: TaskGraph): CriterionDef[] {
    const explicit = (graph.acceptanceCriteria ?? []).filter((c) => c.type === "exec");
    if (explicit.length > 0) return explicit;
    const toolchain = graph.validationToolchain ?? graph.defaultToolchain;
    if (graph.validationLevel === "unit" && graph.validationTestCmd) {
      return [{
        name: "unit-validation", type: "exec",
        check: [graph.validationInstallCmd, graph.validationTestCmd].filter(Boolean).join(" && "),
        onFail: "fail", ...(toolchain ? { inputs: { toolchain } } : {}),
      }];
    }
    const integrationCmd = graph.validationIntegrationTestCmd ?? graph.validationTestCmd;
    if (graph.validationLevel === "integration" && integrationCmd) {
      const preflight = buildIntegrationPreflight(graph.testServices);
      const baseCheck = [graph.validationInstallCmd, integrationCmd].filter(Boolean).join(" && ");
      return [{
        name: "integration-validation", type: "exec",
        check: preflight ? `${preflight} && ${baseCheck}` : baseCheck,
        onFail: "fail", ...(toolchain ? { inputs: { toolchain } } : {}),
      }];
    }
    return [];
  }

  /**
   * #317 phase3 (Task 6b) — dispatch each exec criterion as a child graph pinned to
   * the integration branch. Shared by the INITIAL gate (checkGraphCompletion) and the
   * rework RE-VALIDATION (resumeReworkRound) so they cannot diverge. Returns the
   * declared child graph ids. Does NOT touch parent status (the caller owns that:
   * the initial gate sets "validating"; the rework path keeps "reworking" — HIGH-1).
   */
  private async dispatchExecValidationChildren(
    graphId: string,
    graph: TaskGraph,
    execCriteria: CriterionDef[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const criterion of execCriteria) {
      // #306: when the exec criterion carries requirement-coverage ids, resolve the
      // toolchain from the full fallback chain (used for BOTH the checker variant and
      // the pod image so they agree) and rewrite the command to a self-contained script.
      // No coverageIds ⇒ byte-identical to the pre-extraction path.
      const hasCoverage = (criterion.coverageIds?.length ?? 0) > 0;
      const execToolchain =
        criterion.inputs?.toolchain ?? graph.validationToolchain ?? graph.defaultToolchain ?? "node";
      // #320: splice a fail-fast test-file existence check ahead of a non-coverage
      // gate so a renamed/deleted test file fails the gate (vitest treats missing
      // args as filters, not failures). No-op ("") when no test-file paths are named.
      const execCommand = hasCoverage
        ? composeCoverageCommand(criterion.check, criterion.coverageIds!, execToolchain)
        : ((preflight) => (preflight ? `${preflight} && ${criterion.check}` : criterion.check))(
            buildTestFileExistencePreflight(criterion.check),
          );
      const execTask: TaskNodeInput = {
        id: `criterion-${criterion.name}`,
        role: criterion.fixRole ?? DEFAULT_AGENT_CRITERION_ROLE,
        task: execCommand,
        maxRetries: criterion.maxRetries ?? (criterion.onFail === "retry" ? 1 : 0),
        // LOAD-BEARING: pin to the integration branch so the pod validates the merged
        // candidate, not the base ref (would false-green before merge).
        gitBaseRef: `bureau/${graphId.slice(0, 8)}/integration`,
        ...(hasCoverage
          ? { toolchain: execToolchain }
          : (criterion.inputs?.toolchain ? { toolchain: criterion.inputs.toolchain } : {})),
        // Thread integration-test command so BUREAU_INTEGRATION_TEST_CMD is set in the pod env.
        ...(graph?.validationLevel === 'integration' && criterion.name === 'integration-validation'
          ? { integrationTest: criterion.check }
          : {}),
        // Signal graph-dispatch to run BUREAU_EXEC_CMD instead of Claude (zero-token).
        execMode: true,
      };
      const { graphId: childId } = await this.declareGraph(
        graph.project,
        graph.cwd,
        [execTask],
        // Inherit the parent's repo + toolchain: the exec pod must clone the SAME repo
        // the work merged into (the integration branch only exists on the parent's
        // destination) — the single-repo assumption surfaced by #226 Phase 4.
        { parentGraphId: graphId, destination: graph.destination, defaultToolchain: graph.defaultToolchain },
      );
      ids.push(childId);
    }
    return ids;
  }

  /**
   * #317 phase3 (Task 8) — fix-integrity guard (anti-gaming). Before promoting a
   * passed re-validation, reject a "fix" that greened the gate by deleting/renaming/
   * skip-marking the previously-failing test rather than fixing the code. Pure
   * two-tier logic lives in src/rework/fix-integrity.ts; this is thin wiring:
   *
   * Tier 1 (structured coverage-id): #306 guarantees at most one exec criterion
   * carries coverageIds. If THIS round's failure came from that criterion, assert
   * the SAME criterion + id set is still what got re-dispatched this round (the
   * JUnit report itself is not reachable engine-side — see fix-integrity.ts's
   * module doc for the artifact-reachability finding; the pod-side checker's own
   * fail-closed enforcement is the strongest available signal for "ran green").
   *
   * Tier 2 (diff-shape): best-effort — `getIntegrationDiff` absent/throws/null
   * SKIPS this tier (never blocks a legitimate promote; #320 remains the backstop).
   * A successfully-read diff showing a test-gaming shape (deletion/rename/skip
   * marker) rejects regardless of tier-1 outcome.
   *
   * Returns true ⇒ the fix is accepted for promotion.
   */
  private async checkFixIntegrity(
    graphId: string,
    round: NonNullable<TaskGraph["currentRound"]>,
  ): Promise<boolean> {
    const graph = await this.getGraph(graphId);
    if (!graph) return true; // graph vanished mid-resolve — defensive, should not happen

    const execCriteria = this.resolveExecCriteria(graph);
    const failedCoverage = findFailedCoverageCriterion(round.failure, execCriteria);

    let diff: DiffShapeInput | null = null;
    try {
      // Diff from the FIRST round's baseline (carried forward across rounds), NOT the
      // current round's startHead — otherwise damage an earlier non-greening round
      // committed (e.g. a deleted failing test) is invisible to this round's guard and
      // promotes with the damage. Fall back to startHead for any legacy in-flight round
      // predating baselineHead.
      //
      // #322: diff up to `round.revalidationHead` (the SHA captured when THIS round's
      // re-validation was DISPATCHED), never the live integration HEAD at check time —
      // otherwise a writer with direct push access could push an un-validated commit
      // between re-validation and this guard running and have it silently skipped
      // (or included) depending on what the live branch happens to be at read time.
      // Either SHA unknown ("") skips the tier best-effort, like startHead.
      const base = round.baselineHead ?? round.startHead;
      const range = resolveIntegrityDiffRange(base, round.revalidationHead);
      const raw = range
        ? await this.remoteMerge?.getIntegrationDiff?.(graphId, range.fromSha, graph.destination, range.toSha)
        : null;
      if (raw) {
        diff = { files: raw.files, patch: raw.patch, language: graph.validationToolchain ?? graph.defaultToolchain };
      }
    } catch { diff = null; } // best-effort: never let a diff-read failure block a legitimate promote

    const verdict = evaluateFixIntegrity({ failedCoverage, revalidationCriteria: execCriteria, diff });
    if (!verdict.ok) {
      logger.warn(`[fix-integrity] graph ${graphId} attempt ${round.attempt}: rejected — ${verdict.reason}`);
      return false;
    }
    return true;
  }

  /**
   * #322 — the validated-resolution promote guard. Re-reads the LIVE integration
   * HEAD at promote time and refuses (terminal-to-operator, via the caller) if it no
   * longer matches `round.revalidationHead` (the SHA captured when THIS round's
   * re-validation was dispatched) — a writer with direct push access to the
   * integration branch pushed in the window between re-validation and this check.
   * Either SHA unknown fails open (see checkHeadPin) — this guard can only refuse
   * what it can actually observe having moved.
   */
  private async checkHeadPinForPromote(
    graphId: string,
    graph: TaskGraph,
    round: NonNullable<TaskGraph["currentRound"]>,
  ): Promise<GuardVerdict> {
    // #325 — ABSENT (undefined) means a pre-#322 in-flight round, or no capture
    // capability at STEP-2 (no remote-merge hooks) — legacy-unpinned, fails OPEN
    // below via checkHeadPin, but surfaced here so an operator can see WHY a
    // promote went unpinned. Distinct from "" (capture attempted and failed),
    // which checkHeadPin refuses CLOSED — that case is logged at the call site
    // that receives the refusal, not here.
    if (round.revalidationHead === undefined) {
      logger.warn(`[sha-pin] graph ${graphId} attempt ${round.attempt}: no revalidationHead pin recorded — promoting unpinned (legacy pre-#322 round, or no capture capability)`);
    }
    const liveHead = await readIntegrationHead(this.remoteMerge, graphId, graph.destination);
    return checkHeadPin(round.revalidationHead, liveHead);
  }

  /**
   * #325 — persists `validationDispatchHead` (the first-pass counterpart of
   * `currentRound.revalidationHead`) captured at first-validation-child dispatch.
   * `head === undefined` means `captureIntegrationHeadForPin` found no capture
   * capability at all (no remote-merge hooks) — the field is deliberately left
   * ABSENT in that case (never written as ""), so `checkValidationDispatchPin`
   * treats this graph exactly like one with no validation gate: fails open, no
   * refusal. A real SHA or `""` (capture attempted and failed) is always
   * persisted, restart-durable like every other pinned field in this loop —
   * re-reads the graph fresh rather than writing the (possibly stale, locally
   * mutated with unpersisted synthetic criteria) `graph` object callers hold.
   */
  private async persistValidationDispatchHead(graphId: string, head: string | undefined): Promise<void> {
    if (head === undefined) return;
    const fresh = await this.getGraph(graphId);
    if (!fresh) return;
    fresh.validationDispatchHead = head;
    await this.redis.set(`graph:${graphId}`, JSON.stringify(fresh), "EX", TTL);
  }

  /**
   * #325 — maps a checkHeadPin refusal's descriptive `.reason` text to a stable,
   * machine-checkable `graph.failureReason`: `revalidation_pin_missing` for an
   * empty/failed capture (checkHeadPin's `""` branch), `validation_pin_mismatch`
   * for an observed moved HEAD (a real captured SHA that no longer matches live).
   * Shared by the rework-round guard (checkHeadPinForPromote) and the first-pass
   * guard (checkValidationDispatchPin) so both surface the SAME reason strings.
   */
  private pinFailureReason(reason: string): string {
    return reason.startsWith("revalidation_pin_missing") ? "revalidation_pin_missing" : "validation_pin_mismatch";
  }

  /**
   * #325 — the FIRST-PASS (non-rework) counterpart of checkHeadPinForPromote.
   * Refuses (ok:false) if the live integration HEAD no longer matches
   * `graph.validationDispatchHead` (the SHA captured when the FIRST validation
   * child was dispatched for this graph's initial gate). `validationDispatchHead`
   * absent ⇒ no validation child was ever dispatched (no gate, or no pin
   * capability) — short-circuits to ok:true WITHOUT reading the live HEAD (no
   * gate means nothing to compare against). Never called on the REWORK
   * resolution path — that path is governed entirely by
   * `currentRound.revalidationHead` / checkHeadPinForPromote instead, and
   * `validationDispatchHead` (set once, before any rework round) would be a
   * stale comparison there.
   */
  private async checkValidationDispatchPin(graphId: string, graph: TaskGraph | null): Promise<GuardVerdict> {
    if (graph?.validationDispatchHead === undefined) {
      // #325 — ABSENT covers a pre-#325 in-flight graph AND a gate with no async
      // validation-child dispatch (inline-only criteria) — both promote unpinned,
      // by design (no dispatch gap ⇒ nothing for a pin to protect). Logged so a
      // legacy in-flight graph's unpinned promote is visible to an operator; not
      // a refusal (see checkHeadPin — "" is the refusing state, not undefined).
      logger.warn(`[sha-pin] graph ${graphId}: no validation-dispatch pin recorded — promoting unpinned (legacy pre-#325 record, or no async validation-child dispatch for this gate)`);
      return { ok: true };
    }
    const liveHead = await readIntegrationHead(this.remoteMerge, graphId, graph.destination);
    return checkHeadPin(graph.validationDispatchHead, liveHead);
  }

  /**
   * #317 phase3 (Task 6b) — terminal give-up for a rework round. The bounded loop has
   * exhausted its options (empty fix / broken fixer / budget out / non-fixable next
   * reason / integrity reject / #322 moved-HEAD refusal): fall to terminal
   * validation_failed via the NORMAL Phase-2 teardown. Callers claim the per-attempt
   * completion lock before invoking this so the teardown fires once.
   *
   * `failureOverride` (#322): when given, replays THIS specific terminal reason
   * (e.g. the moved-HEAD refusal) instead of `round.failure` (the round's ORIGINAL
   * triggering failure) — the operator needs to see WHY the loop actually gave up
   * on this call, not just why the round started.
   *
   * `reasonOverride` (#325): when given, stamps `graph.failureReason` with THIS
   * value instead of leaving it at whatever the round's ORIGINAL triggering
   * failure set it to (e.g. "test_failure") — a pin refusal needs its own
   * machine-checkable reason (`revalidation_pin_missing` / `validation_pin_mismatch`)
   * visible on the graph record, not the stale reason that started the round.
   */
  private async resolveReworkTerminal(
    graphId: string,
    round: NonNullable<TaskGraph["currentRound"]>,
    failureOverride?: ValidationFailure,
    reasonOverride?: string,
  ): Promise<void> {
    await this.updateGraphStatus(graphId, "validation_failed", failureOverride ?? round.failure, reasonOverride);
    await this.emitEvent({ type: "graph_validation_failed", graphId, timestamp: Date.now() });
  }

  /** Mark a graph validation_failed AND record the failure for workspace-awareness,
   *  then emit the lifecycle event. Phase 2: always records (no rework fix-loop). */
  private async markValidationFailed(graphId: string, failure?: ValidationFailure): Promise<void> {
    // #317 phase3 (Task 6a fix, H6) — serialize the inline-criteria fail
    // resolution behind the SAME per-graph/attempt completion lock the pass path
    // uses (tryClaimResolution). Pass and fail are mutually exclusive within one
    // graph+attempt, so the loser of a concurrent double-drive must return having
    // done nothing — no rework entry, no teardown, no duplicate event. (This also
    // closes a pre-existing inline double-teardown race.)
    const lockGraph = await this.getGraph(graphId);
    // #317 phase3 (Task 6b) — lock-burn hardening. A `reworking` graph re-entering
    // here (a stray inline-criteria resolution while a round is in flight) must
    // delegate to the reconciler BEFORE claiming the per-attempt completion lock.
    // Claiming it first would burn `completionlock:<id>:N` and strand round N's
    // legitimate resolution until the 300s TTL + Task-7 sweep. (In practice the M2
    // branch at the top of checkGraphCompletion already routes reworking graphs to
    // the reconciler, so markValidationFailed is not reached while reworking — this
    // is defense-in-depth for any other caller of markValidationFailed.)
    if (lockGraph?.status === "reworking" && lockGraph.currentRound) {
      await this.resumeReworkRound(graphId);
      return;
    }
    if (!(await this.tryClaimResolution(graphId, lockGraph?.currentRound?.attempt ?? 0))) return;
    // #317 phase3 (Task 6a) — teardown deferral for the INLINE-criteria paths.
    // A hook here covers markValidationFailed's callers; the exec mechanical gate
    // resolves directly via updateGraphStatus (intercepted at its own site).
    // Inline failures carry no persisted fixable reason today, so this returns
    // false and preserves legacy behavior — but the hook is load-bearing the day
    // an inline reason is wired.
    if (await this.maybeStartRework(graphId, failure)) return;
    await this.updateGraphStatus(graphId, "validation_failed", failure);
    await this.emitEvent({ type: "graph_validation_failed", graphId, timestamp: Date.now() });
  }

  private async emitEvent(event: TaskEvent, cachedGraph?: TaskGraph | null): Promise<void> {
    const graph = cachedGraph !== undefined ? cachedGraph : await this.getGraph(event.graphId);
    const project = graph?.project || "global";
    await this.redis.xadd(
      `events:${project}`, "*",
      "type", event.type, "graphId", event.graphId,
      "taskId", event.taskId || "", "sessionId", event.sessionId || "",
      "timestamp", String(event.timestamp), "detail", event.detail || "",
      "childGraphId", event.childGraphId || "",
      "project", event.project || "",
      "parentGraphId", event.parentGraphId || "",
      "taskCount", event.taskCount != null ? String(event.taskCount) : "",
    );
    await this.redis.xtrim(`events:${project}`, "MAXLEN", "~", 1000);
    await this.callbacks.onEvent(event);

    // Bubble event to parent graph (only if not already a bubbled event, to prevent infinite recursion)
    if (!event.childGraphId && graph?.parentGraphId) {
      const parentGraph = await this.getGraph(graph.parentGraphId);
      if (parentGraph) {
        const bubbledEvent: TaskEvent = {
          ...event,
          childGraphId: event.graphId,
        };
        await this.redis.xadd(
          `events:${parentGraph.project}`, "*",
          "type", bubbledEvent.type, "graphId", parentGraph.id,
          "taskId", bubbledEvent.taskId || "", "sessionId", bubbledEvent.sessionId || "",
          "timestamp", String(bubbledEvent.timestamp), "detail", bubbledEvent.detail || "",
          "childGraphId", bubbledEvent.childGraphId ?? "",
          "project", bubbledEvent.project || "",
          "parentGraphId", bubbledEvent.parentGraphId || "",
          "taskCount", bubbledEvent.taskCount != null ? String(bubbledEvent.taskCount) : "",
        );
        await this.redis.xtrim(`events:${parentGraph.project}`, "MAXLEN", "~", 1000);
      }
    }
  }
}
