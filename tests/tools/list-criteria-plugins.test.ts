import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildListCriteriaPlugins } from "../../src/tools/list-criteria-plugins.js";

const PLUGINS_DIR = resolve(__dirname, "../../plugins/criteria");

describe("buildListCriteriaPlugins", () => {
  it("returns typed plugin rows (name+version), not a text envelope", async () => {
    const rows = await buildListCriteriaPlugins(PLUGINS_DIR);
    expect(rows.length).toBeGreaterThan(0); // non-vacuous: plugins/criteria ships typecheck-workspace
    expect(rows.map((r) => r.name)).toContain("typecheck-workspace");
    for (const r of rows) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.version).toBe("string");
    }
  });
});
