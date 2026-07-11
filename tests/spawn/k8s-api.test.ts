import { describe, it, expect } from "vitest";
import { isInCluster } from "../../src/spawn/k8s-api.js";

describe("isInCluster", () => {
  it("true when KUBERNETES_SERVICE_HOST is set", () => {
    expect(isInCluster({ KUBERNETES_SERVICE_HOST: "10.0.0.1" } as any)).toBe(true);
  });
  it("false when neither the env nor the SA token file signal is present", () => {
    expect(isInCluster({} as any, "/nonexistent/path/token")).toBe(false);
  });
});
