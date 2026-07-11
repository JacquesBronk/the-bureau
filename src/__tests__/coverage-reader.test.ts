import { describe, it, expect } from "vitest";
import { makeValidationPodLogReader } from "../coverage/pod-log-reader.js";
import { graphPodSelector } from "../spawn/k8s-manifest.js";

const base = {
  listPodNamesByLabel: async (_ns: string, sel: string) => {
    expect(sel).toBe(graphPodSelector("child-1"));
    return ["bureau-child1-crit-abc"];
  },
  readPodLog: async (_ns: string, name: string, opts: any) => {
    expect(name).toBe("bureau-child1-crit-abc");
    expect(opts.container).toBe("agent");
    return "uncovered: [E-03]\n";
  },
} as any;

describe("validation pod-log reader", () => {
  it("resolves the pod by label and reads the agent container", async () => {
    const read = makeValidationPodLogReader(base, "bureau");
    expect(await read("child-1")).toContain("uncovered: [E-03]");
  });
  it("returns undefined when no pod matches", async () => {
    const read = makeValidationPodLogReader({ ...base, listPodNamesByLabel: async () => [] }, "bureau");
    expect(await read("child-1")).toBeUndefined();
  });
  it("returns undefined (not throw) when the api errors", async () => {
    const read = makeValidationPodLogReader({ ...base, listPodNamesByLabel: async () => { throw new Error("x"); } }, "bureau");
    await expect(read("child-1")).resolves.toBeUndefined();
  });
});
