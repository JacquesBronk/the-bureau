import type { RedisClient } from "../redis.js";
import { scanKeys } from "../redis.js";
import type { WorkspaceIntent, WorkspaceConflict, ConflictSeverity } from "../types/workspace.js";

const INTENT_TTL = 3600; // 1 hour
const PROJECT_INTENT_TTL = 86400; // 24 hours

export function normalizePath(filePath: string, cwd: string): string {
  const normalCwd = cwd.endsWith("/") ? cwd : cwd + "/";
  let result = filePath;
  if (result.startsWith(normalCwd)) {
    result = result.slice(normalCwd.length);
  }
  return result.replace(/\\/g, "/");
}

export function parseFileRefsFromDescription(description: string): string[] {
  const paths = new Set<string>();

  // Backtick-wrapped paths — highest confidence
  const backtickRe = /`([^`]+\.[a-z]+)`/g;
  let match;
  while ((match = backtickRe.exec(description)) !== null) {
    paths.add(match[1]);
  }

  // Path-like patterns: contains "/" and has a file extension (exclude backticks to avoid double-matching backtick-wrapped paths)
  const pathRe = /[^\s`]*\/[^\s`]+\.[a-z]+/g;
  while ((match = pathRe.exec(description)) !== null) {
    paths.add(match[0]);
  }

  return Array.from(paths);
}

export class WorkspaceLedger {
  constructor(private redis: RedisClient) {}

  private intentKey(graphId: string, taskId: string): string {
    return `workspace:${graphId}:intents:${taskId}`;
  }

  private projectIntentKey(project: string, graphId: string, taskId: string): string {
    return `workspace:project:${project}:intents:${graphId}:${taskId}`;
  }

  private conflictsKey(graphId: string): string {
    return `workspace:${graphId}:conflicts`;
  }

  async publishIntent(graphId: string, taskId: string, intent: Partial<WorkspaceIntent>, project?: string): Promise<void> {
    const key = this.intentKey(graphId, taskId);
    const fields: (string | number)[] = [];

    if (intent.files !== undefined) {
      fields.push("files", JSON.stringify(intent.files));
    }
    if (intent.description !== undefined) {
      fields.push("description", intent.description);
    }
    if (intent.role !== undefined) {
      fields.push("role", intent.role);
    }
    if (intent.sessionId !== undefined) {
      fields.push("sessionId", intent.sessionId);
    }
    if (intent.phase !== undefined) {
      fields.push("phase", intent.phase);
    }
    if (intent.lastDiscoveryId !== undefined) {
      fields.push("lastDiscoveryId", intent.lastDiscoveryId);
    }

    fields.push("updatedAt", Date.now());

    await this.redis.hset(key, ...fields);
    await this.redis.expire(key, INTENT_TTL);

    // Mirror to project-scoped key for cross-graph visibility (advisory only)
    if (project) {
      const projectKey = this.projectIntentKey(project, graphId, taskId);
      const projectFields: (string | number)[] = ["graphId", graphId, "taskId", taskId, ...fields];
      await this.redis.hset(projectKey, ...projectFields);
      await this.redis.expire(projectKey, PROJECT_INTENT_TTL);
    }
  }

  async getIntent(graphId: string, taskId: string): Promise<WorkspaceIntent | null> {
    const key = this.intentKey(graphId, taskId);
    const data = await this.redis.hgetall(key);
    if (!data || Object.keys(data).length === 0) return null;

    return {
      taskId: data.taskId ?? taskId,
      graphId: data.graphId ?? graphId,
      files: data.files ? (JSON.parse(data.files) as string[]) : [],
      description: data.description ?? "",
      role: data.role ?? "",
      sessionId: data.sessionId ?? "",
      updatedAt: data.updatedAt ? Number(data.updatedAt) : 0,
      phase: data.phase ?? "",
      lastDiscoveryId: data.lastDiscoveryId ?? "0-0",
    };
  }

  async getAllIntents(graphId: string, parentGraphId?: string): Promise<WorkspaceIntent[]> {
    const pattern = `workspace:${graphId}:intents:*`;
    const keys = await scanKeys(this.redis, pattern);

    const intents: WorkspaceIntent[] = [];
    const prefix = `workspace:${graphId}:intents:`;
    for (const key of keys) {
      const taskId = key.slice(prefix.length);
      const intent = await this.getIntent(graphId, taskId);
      if (intent) intents.push(intent);
    }

    if (parentGraphId) {
      const parentPattern = `workspace:${parentGraphId}:intents:*`;
      const parentKeys = await scanKeys(this.redis, parentPattern);
      const parentPrefix = `workspace:${parentGraphId}:intents:`;
      for (const key of parentKeys) {
        const taskId = key.slice(parentPrefix.length);
        const intent = await this.getIntent(parentGraphId, taskId);
        if (intent) intents.push({ ...intent, fromParent: true });
      }
    }

    return intents;
  }

  /** Returns intents from all graphs on this project, excluding the caller's own graphId. */
  async getProjectIntents(project: string, excludeGraphId?: string): Promise<WorkspaceIntent[]> {
    const pattern = `workspace:project:${project}:intents:*`;
    const keys = await scanKeys(this.redis, pattern);
    const prefix = `workspace:project:${project}:intents:`;
    const intents: WorkspaceIntent[] = [];

    for (const key of keys) {
      const suffix = key.slice(prefix.length); // "{graphId}:{taskId}"
      const colonIdx = suffix.indexOf(":");
      if (colonIdx < 0) continue;
      const keyGraphId = suffix.slice(0, colonIdx);
      const keyTaskId = suffix.slice(colonIdx + 1);

      if (excludeGraphId && keyGraphId === excludeGraphId) continue;

      const data = await this.redis.hgetall(key);
      if (!data || Object.keys(data).length === 0) continue;

      let files: string[] = [];
      try { files = JSON.parse(data.files || "[]") as string[]; } catch { files = []; }

      intents.push({
        taskId: data.taskId ?? keyTaskId,
        graphId: data.graphId ?? keyGraphId,
        files,
        description: data.description ?? "",
        role: data.role ?? "",
        sessionId: data.sessionId ?? "",
        updatedAt: data.updatedAt ? Number(data.updatedAt) : 0,
        phase: data.phase ?? "",
        lastDiscoveryId: data.lastDiscoveryId ?? "0-0",
      });
    }

    return intents;
  }

  /** Aggregates conflicts across all graphs for a project (from their per-graph conflict hashes). */
  async getProjectConflicts(project: string): Promise<WorkspaceConflict[]> {
    const intents = await this.getProjectIntents(project);
    const graphIds = [...new Set(intents.map((i) => i.graphId))];
    const conflicts: WorkspaceConflict[] = [];
    const seen = new Set<string>();

    for (const graphId of graphIds) {
      const data = await this.redis.hgetall(this.conflictsKey(graphId));
      if (!data) continue;
      for (const raw of Object.values(data)) {
        try {
          const c = JSON.parse(raw) as WorkspaceConflict;
          const key = [c.taskA, c.taskB].sort().join(":");
          if (!seen.has(key)) {
            seen.add(key);
            conflicts.push(c);
          }
        } catch { /* skip malformed */ }
      }
    }

    return conflicts;
  }

  async removeIntent(graphId: string, taskId: string): Promise<void> {
    await this.redis.del(this.intentKey(graphId, taskId));
  }

  async cleanupGraph(graphId: string): Promise<void> {
    const intentKeys = await scanKeys(this.redis, `workspace:${graphId}:intents:*`);
    const allKeys = [
      ...intentKeys,
      this.conflictsKey(graphId),
      `workspace:${graphId}:discoveries`,
    ];

    if (allKeys.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const key of allKeys) {
      pipeline.del(key);
    }
    await pipeline.exec();
  }

  async detectConflicts(graphId: string, taskId: string, parentGraphId?: string): Promise<WorkspaceConflict[]> {
    const myIntent = await this.getIntent(graphId, taskId);
    if (!myIntent || myIntent.files.length === 0) return [];

    const allIntents = await this.getAllIntents(graphId, parentGraphId);
    const otherIntents = allIntents.filter((i) => i.taskId !== taskId);

    const conflicts: WorkspaceConflict[] = [];
    const conflictsKey = this.conflictsKey(graphId);
    const pipeline = this.redis.pipeline();

    for (const other of otherIntents) {
      if (other.files.length === 0) continue;

      const exactMatches = myIntent.files.filter((f) => other.files.includes(f));

      if (exactMatches.length > 0) {
        const severity: ConflictSeverity =
          myIntent.phase === "implementing" && other.phase === "implementing"
            ? "critical"
            : "high";

        const conflict: WorkspaceConflict = {
          taskA: taskId,
          taskB: other.taskId,
          files: exactMatches,
          severity,
          detectedAt: Date.now(),
        };

        conflicts.push(conflict);
        pipeline.hset(conflictsKey, `${taskId}:${other.taskId}`, JSON.stringify(conflict));
      } else {
        // Check for same parent directory, different files
        const getDir = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
        const myDirs = new Set(myIntent.files.map(getDir).filter(Boolean));
        const otherDirs = new Set(other.files.map(getDir).filter(Boolean));

        const dirOverlap = [...myDirs].filter((d) => otherDirs.has(d));
        if (dirOverlap.length > 0) {
          const dirSet = new Set(dirOverlap);
          const myFilesInDirs = myIntent.files.filter((f) => dirSet.has(getDir(f)));
          const otherFilesInDirs = other.files.filter((f) => dirSet.has(getDir(f)));

          const conflict: WorkspaceConflict = {
            taskA: taskId,
            taskB: other.taskId,
            files: [...new Set([...myFilesInDirs, ...otherFilesInDirs])],
            severity: "low",
            detectedAt: Date.now(),
          };

          conflicts.push(conflict);
          pipeline.hset(conflictsKey, `${taskId}:${other.taskId}`, JSON.stringify(conflict));
        }
      }
    }

    if (conflicts.length > 0) {
      pipeline.expire(conflictsKey, INTENT_TTL);
    }
    await pipeline.exec();

    return conflicts;
  }

  async addFiles(graphId: string, taskId: string, files: string[]): Promise<void> {
    const key = this.intentKey(graphId, taskId);
    const data = await this.redis.hget(key, "files");
    const existing: string[] = data ? (JSON.parse(data) as string[]) : [];
    const merged = [...new Set([...existing, ...files])];

    await this.redis.hset(key, "files", JSON.stringify(merged), "updatedAt", String(Date.now()));
    await this.redis.expire(key, INTENT_TTL);
  }
}
