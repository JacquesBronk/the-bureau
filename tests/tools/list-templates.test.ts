import { describe, it, expect } from "vitest";
import { buildListTemplates } from "../../src/tools/list-templates.js";

describe("buildListTemplates", () => {
  it("returns one summary row per template with a numeric taskCount", () => {
    const rows = buildListTemplates();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.taskCount).toBe("number");
    }
  });
});
