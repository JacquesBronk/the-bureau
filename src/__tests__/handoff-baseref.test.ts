import { describe, it, expect } from "vitest";
import { integrationBranchName, resolveHandoffBaseRef } from "../spawn/integration-branch.js";

const GID = "abcdef1234567890"; // slice(0,8) => "abcdef12"
const INTEG = "bureau/abcdef12/integration";

describe("integrationBranchName", () => {
  it("derives the branch from the first 8 chars of the graph id", () => {
    expect(integrationBranchName(GID)).toBe(INTEG);
  });
});

describe("resolveHandoffBaseRef", () => {
  const base = { isK8s: true, hasGitDestination: true, graphId: GID };

  it("returns the integration branch for a pod-mode task WITH deps", () => {
    const r = resolveHandoffBaseRef({ ...base, task: { id: "impl2", dependsOn: ["impl1"] } });
    expect(r).toBe(INTEG);
  });

  it("returns undefined for a no-dep task (clones base ref)", () => {
    expect(resolveHandoffBaseRef({ ...base, task: { id: "impl1", dependsOn: [] } })).toBeUndefined();
    expect(resolveHandoffBaseRef({ ...base, task: { id: "impl1" } })).toBeUndefined();
  });

  it("honors an explicit gitBaseRef (criterion / merge-coordinator tasks)", () => {
    const r = resolveHandoffBaseRef({
      ...base,
      task: { id: "criterion-x", dependsOn: ["impl1"], gitBaseRef: "bureau/abcdef12/conflict-impl1" },
    });
    expect(r).toBe("bureau/abcdef12/conflict-impl1");
  });

  it("returns undefined for exec-mode pods (no git work)", () => {
    const r = resolveHandoffBaseRef({ ...base, task: { id: "criterion-y", dependsOn: ["impl1"], execMode: true } });
    expect(r).toBeUndefined();
  });

  it("returns undefined for merge-coordinator tasks", () => {
    const r = resolveHandoffBaseRef({ ...base, task: { id: "merge-impl1", dependsOn: ["impl1"] } });
    expect(r).toBeUndefined();
  });

  it("returns undefined when not k8s (local/stdio mode)", () => {
    const r = resolveHandoffBaseRef({ ...base, isK8s: false, task: { id: "impl2", dependsOn: ["impl1"] } });
    expect(r).toBeUndefined();
  });

  it("returns undefined when the graph has no git destination", () => {
    const r = resolveHandoffBaseRef({ ...base, hasGitDestination: false, task: { id: "impl2", dependsOn: ["impl1"] } });
    expect(r).toBeUndefined();
  });
});
