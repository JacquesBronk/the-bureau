import type pino from "pino";
import type { TaskGraphManager } from "../task-graph.js";
import type { YieldManager } from "./yield.js";
import type { WorkspaceLedger } from "./ledger.js";
import { shouldAutoResolve } from "./yield.js";

const FIVE_MINUTES = 300_000;

export class YieldEscalation {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private yieldManager: YieldManager,
    private ledger: WorkspaceLedger,
    private graphManager: TaskGraphManager,
    private log: pino.Logger,
  ) {}

  private timerKey(graphId: string, taskId: string): string {
    return `${graphId}:${taskId}`;
  }

  /** Called when a task yields. Starts the escalation timer. */
  startEscalation(graphId: string, taskId: string, isWorktree: boolean): void {
    const key = this.timerKey(graphId, taskId);

    // Cancel any existing timer for this task (idempotent)
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    // Phase 1: immediate auto-resolve check (setTimeout 0)
    const immediateHandle = setTimeout(() => {
      this.timers.delete(key);
      this.runAutoResolveCheck(graphId, taskId, isWorktree).catch((err) => {
        this.log.warn({ err: String(err), graphId, taskId }, "yield escalation: auto-resolve check failed");
      });
    }, 0);

    this.timers.set(key, immediateHandle);
  }

  private async runAutoResolveCheck(graphId: string, taskId: string, isWorktree: boolean): Promise<void> {
    // Guard: check the task is still yielded
    const task = await this.graphManager.getTask(graphId, taskId);
    if (!task || task.status !== "yielded") return;

    const yieldContext = await this.yieldManager.getYieldContext(graphId, taskId);
    if (!yieldContext) return;

    const resolution = await shouldAutoResolve({
      yieldContext,
      ledger: this.ledger,
      graphId,
      taskId,
      isWorktree,
    });

    if (resolution === "no-conflict") {
      try {
        await this.graphManager.resumeYieldedTask(graphId, taskId, "no real file overlap detected");
      } catch (err) {
        this.log.warn({ err: String(err), graphId, taskId }, "yield escalation: resumeYieldedTask failed on auto-resolve");
      }
    } else if (resolution === "proceed") {
      try {
        await this.graphManager.resumeYieldedTask(graphId, taskId, "worktree isolation handles merge");
      } catch (err) {
        this.log.warn({ err: String(err), graphId, taskId }, "yield escalation: resumeYieldedTask failed on proceed");
      }
    } else {
      // "wait" — set up the 5-minute fallback timer
      const key = this.timerKey(graphId, taskId);
      const fallbackHandle = setTimeout(() => {
        this.timers.delete(key);
        this.runFallback(graphId, taskId, isWorktree).catch((err) => {
          this.log.warn({ err: String(err), graphId, taskId }, "yield escalation: 5-minute fallback failed");
        });
      }, FIVE_MINUTES);
      this.timers.set(key, fallbackHandle);
    }
  }

  private async runFallback(graphId: string, taskId: string, isWorktree: boolean): Promise<void> {
    // Guard: check the task is still yielded
    const task = await this.graphManager.getTask(graphId, taskId);
    if (!task || task.status !== "yielded") return;

    if (isWorktree) {
      try {
        await this.graphManager.resumeYieldedTask(graphId, taskId, "5-minute fallback: worktree isolation handles merge");
      } catch (err) {
        this.log.warn({ err: String(err), graphId, taskId }, "yield escalation: resumeYieldedTask failed on 5-minute fallback");
      }
    }
    // Non-worktree: leave yielded, runtime dependency already added in onTaskYielded

    // Check if >50% of graph tasks are yielded → pause graph
    await this.checkMajorityYielded(graphId);
  }

  private async checkMajorityYielded(graphId: string): Promise<void> {
    const allTasks = await this.graphManager.getAllTasks(graphId);
    if (allTasks.length === 0) return;

    const yieldedCount = allTasks.filter((t) => t.status === "yielded").length;
    const totalActive = allTasks.filter((t) => !["completed", "failed", "canceled"].includes(t.status)).length;

    if (totalActive > 0 && yieldedCount > totalActive / 2) {
      await this.graphManager.emitEventPublic({
        type: "graph_paused",
        graphId,
        timestamp: Date.now(),
        detail: `majority yielded: ${yieldedCount}/${totalActive} active tasks are yielded`,
      });
      this.log.warn({ graphId, yieldedCount, totalActive }, "graph paused: majority of tasks are yielded");
    }
  }

  /** Called when a yield resolves (dependency completed or human override). Cancels the timer. */
  cancelEscalation(graphId: string, taskId: string): void {
    const key = this.timerKey(graphId, taskId);
    const handle = this.timers.get(key);
    if (handle) {
      clearTimeout(handle);
      this.timers.delete(key);
    }
  }

  /** Cleanup all timers (for shutdown). */
  cancelAll(): void {
    for (const handle of this.timers.values()) {
      clearTimeout(handle);
    }
    this.timers.clear();
  }
}
