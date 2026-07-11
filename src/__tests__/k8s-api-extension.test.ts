import { describe, it, expect } from "vitest";
import type { K8sApi } from "../spawn/k8s-api.js";
import { buildPodLogMethods } from "../spawn/k8s-api.js";

describe("K8sApi interface", () => {
  it("has createPod, readPodPhase, deletePod, createService, deleteService, listPodNamesByLabel, readPodLog", () => {
    // Compile-time check: a mock that fully implements the interface.
    const _mock: K8sApi = {
      createJob: async () => {},
      readJobStatus: async () => null,
      deleteJob: async () => {},
      createSecret: async () => {},
      deleteSecret: async () => {},
      createPod: async () => {},
      readPodPhase: async () => null,
      deletePod: async () => {},
      createService: async () => {},
      deleteService: async () => {},
      listPodNamesByLabel: async () => [],
      readPodLog: async () => "",
    };
    expect(_mock).toBeDefined();
  });
});

describe("K8sApi pod-log methods (#306)", () => {
  it("listPodNamesByLabel returns pod names for a selector", async () => {
    const core = {
      listNamespacedPod: async (req: any) => {
        expect(req.namespace).toBe("bureau");
        expect(req.labelSelector).toBe("bureau/graph=g1");
        return { items: [{ metadata: { name: "bureau-g1-t1-abc" } }, { metadata: {} }] };
      },
    };
    const api = buildPodLogMethods(core as any);
    expect(await api.listPodNamesByLabel("bureau", "bureau/graph=g1")).toEqual(["bureau-g1-t1-abc"]);
  });

  it("readPodLog passes container and tailLines", async () => {
    const core = {
      readNamespacedPodLog: async (req: any) => {
        expect(req).toMatchObject({ name: "p1", namespace: "bureau", container: "agent", tailLines: 50 });
        return "uncovered: [E-03]\n";
      },
    };
    const api = buildPodLogMethods(core as any);
    expect(await api.readPodLog("bureau", "p1", { container: "agent", tailLines: 50 })).toContain("uncovered: [E-03]");
  });

  it("readPodLog omits tailLines when not provided", async () => {
    const core = {
      readNamespacedPodLog: async (req: any) => {
        expect(req).toMatchObject({ name: "p1", namespace: "bureau", container: "agent" });
        expect("tailLines" in req).toBe(false);
        return "log";
      },
    };
    const api = buildPodLogMethods(core as any);
    expect(await api.readPodLog("bureau", "p1", { container: "agent" })).toBe("log");
  });
});
