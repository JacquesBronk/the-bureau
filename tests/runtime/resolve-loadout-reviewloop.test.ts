import { describe, it, expect } from "vitest";
import { resolveTaskLoadout } from "../../src/runtime/resolve-loadout.js";
import { lintPlan } from "../../src/tools/dry-run.js";
import type { AgentManifest } from "../../src/types/agent.js";
import type { Toolchain } from "../../src/spawn/toolchain-registry.js";
import type { TaskNodeInput } from "../../src/types/graph.js";

// #330: reviewLoop reject is unreachable in pod mode — minimal-profile reviewers have
// no reject_task tool, so a REJECT verdict cannot block promotion. resolveTaskLoadout
// is the single seam shared by dispatch and dry-run, so injecting reject_task here
// reaches both the real worker token/allowlist and the dry-run TaskPlan.

function manifest(agents: Array<{ id: string; profile?: string }>): AgentManifest {
  return {
    version: "2.0.0",
    agents: agents.map((a) => ({
      id: a.id, name: a.id, description: "", category: "general", tags: [],
      model: "sonnet", effort: "medium", profile: a.profile ?? "minimal",
      file: "", provenance: "curated", sourceFile: "",
    })),
    runtimes: undefined, providers: undefined,
  };
}
const registry: Toolchain[] = [{ name: "node", image: "registry.local/node:1", isDefault: true }];
const base = { agentsDir: "/nonexistent", toolchainRegistry: registry, hostEnv: {} as NodeJS.ProcessEnv };

const reviewLoop = { maxIterations: 3, fixerRole: "coder", canReject: ["impl-1"] };

function task(o: Partial<TaskNodeInput> & { id: string; role: string }): TaskNodeInput {
  return { task: "do it", ...o };
}

describe("resolveTaskLoadout — reviewLoop reject_task injection (#330)", () => {
  it("adds reject_task to a minimal-profile role's resolved mcp when the task carries reviewLoop", () => {
    const p = resolveTaskLoadout({
      task: task({ id: "review-1", role: "reviewer", reviewLoop }),
      manifest: manifest([{ id: "reviewer", profile: "minimal" }]),
      ...base,
    });
    expect(p.mcp).not.toBe("*");
    expect(p.mcp as string[]).toContain("reject_task");
  });

  it("does not add reject_task when the task has no reviewLoop", () => {
    const p = resolveTaskLoadout({
      task: task({ id: "impl-1", role: "reviewer" }),
      manifest: manifest([{ id: "reviewer", profile: "minimal" }]),
      ...base,
    });
    expect(p.mcp as string[]).not.toContain("reject_task");
  });

  it("a coordinator role with reviewLoop ends up with reject_task exactly once", () => {
    const p = resolveTaskLoadout({
      task: task({ id: "review-1", role: "lead", reviewLoop }),
      manifest: manifest([{ id: "lead", profile: "coordinator" }]),
      ...base,
    });
    const mcp = p.mcp as string[];
    expect(mcp.filter((t) => t === "reject_task")).toHaveLength(1);
  });

  it("dry-run lint fires reviewloop-no-reject only when injection is defeated", () => {
    const inputs: TaskNodeInput[] = [task({ id: "review-1", role: "reviewer", reviewLoop })];

    // Injection present (real resolver): no warning.
    const okPlan = resolveTaskLoadout({ task: inputs[0], manifest: manifest([{ id: "reviewer", profile: "minimal" }]), ...base });
    expect(lintPlan(inputs, [okPlan]).some((f) => f.code === "reviewloop-no-reject")).toBe(false);

    // Simulate the injection being defeated (a future regression): the resolved plan's
    // mcp lacks reject_task despite reviewLoop being set.
    const brokenPlan = { ...okPlan, mcp: (okPlan.mcp as string[]).filter((t) => t !== "reject_task") };
    const findings = lintPlan(inputs, [brokenPlan]);
    const finding = findings.find((f) => f.code === "reviewloop-no-reject");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });
});
