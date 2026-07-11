import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildListAgents } from "../../src/tools/list-agents.js";

const AGENTS_DIR = resolve(__dirname, "../../agents");

describe("buildListAgents", () => {
  it("returns every agent as a summary row keyed by role", () => {
    const rows = buildListAgents(AGENTS_DIR);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("role");
    expect(rows[0]).toHaveProperty("category");
  });

  it("filters by category when given", () => {
    const all = buildListAgents(AGENTS_DIR);
    const planning = buildListAgents(AGENTS_DIR, "planning");
    expect(planning.length).toBeGreaterThan(0);
    expect(planning.length).toBeLessThanOrEqual(all.length);
    expect(planning.every((r) => r.category === "planning")).toBe(true);
  });
});
