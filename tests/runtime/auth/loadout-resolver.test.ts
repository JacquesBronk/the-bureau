import { describe, it, expect, afterAll } from "vitest";
import Redis from "ioredis";
import { resolveLoadoutFromTask, resolveCapabilityFromTask, resolveOperatorLoadout } from "../../../src/runtime/auth/loadout-resolver.js";
import type { VerifiedIdentity } from "../../../src/runtime/auth/verifier.js";
import type { Capability } from "../../../src/runtime/capability.js";

const url = process.env.REDIS_URL || "redis://redis.local:6379/14";
const redis = new Redis(url);

// Unique graph id namespace for this test file — avoids colliding with (or
// wiping) other tests sharing the db. NO flushdb: the suite runs 4 parallel forks.
const G = `loadout-test-${process.pid}-${Date.now()}`;
const createdKeys: string[] = [];

async function putNode(graphId: string, taskId: string, node: unknown) {
  const key = `graph:${graphId}:tasks:${taskId}`;
  await redis.set(key, JSON.stringify(node));
  createdKeys.push(key);
}

afterAll(async () => {
  if (createdKeys.length) await redis.del(...createdKeys);
  await redis.quit();
});

function id(over: Partial<VerifiedIdentity>): VerifiedIdentity {
  return { sessionId: "s", claims: {}, ...over };
}

describe("resolveOperatorLoadout", () => {
  it("trusts the loadout claim for an internal (engine-signed) identity", () => {
    expect(resolveOperatorLoadout(id({ internal: true, loadout: "operator" }))).toBe("operator");
  });

  it("falls back to minimal for an internal identity with no/invalid claim", () => {
    expect(resolveOperatorLoadout(id({ internal: true, loadout: "bogus" }))).toBe("minimal");
    expect(resolveOperatorLoadout(id({ internal: true }))).toBe("minimal");
  });

  it("uses the issuer defaultLoadout for an external identity, ignoring any claim", () => {
    expect(resolveOperatorLoadout(id({ internal: false, defaultLoadout: "full", loadout: "operator" }))).toBe("full");
  });

  it("falls back to minimal for an external identity with no defaultLoadout", () => {
    expect(resolveOperatorLoadout(id({ internal: false }))).toBe("minimal");
  });
});

describe("resolveLoadoutFromTask", () => {
  it("returns the node's loadout when present", async () => {
    await putNode(G, "t1", { id: "t1", loadout: "coordinator" });
    expect(await resolveLoadoutFromTask(redis as any, G, "t1")).toBe("coordinator");
  });

  it("defaults to minimal when the node has no loadout", async () => {
    await putNode(G, "t2", { id: "t2" });
    expect(await resolveLoadoutFromTask(redis as any, G, "t2")).toBe("minimal");
  });

  it("defaults to minimal when the node is missing", async () => {
    expect(await resolveLoadoutFromTask(redis as any, G, "nope")).toBe("minimal");
  });

  it("defaults to minimal when loadout is an unknown string", async () => {
    await putNode(G, "t3", { id: "t3", loadout: "superuser" });
    expect(await resolveLoadoutFromTask(redis as any, G, "t3")).toBe("minimal");
  });
});

describe("resolveCapabilityFromTask", () => {
  it("returns the node's capability when present", async () => {
    const cap: Capability = { mcp: ["set_status", "heartbeat"], harness: [], suppressMemory: true };
    await putNode(G, "c1", { id: "c1", capability: cap });
    const result = await resolveCapabilityFromTask(redis as any, G, "c1");
    expect(result).toEqual(cap);
  });

  it("returns undefined when the node has no capability field", async () => {
    await putNode(G, "c2", { id: "c2", loadout: "minimal" });
    expect(await resolveCapabilityFromTask(redis as any, G, "c2")).toBeUndefined();
  });

  it("returns undefined when the node is missing from Redis", async () => {
    expect(await resolveCapabilityFromTask(redis as any, G, "no-such-task")).toBeUndefined();
  });

  it("returns undefined when the capability field is not a valid object", async () => {
    await putNode(G, "c3", { id: "c3", capability: "not-an-object" });
    expect(await resolveCapabilityFromTask(redis as any, G, "c3")).toBeUndefined();
  });

  it("returns undefined when graphId or taskId is missing", async () => {
    expect(await resolveCapabilityFromTask(redis as any, undefined, "t")).toBeUndefined();
    expect(await resolveCapabilityFromTask(redis as any, G, undefined)).toBeUndefined();
  });
});
