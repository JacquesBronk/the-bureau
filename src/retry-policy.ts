/**
 * Retry policy for failed agent tasks.
 *
 * Determines whether a failed task should be retried and calculates backoff.
 * Also provides retry storm detection: if 3+ tasks in the same graph fail
 * within 60s, a storm is declared.
 */

export interface RetryPolicyConfig {
  /** Maximum number of retries before marking the task as permanently failed. Default: 3 */
  maxRetries?: number;
  /** Initial backoff in ms before the first retry. Default: 5000 */
  backoffMs?: number;
  /** Multiplier applied to backoffMs on each subsequent retry. Default: 2 */
  backoffMultiplier?: number;
  /** Maximum backoff in ms (caps exponential growth). Default: 60000 */
  maxBackoffMs?: number;
  /** Exit codes that are eligible for retry. Default: [1] */
  retryableExitCodes?: number[];
  /**
   * Log tail patterns that indicate a non-retryable failure (e.g. bad config,
   * auth errors). If any pattern matches the log tail, retry is skipped.
   */
  nonRetryable?: string[];
}

const DEFAULT_NON_RETRYABLE: readonly string[] = [
  'API key invalid',
  'Invalid API key',
  'authentication failed',
  'Permission denied',
  'EACCES',
  'EPERM',
  '--strict-mcp-config',
];

export class RetryPolicy {
  readonly maxRetries: number;
  readonly backoffMs: number;
  readonly backoffMultiplier: number;
  readonly maxBackoffMs: number;
  readonly retryableExitCodes: ReadonlySet<number>;
  readonly nonRetryable: readonly string[];

  constructor(config: RetryPolicyConfig = {}) {
    this.maxRetries = config.maxRetries ?? 3;
    this.backoffMs = config.backoffMs ?? 5000;
    this.backoffMultiplier = config.backoffMultiplier ?? 2;
    this.maxBackoffMs = config.maxBackoffMs ?? 60_000;
    this.retryableExitCodes = new Set(config.retryableExitCodes ?? [1]);
    this.nonRetryable = config.nonRetryable ?? DEFAULT_NON_RETRYABLE;
  }

  /**
   * Determine whether a failed task should be retried.
   *
   * @param exitCode    - The process exit code (null → treat as 1)
   * @param retryCount  - Number of retries already attempted
   * @param logTail     - Last portion of the agent's log output (for pattern matching)
   */
  shouldRetry(exitCode: number | null, retryCount: number, logTail: string): boolean {
    if (retryCount >= this.maxRetries) return false;

    const code = exitCode ?? 1;

    // Only retry on known retryable exit codes
    if (!this.retryableExitCodes.has(code)) return false;

    // Skip retry if log contains a non-retryable error pattern
    for (const pattern of this.nonRetryable) {
      if (logTail.includes(pattern)) return false;
    }

    return true;
  }

  /**
   * Calculate the backoff delay (ms) before the next retry attempt.
   *
   * @param retryCount - Number of retries already attempted (0 = first retry)
   */
  nextBackoffMs(retryCount: number): number {
    const backoff = this.backoffMs * Math.pow(this.backoffMultiplier, retryCount);
    return Math.min(backoff, this.maxBackoffMs);
  }
}

// ---------------------------------------------------------------------------
// Retry storm detection
// ---------------------------------------------------------------------------

interface FailureRecord {
  taskId: string;
  failedAt: number;
}

/**
 * Detects retry storms: 3+ distinct task failures within the same graph
 * within a 60-second window.
 */
export class RetryStormDetector {
  private readonly windowMs: number;
  private readonly threshold: number;
  /** Per-graph sliding window of recent failure timestamps. */
  private readonly failures = new Map<string, FailureRecord[]>();

  constructor(windowMs = 60_000, threshold = 3) {
    this.windowMs = windowMs;
    this.threshold = threshold;
  }

  /**
   * Record a task failure and check whether a storm is in progress.
   *
   * @returns true if a storm is detected (this failure is the triggering one
   *          or the storm was already underway)
   */
  record(graphId: string, taskId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const records = this.failures.get(graphId) ?? [];
    // Evict old records outside the window
    const recent = records.filter(r => r.failedAt >= cutoff);
    recent.push({ taskId, failedAt: now });
    this.failures.set(graphId, recent);

    // Count distinct tasks that failed within the window
    const distinctTasks = new Set(recent.map(r => r.taskId));
    return distinctTasks.size >= this.threshold;
  }

  /** Reset state for a graph (e.g. after it's been paused or resolved). */
  reset(graphId: string): void {
    this.failures.delete(graphId);
  }

  /** How many distinct task failures occurred within the window for a graph. */
  failureCount(graphId: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const records = this.failures.get(graphId) ?? [];
    const recent = records.filter(r => r.failedAt >= cutoff);
    return new Set(recent.map(r => r.taskId)).size;
  }
}

/** Shared default retry policy used by the MCP server. */
export const defaultRetryPolicy = new RetryPolicy();

/** Shared default storm detector used by the MCP server. */
export const defaultStormDetector = new RetryStormDetector();
