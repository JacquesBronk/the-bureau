import { describe, it, expect } from "vitest";
import { resolveSurfaceArgs } from "../../src/runtime/http-transport.js";

describe("initialize path forwards project to buildSurface", () => {
  it("passes the preResolveProject result as the third buildSurface arg", async () => {
    const deps = {
      preResolveCapability: async () => ({ mcp: ["x"], harness: "*", suppressMemory: false }),
      preResolveProject: async () => "acme",
    } as any;
    const { capability, project } = await resolveSurfaceArgs(deps, {});
    expect(project).toBe("acme");
    expect((capability as any)?.mcp).toEqual(["x"]);
  });

  it("degrades to undefined when preResolveProject throws (P4)", async () => {
    const deps = {
      preResolveCapability: async () => ({ mcp: ["x"], harness: "*", suppressMemory: false }),
      preResolveProject: async () => { throw new Error("boom"); },
    } as any;
    const { capability, project } = await resolveSurfaceArgs(deps, {});
    expect(project).toBeUndefined();
    expect((capability as any)?.mcp).toEqual(["x"]);
  });

  it("degrades to undefined when preResolveCapability throws (existing pattern preserved)", async () => {
    const deps = {
      preResolveCapability: async () => { throw new Error("boom"); },
      preResolveProject: async () => "acme",
    } as any;
    const { capability, project } = await resolveSurfaceArgs(deps, {});
    expect(capability).toBeUndefined();
    expect(project).toBe("acme");
  });

  it("returns undefined for both when no resolvers are provided", async () => {
    const { capability, project } = await resolveSurfaceArgs({}, {});
    expect(capability).toBeUndefined();
    expect(project).toBeUndefined();
  });
});
