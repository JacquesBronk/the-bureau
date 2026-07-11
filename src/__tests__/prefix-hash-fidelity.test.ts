import { describe, it, expect } from "vitest";
import { computePrefixHash } from "../prefix-hash.js";
import { CacheAnomalyDetector } from "../telemetry/domain/anomaly.js";
import { ATTR } from "../telemetry/schema.js";

// ── F1-a: toolchain participates in the prefix fingerprint ───────────────────

const BASE_INPUTS = {
  roleDefinition: "ROLE CORE BODY — identical across toolchains",
  mcpToolNames: ["bureau-agent"],
  claudeMdContent: "",
};

describe("computePrefixHash toolchain fidelity (F1-a)", () => {
  it("differs for node vs python with the same role core", () => {
    const node = computePrefixHash({ ...BASE_INPUTS, toolchain: "node" });
    const python = computePrefixHash({ ...BASE_INPUTS, toolchain: "python" });
    expect(node).not.toBe(python);
  });

  it("is identical for two calls with the same role + toolchain", () => {
    const a = computePrefixHash({ ...BASE_INPUTS, toolchain: "python" });
    const b = computePrefixHash({ ...BASE_INPUTS, toolchain: "python" });
    expect(a).toBe(b);
  });
});

// ── In-memory ZSET + string mock Redis for the detector ──────────────────────

function makeMockRedis() {
  const zsets = new Map<string, Array<{ score: number; member: string }>>();
  const strings = new Map<string, string>();
  const bound = (v: string): number => (v === "-inf" ? -Infinity : v === "+inf" ? Infinity : Number(v));
  return {
    async zadd(key: string, score: number, member: string) {
      const arr = zsets.get(key) ?? [];
      const existing = arr.find(e => e.member === member);
      if (existing) existing.score = score;
      else arr.push({ score, member });
      zsets.set(key, arr);
      return 1;
    },
    async zremrangebyscore(key: string, min: string, max: string) {
      const arr = zsets.get(key) ?? [];
      const lo = bound(min), hi = bound(max);
      zsets.set(key, arr.filter(e => e.score < lo || e.score > hi));
      return 0;
    },
    async zremrangebyrank(key: string, start: number, stop: number) {
      const arr = (zsets.get(key) ?? []).sort((a, b) => a.score - b.score);
      const n = arr.length;
      const s = start < 0 ? n + start : start;
      const e = stop < 0 ? n + stop : stop;
      zsets.set(key, arr.filter((_, i) => i < s || i > e));
      return 0;
    },
    async zrangebyscore(key: string, min: string, max: string) {
      const arr = (zsets.get(key) ?? []).slice().sort((a, b) => a.score - b.score);
      const lo = bound(min), hi = bound(max);
      return arr.filter(e => e.score >= lo && e.score <= hi).map(e => e.member);
    },
    async expire() { return 1; },
    async get(key: string) { return strings.has(key) ? strings.get(key)! : null; },
    async set(key: string, val: string, ..._args: unknown[]) { strings.set(key, val); return "OK"; },
    async incr(key: string) {
      const n = Number(strings.get(key) ?? "0") + 1;
      strings.set(key, String(n));
      return n;
    },
    _zsets: zsets,
  } as any;
}

function makeMockMeter() {
  const anomalies: Record<string, string>[] = [];
  const meter = {
    createCounter: (_name: string) => ({
      add: (_v: number, attrs?: Record<string, string>) => {
        if (attrs && attrs[ATTR.ANOMALY_TYPE]) anomalies.push(attrs);
      },
    }),
    createHistogram: () => ({ record: () => {} }),
  } as any;
  return { meter, anomalies };
}

const USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 1000, // read>0 so uncached detector never fires
  cacheCreationInputTokens: 0, // create==0 so thrash detector never fires
  totalCostUsd: 0.01,
};

describe("cache.prefix_instability keyed on (role, model, toolchain)", () => {
  it("STILL fires when one toolchain shows ≥3 distinct prefix hashes (control)", async () => {
    const redis = makeMockRedis();
    const { meter, anomalies } = makeMockMeter();
    const detector = new CacheAnomalyDetector(redis, meter);

    const attrs = { role: "coder", model: "sonnet", graphId: "g", taskId: "t", toolchain: "node" };
    await detector.observe(attrs, USAGE, "hash-a");
    await detector.observe(attrs, USAGE, "hash-b");
    await detector.observe(attrs, USAGE, "hash-c");

    expect(anomalies.some(a => a[ATTR.ANOMALY_TYPE] === "cache.prefix_instability")).toBe(true);
  });

  it("does NOT fire when the 3 distinct hashes come purely from different toolchains", async () => {
    const redis = makeMockRedis();
    const { meter, anomalies } = makeMockMeter();
    const detector = new CacheAnomalyDetector(redis, meter);

    // Same (role, model); one stable hash per toolchain → no single key sees ≥3.
    await detector.observe({ role: "coder", model: "sonnet", graphId: "g", taskId: "t1", toolchain: "node" }, USAGE, "hash-node");
    await detector.observe({ role: "coder", model: "sonnet", graphId: "g", taskId: "t2", toolchain: "python" }, USAGE, "hash-python");
    await detector.observe({ role: "coder", model: "sonnet", graphId: "g", taskId: "t3", toolchain: "dotnet" }, USAGE, "hash-dotnet");

    expect(anomalies.some(a => a[ATTR.ANOMALY_TYPE] === "cache.prefix_instability")).toBe(false);
  });
});
