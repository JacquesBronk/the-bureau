import { scanKeys, type RedisClient } from "../redis.js";
import type { YieldContext } from "../types/workspace.js";
import type { WorkspaceLedger } from "./ledger.js";

const YIELD_TTL = 86400; // 24 hours — matches graph TTL so yields never expire before the graph

export class YieldManager {
  constructor(private redis: RedisClient) {}

  private yieldKey(graphId: string, taskId: string): string {
    return `bureau:yield:${graphId}:${taskId}`;
  }

  async yieldTo(opts: {
    graphId: string;
    taskId: string;
    agents: string[];
    reason: string;
    partialComplete?: {
      summary: string;
      filesModified: string[];
      commitSha?: string;
    };
  }): Promise<void> {
    const key = this.yieldKey(opts.graphId, opts.taskId);
    const fields: (string | number)[] = [
      "agents", JSON.stringify(opts.agents),
      "reason", opts.reason,
      "partialComplete", JSON.stringify(opts.partialComplete ?? null),
      "yieldedAt", Date.now(),
      "taskId", opts.taskId,
      "graphId", opts.graphId,
    ];

    await this.redis.hset(key, ...fields);
    await this.redis.expire(key, YIELD_TTL);
  }

  async getYieldContext(graphId: string, taskId: string): Promise<YieldContext | null> {
    const key = this.yieldKey(graphId, taskId);
    const data = await this.redis.hgetall(key);
    if (!data || Object.keys(data).length === 0) return null;

    return parseYieldContext(data, graphId, taskId);
  }

  async resolveYield(graphId: string, taskId: string): Promise<YieldContext | null> {
    const key = this.yieldKey(graphId, taskId);
    const data = await this.redis.hgetall(key);
    if (!data || Object.keys(data).length === 0) return null;

    const context = parseYieldContext(data, graphId, taskId);
    await this.redis.del(key);
    return context;
  }

  async getActiveYields(graphId: string): Promise<YieldContext[]> {
    const pattern = `bureau:yield:${graphId}:*`;
    const keys = await scanKeys(this.redis, pattern);

    const yields: YieldContext[] = [];
    const prefix = `bureau:yield:${graphId}:`;
    for (const key of keys) {
      const taskId = key.slice(prefix.length);
      const data = await this.redis.hgetall(key);
      if (data && Object.keys(data).length > 0) {
        yields.push(parseYieldContext(data, graphId, taskId));
      }
    }

    return yields;
  }

  async detectDeadlock(graphId: string): Promise<{ deadlocked: boolean; cycle: string[] }> {
    const activeYields = await this.getActiveYields(graphId);
    if (activeYields.length === 0) return { deadlocked: false, cycle: [] };

    // Build directed graph: yielding task → set of yielded-to tasks
    const graph = new Map<string, string[]>();
    for (const yc of activeYields) {
      graph.set(yc.taskId, yc.agents);
    }

    // DFS cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const stackPath: string[] = [];

    function dfs(node: string): string[] | null {
      if (inStack.has(node)) {
        // Found cycle — extract it from stackPath
        const cycleStart = stackPath.indexOf(node);
        return [...stackPath.slice(cycleStart), node];
      }
      if (visited.has(node)) return null;

      visited.add(node);
      inStack.add(node);
      stackPath.push(node);

      const neighbors = graph.get(node) ?? [];
      for (const neighbor of neighbors) {
        const cycle = dfs(neighbor);
        if (cycle !== null) return cycle;
      }

      stackPath.pop();
      inStack.delete(node);
      return null;
    }

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        const cycle = dfs(node);
        if (cycle !== null) {
          return { deadlocked: true, cycle };
        }
      }
    }

    return { deadlocked: false, cycle: [] };
  }

  buildResumeContext(yieldContext: YieldContext, handoffs: Record<string, string>): string {
    const lines: string[] = ["## Resuming After Yield", ""];
    lines.push(`You previously yielded because: ${yieldContext.reason}`);

    if (yieldContext.partialComplete) {
      const pc = yieldContext.partialComplete;
      lines.push("", "### Your partial progress:");
      lines.push(pc.summary);
      if (pc.filesModified.length > 0) {
        lines.push(`Files modified: ${pc.filesModified.join(", ")}`);
      }
      if (pc.commitSha) {
        lines.push(`Commit: ${pc.commitSha}`);
      }
    }

    const handoffEntries = Object.entries(handoffs);
    if (handoffEntries.length > 0) {
      lines.push("", "### New context from completed agents:");
      for (const [agentId, handoff] of handoffEntries) {
        lines.push(`**${agentId}:** ${handoff}`);
      }
    }

    lines.push("", "Continue your work from where you left off.");
    return lines.join("\n");
  }
}

function parseYieldContext(
  data: Record<string, string>,
  graphId: string,
  taskId: string,
): YieldContext {
  const partialRaw = data.partialComplete ? JSON.parse(data.partialComplete) : null;
  return {
    taskId: data.taskId ?? taskId,
    graphId: data.graphId ?? graphId,
    agents: data.agents ? (JSON.parse(data.agents) as string[]) : [],
    reason: data.reason ?? "",
    partialComplete: partialRaw ?? undefined,
    yieldedAt: data.yieldedAt ? Number(data.yieldedAt) : 0,
  };
}

export async function shouldAutoResolve(opts: {
  yieldContext: YieldContext;
  ledger: WorkspaceLedger;
  graphId: string;
  taskId: string;
  isWorktree: boolean;
}): Promise<"proceed" | "wait" | "no-conflict"> {
  const { yieldContext, ledger, graphId, taskId, isWorktree } = opts;

  // Get the yielding task's intent to find its files
  const myIntent = await ledger.getIntent(graphId, taskId);
  const myFiles = new Set(myIntent?.files ?? []);

  if (myFiles.size === 0) return "no-conflict";

  // Check for real file overlap with the yielded-to agents
  let hasOverlap = false;
  for (const agentId of yieldContext.agents) {
    const agentIntent = await ledger.getIntent(graphId, agentId);
    if (!agentIntent) continue;
    for (const file of agentIntent.files) {
      if (myFiles.has(file)) {
        hasOverlap = true;
        break;
      }
    }
    if (hasOverlap) break;
  }

  if (!hasOverlap) return "no-conflict";
  if (isWorktree) return "proceed";
  return "wait";
}

export function selectForceProceeder(yields: YieldContext[]): string | null {
  if (yields.length === 0) return null;

  // Sort by: commitSha presence (desc) > filesModified.length (desc) > yieldedAt (asc = earliest)
  const sorted = [...yields].sort((a, b) => {
    const aHasCommit = a.partialComplete?.commitSha ? 1 : 0;
    const bHasCommit = b.partialComplete?.commitSha ? 1 : 0;
    if (bHasCommit !== aHasCommit) return bHasCommit - aHasCommit;

    const aFiles = a.partialComplete?.filesModified.length ?? 0;
    const bFiles = b.partialComplete?.filesModified.length ?? 0;
    if (bFiles !== aFiles) return bFiles - aFiles;

    return a.yieldedAt - b.yieldedAt;
  });

  return sorted[0].taskId;
}
