import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadAgentManifest } from "../runtime/resolve-agent.js";

const REAL_AGENTS_DIR = resolve(__dirname, "../../agents");

// Helpers
function tmpAgentsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bureau-refresh-agents-"));
  mkdirSync(resolve(dir, "dynamic"), { recursive: true });
  // Write a minimal agents.json so providers resolve
  writeFileSync(resolve(dir, "agents.json"), JSON.stringify({ version: "2.0.0", providers: {}, runtimes: {} }), "utf-8");
  return dir;
}

function join(...parts: string[]) { return resolve(...parts); }

function writeMd(dir: string, subpath: string, content: string) {
  const fullPath = resolve(dir, subpath);
  mkdirSync(resolve(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

const MINIMAL_FM = (id: string) => `---
id: ${id}
name: ${id}
description: Test ${id}
category: research
tags: []
model: haiku
effort: low
template: minimal
---
# ${id}
`;

describe("refresh_agents / loadAgentManifest scan", () => {
  let dir: string;

  beforeEach(() => { dir = tmpAgentsDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns curated agents from top-level .md files", () => {
    writeMd(dir, "analyst.md", MINIMAL_FM("analyst"));
    const manifest = loadAgentManifest(dir);
    const agent = manifest.agents.find((a) => a.id === "analyst");
    expect(agent).toBeDefined();
    expect(agent!.provenance).toBe("curated");
    expect(agent!.sourceFile).toBe("analyst.md");
  });

  it("returns dynamic agents from dynamic/ with provenance=dynamic", () => {
    writeMd(dir, "dynamic/custom-bot.md", MINIMAL_FM("custom-bot"));
    const manifest = loadAgentManifest(dir);
    const agent = manifest.agents.find((a) => a.id === "custom-bot");
    expect(agent).toBeDefined();
    expect(agent!.provenance).toBe("dynamic");
    expect(agent!.sourceFile).toBe("dynamic/custom-bot.md");
  });

  it("does not include non-.md files", () => {
    writeMd(dir, "readme.txt", "not an agent");
    const manifest = loadAgentManifest(dir);
    expect(manifest.agents.find((a) => a.id === "readme")).toBeUndefined();
  });

  it("handles an empty agents dir gracefully", () => {
    const manifest = loadAgentManifest(dir);
    expect(manifest.agents).toEqual([]);
  });

  it("handles missing dynamic/ dir gracefully", () => {
    rmSync(resolve(dir, "dynamic"), { recursive: true, force: true });
    writeMd(dir, "solo.md", MINIMAL_FM("solo"));
    const manifest = loadAgentManifest(dir);
    expect(manifest.agents.length).toBe(1);
    expect(manifest.agents[0].id).toBe("solo");
  });
});

describe("real agents dir — provenance coverage", () => {
  it("all real curated agents have provenance=curated", () => {
    const manifest = loadAgentManifest(REAL_AGENTS_DIR);
    const curated = manifest.agents.filter((a) => a.provenance === "curated");
    expect(curated.length).toBeGreaterThan(20);
    for (const a of curated) {
      expect(a.sourceFile).toMatch(/^[^/]+\.md$/); // top-level, no subdirs
    }
  });
});
