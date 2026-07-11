import { describe, it, expect } from "vitest";
import { buildK8sLaunchSpec } from "../spawn/k8s-dispatch.js";

const baseCfg = {
  workerImage: "img/default:latest",
  engineUrl: "http://engine/mcp",
  gitUrl: "https://git/repo.git",
  gitBaseRef: "main",
  gitTokenSecret: "bureau-git",
};
const baseParams = {
  cfg: baseCfg as any,
  identity: { sessionId: "s", taskId: "t", graphId: "g", role: "coder" },
  loadout: "minimal" as any,
  tokenValue: "tok",
};

describe("buildK8sLaunchSpec image selection", () => {
  it("uses the resolved image when provided", () => {
    const spec = buildK8sLaunchSpec({ ...baseParams, image: "img/python:latest" });
    expect(spec.image).toBe("img/python:latest");
  });
  it("falls back to cfg.workerImage when image is omitted (back-compat)", () => {
    const spec = buildK8sLaunchSpec({ ...baseParams });
    expect(spec.image).toBe("img/default:latest");
  });
});
