import type { RedisClient } from "../redis.js";
import { scanKeys } from "../redis.js";
import type { ValidationFailure } from "../types/workspace.js";

const GRAPH_TTL = 86400; // 24h crash backstop; lifecycle deregister is primary cleanup

export interface GraphSummary {
  graphId: string;
  project: string;
  status: "active" | "validating" | "done" | "validation_failed" | "reworking";
  destination: string | null;
  baseRef: string | null;
  focus: string[];
  predictedFiles: string[];
  startedAt: number;
  updatedAt: number;
  failure?: ValidationFailure;       // present only when status === "validation_failed"
}

/** Coordination key: the destination name, or a per-cwd local bucket when none. */
export function destKey(destination: string | null | undefined, cwd: string): string {
  return destination && destination.length > 0 ? destination : `local:${cwd}`;
}

const dirOf = (f: string): string => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");

export const isActivePeer = (s: GraphSummary): boolean => s.status !== "done" && s.status !== "validation_failed";
export const isFailure = (s: GraphSummary): boolean => s.status === "validation_failed" || s.status === "reworking";

/** Pure file-overlap: exact matches, plus same-directory (non-exact) neighbours. */
export function footprintOverlap(mine: string[], theirs: string[]): { exact: string[]; dir: string[] } {
  const theirSet = new Set(theirs);
  const exact = mine.filter((f) => theirSet.has(f));
  const exactSet = new Set(exact);
  const exactDirs = new Set(exact.map(dirOf).filter(Boolean));
  const myDirs = new Set(mine.map(dirOf).filter(Boolean));
  const theirDirs = new Set(theirs.map(dirOf).filter(Boolean));
  const dir = [...new Set([...mine, ...theirs])].filter((f) => {
    const d = dirOf(f);
    return d.length > 0 && myDirs.has(d) && theirDirs.has(d) && !exactSet.has(f) && !exactDirs.has(d);
  });
  return { exact, dir };
}

export class GraphRegistry {
  constructor(private redis: RedisClient) {}

  private metaKey(dk: string, graphId: string): string {
    return `workspace:dest:${dk}:graph:${graphId}:meta`;
  }
  private filesKey(dk: string, graphId: string): string {
    return `workspace:dest:${dk}:graph:${graphId}:files`;
  }

  async register(dk: string, s: GraphSummary): Promise<void> {
    await this.redis.set(this.metaKey(dk, s.graphId), JSON.stringify(s), "EX", GRAPH_TTL);
  }

  async setStatus(dk: string, graphId: string, status: GraphSummary["status"]): Promise<void> {
    const key = this.metaKey(dk, graphId);
    const raw = await this.redis.get(key);
    if (!raw) return; // entry gone (deregistered) — no-op, never recreate
    let s: GraphSummary;
    try { s = JSON.parse(raw) as GraphSummary; } catch { return; }
    s.status = status;
    s.updatedAt = Date.now();
    await this.redis.set(key, JSON.stringify(s), "EX", GRAPH_TTL);
  }

  /** Atomic, dedup-free accumulation via a SET. Guarded: skips if the graph is gone. */
  async addActualFiles(dk: string, graphId: string, files: string[]): Promise<void> {
    if (files.length === 0) return;
    const exists = await this.redis.exists(this.metaKey(dk, graphId));
    if (!exists) return; // already deregistered — avoid a ghost files key
    const fkey = this.filesKey(dk, graphId);
    await this.redis.sadd(fkey, ...files);
    await this.redis.expire(fkey, GRAPH_TTL);
    await this.redis.expire(this.metaKey(dk, graphId), GRAPH_TTL); // refresh meta TTL on progress
  }

  async getFootprint(dk: string, graphId: string): Promise<string[]> {
    const raw = await this.redis.get(this.metaKey(dk, graphId));
    const predicted: string[] = raw ? ((JSON.parse(raw) as GraphSummary).predictedFiles ?? []) : [];
    const actual = await this.redis.smembers(this.filesKey(dk, graphId));
    return [...new Set([...predicted, ...actual])];
  }

  async getActiveGraphs(dk: string): Promise<GraphSummary[]> {
    return this.scanSummaries(`workspace:dest:${dk}:graph:*:meta`, isActivePeer);
  }

  async getAllActiveGraphs(): Promise<GraphSummary[]> {
    return this.scanSummaries(`workspace:dest:*:graph:*:meta`, isActivePeer);
  }

  async getRecentFailures(dk: string): Promise<GraphSummary[]> {
    return this.scanSummaries(`workspace:dest:${dk}:graph:*:meta`, isFailure);
  }

  /** Single unfiltered scan of all graph summaries for a destination — callers that need
   *  both active peers and recent failures should scan once with this and partition
   *  in-memory with `isActivePeer`/`isFailure` instead of calling getActiveGraphs +
   *  getRecentFailures separately (which each re-scan the same `:meta` key pattern). */
  async getDestSummaries(dk: string): Promise<GraphSummary[]> {
    return this.scanSummaries(`workspace:dest:${dk}:graph:*:meta`, () => true);
  }

  async getAllRecentFailures(): Promise<GraphSummary[]> {
    return this.scanSummaries(`workspace:dest:*:graph:*:meta`, isFailure);
  }

  private async scanSummaries(pattern: string, keep: (s: GraphSummary) => boolean): Promise<GraphSummary[]> {
    const keys = await scanKeys(this.redis, pattern);
    const out: GraphSummary[] = [];
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw) continue;
      try {
        const s = JSON.parse(raw) as GraphSummary;
        if (keep(s)) out.push(s);
      } catch { /* skip malformed */ }
    }
    return out;
  }

  /** Retain the meta entry with a validation-failure payload instead of tearing it down.
   *  No-op if the entry is already gone (never recreate). Drops the now-stale files set. */
  async recordValidationFailure(dk: string, graphId: string, failure: ValidationFailure): Promise<void> {
    const key = this.metaKey(dk, graphId);
    const raw = await this.redis.get(key);
    if (!raw) return;
    let s: GraphSummary;
    try { s = JSON.parse(raw) as GraphSummary; } catch { return; }
    s.status = "validation_failed";
    s.failure = failure;
    s.updatedAt = Date.now();
    await this.redis.set(key, JSON.stringify(s), "EX", GRAPH_TTL);
    await this.redis.del(this.filesKey(dk, graphId)); // failed graph is no longer a file-holder
  }

  async deregister(dk: string, graphId: string): Promise<void> {
    await this.redis.del(this.metaKey(dk, graphId), this.filesKey(dk, graphId));
  }

  /** Destination-scoped clear: deregister validation_failed entries older than the cutoff.
   *  Never sweeps `reworking` entries — those are live file-holders (H6) whose teardown
   *  is deferred until the rework resolves, and (unlike validation_failed) they carry no
   *  `.failure` timestamp to age against. */
  async clearFailuresOlderThan(dk: string, olderThanMs: number): Promise<number> {
    const failures = await this.getRecentFailures(dk);
    let cleared = 0;
    for (const s of failures) {
      if (s.status !== "validation_failed") continue;
      if ((s.failure?.at ?? 0) < olderThanMs) {
        await this.deregister(dk, s.graphId);
        cleared++;
      }
    }
    return cleared;
  }
}
