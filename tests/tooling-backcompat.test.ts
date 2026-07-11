// tests/tooling-backcompat.test.ts
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { resolveCapability, loadAgentManifest } from "../src/runtime/resolve-agent.js";
import { resolveTemplate } from "../src/runtime/capability.js";

const DIR = resolve(__dirname, "../agents");
const manifest = loadAgentManifest(DIR);

// Covers the mcp axis. Harness and suppressMemory axes are checked in tests/graph-dispatch-capability.test.ts.
describe("back-compat: capability mcp == legacy profile set", () => {
  it("each agent resolves to its profile's mcp surface", () => {
    for (const a of manifest.agents) {
      const cap = resolveCapability(DIR, manifest, a.id);
      const expected = resolveTemplate(a.profile);
      expect(cap.mcp, `${a.id}`).toEqual(expected.mcp);
    }
  });
});
