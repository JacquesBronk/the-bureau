import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { buildBureauDiscover } from "../../src/tools/bureau-discover.js";
import { PROFILE_TOOLS } from "../../src/mcp-profiles.js";

const AGENTS_DIR = resolve(__dirname, "../../agents");
const PLUGINS_DIR = resolve(__dirname, "../../plugins/criteria");

function fakeDeps() {
  const scan = vi.fn().mockResolvedValue(["0", ["graph:g1", "graph:g2"]]);
  const redis: any = {
    ping: vi.fn().mockResolvedValue("PONG"),
    scan,
    get: vi.fn().mockImplementation(async (k: string) =>
      JSON.stringify({ status: k === "graph:g1" ? "active" : "completed", project: "secret-proj" })),
  };
  const registry: any = { listPeers: vi.fn().mockResolvedValue([{ id: "a" }]) };
  const skillCatalog: any = {
    listSkills: () => [{ id: "example", name: "example", version: "0.1.0", description: "d", fileCount: 1 }],
  };
  // Inject models so the unit test never touches the network (agents.json has a
  // real gateway provider; the default handler would fetch it). See BureauDiscoverDeps.
  const listModels = vi.fn().mockResolvedValue({
    provider: "local-qwen", baseUrl: "http://x", models: [{ name: "qwen2.5-coder:14b", maxTokens: 65000 }],
  });
  return { deps: { agentsDir: AGENTS_DIR, pluginsDir: PLUGINS_DIR, redis, registry, skillCatalog, listModels }, scan, listModels };
}

describe("buildBureauDiscover", () => {
  it("returns a curated map with all sections and a nextSteps hint", async () => {
    const { deps } = fakeDeps();
    const out = await buildBureauDiscover(deps)();
    expect(out.templates.length).toBeGreaterThan(0);
    expect(out.agents.length).toBeGreaterThan(0);
    // criteria non-vacuous: plugins/criteria ships typecheck-workspace
    expect(out.criteria.map((c) => c.name)).toContain("typecheck-workspace");
    expect(out.models.length).toBeGreaterThan(0); // from the injected stub, not the network
    expect(out.skills.map((s) => s.id)).toContain("example");
    expect(out.health.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof out.nextSteps).toBe("string");
  });

  it("uses the injected listModels — no network call", async () => {
    const { deps, listModels } = fakeDeps();
    await buildBureauDiscover(deps)();
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("exposes activeGraphs as a count and leaks no graphId/project", async () => {
    const { deps } = fakeDeps();
    const out = await buildBureauDiscover(deps)();
    expect(out.activeGraphs).toBe(1);
    expect(JSON.stringify(out)).not.toContain("secret-proj");
    expect(JSON.stringify(out)).not.toContain("g1");
  });

  it("makes a single graph:* pass (no second pass via list_graphs)", async () => {
    // The mock returns the whole keyspace in one cursor batch, so 1 redis.scan
    // call == 1 scanKeys pass. A regression that also called list_graphs would
    // scan a second time (== 2). This distinguishes 1-pass from 2-pass.
    const { deps, scan } = fakeDeps();
    await buildBureauDiscover(deps)();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("degrades a failing section without failing the whole call", async () => {
    const { deps } = fakeDeps();
    deps.registry.listPeers = vi.fn().mockRejectedValue(new Error("registry down"));
    const out = await buildBureauDiscover(deps)();
    // health degraded but the map still returns other sections
    expect(out.templates.length).toBeGreaterThan(0);
  });

  it("is not exposed to restricted profiles (full-only)", () => {
    for (const p of ["minimal", "coordinator", "operator"] as const) {
      const set = PROFILE_TOOLS[p];
      if (set) expect([...set]).not.toContain("bureau_discover");
    }
  });
});
