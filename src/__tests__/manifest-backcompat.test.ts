import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadAgentManifest, resolveCapability } from "../runtime/resolve-agent.js";

const AGENTS_DIR = resolve(__dirname, "../../agents");

describe("manifest-backcompat: frontmatter scan produces same capability surface", () => {
  it("all curated agents resolve to their expected template", () => {
    const manifest = loadAgentManifest(AGENTS_DIR);
    const curated = manifest.agents.filter((a) => a.provenance === "curated");
    expect(curated.length).toBeGreaterThan(20); // sanity: we have all the core agents

    const surface: Record<string, unknown> = {};
    for (const agent of curated) {
      surface[agent.id] = resolveCapability(AGENTS_DIR, manifest, agent.id);
    }
    expect(surface).toMatchSnapshot();
  });

  it("loadAgentManifest returns providers from agents.json", () => {
    const manifest = loadAgentManifest(AGENTS_DIR);
    expect(manifest.providers).toBeDefined();
    expect(manifest.providers!["local-qwen"]).toBeDefined();
    expect(manifest.providers!["anthropic"]).toBeDefined();
  });

  it("dynamic dir agents have provenance dynamic", () => {
    const manifest = loadAgentManifest(AGENTS_DIR);
    const dynamic = manifest.agents.filter((a) => a.provenance === "dynamic");
    // dynamic/ dir may be empty in CI but must not throw
    for (const a of dynamic) {
      expect(a.provenance).toBe("dynamic");
      expect(a.id).toBeTruthy();
    }
  });

  it("nano-example.md appears as dynamic provenance", () => {
    const manifest = loadAgentManifest(AGENTS_DIR);
    const nano = manifest.agents.find((a) => a.id === "nano-example");
    expect(nano, "nano-example.md must exist in agents/dynamic/").toBeDefined();
    expect(nano!.provenance).toBe("dynamic");
    expect(nano!.profile).toBe("nano"); // profile field derived from template frontmatter key
  });
});
