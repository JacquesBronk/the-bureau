import { describe, it, expect } from "vitest";
import { resolveProjectFromTask } from "../../src/runtime/auth/loadout-resolver.js";

function fakeRedis(map: Record<string, string>) {
  return { get: async (k: string) => map[k] ?? null } as unknown as Parameters<typeof resolveProjectFromTask>[0];
}

describe("resolveProjectFromTask", () => {
  it("returns the task node's project", async () => {
    const redis = fakeRedis({ "graph:g1:tasks:t1": JSON.stringify({ project: "acme" }) });
    expect(await resolveProjectFromTask(redis, "g1", "t1")).toBe("acme");
  });
  it("returns undefined when the node or project is absent", async () => {
    expect(await resolveProjectFromTask(fakeRedis({}), "g1", "t1")).toBeUndefined();
    const redis = fakeRedis({ "graph:g1:tasks:t1": JSON.stringify({}) });
    expect(await resolveProjectFromTask(redis, "g1", "t1")).toBeUndefined();
  });
  it("returns undefined without graphId/taskId", async () => {
    expect(await resolveProjectFromTask(fakeRedis({}), undefined, undefined)).toBeUndefined();
  });
});
