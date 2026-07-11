import { describe, it, expect } from "vitest";
import { findSiblingFileOverlaps, formatSiblingOverlapWarning } from "../workspace/sibling-overlap.js";
import type { TaskNodeInput } from "../types/graph.js";

function task(o: Partial<TaskNodeInput> & { id: string }): TaskNodeInput {
  return { role: "coder", task: "do stuff", ...o };
}

describe("findSiblingFileOverlaps", () => {
  it("1. two independent tasks editing the same file (exact) → one finding naming both ids + the file", () => {
    const tasks = [
      task({ id: "a", task: "Edit `src/foo/analytics.ts` to add a metric" }),
      task({ id: "b", task: "Edit `src/foo/analytics.ts` to fix a bug" }),
    ];
    const overlaps = findSiblingFileOverlaps(tasks);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].a).toBe("a");
    expect(overlaps[0].b).toBe("b");
    expect(overlaps[0].exact).toEqual(["src/foo/analytics.ts"]);
    expect(overlaps[0].dir).toEqual([]);
  });

  it("2. two independent tasks editing different files in the SAME directory → one finding via dir", () => {
    const tasks = [
      task({ id: "a", task: "Edit `src/foo/analytics.ts` to add a metric" }),
      task({ id: "b", task: "Edit `src/foo/reporter.ts` to add logging" }),
    ];
    const overlaps = findSiblingFileOverlaps(tasks);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].exact).toEqual([]);
    expect(overlaps[0].dir.sort()).toEqual(["src/foo/analytics.ts", "src/foo/reporter.ts"]);
  });

  it("3. two independent tasks with disjoint files → no findings", () => {
    const tasks = [
      task({ id: "a", task: "Edit `src/foo/analytics.ts` to add a metric" }),
      task({ id: "b", task: "Edit `src/bar/other.ts` to add logging" }),
    ];
    expect(findSiblingFileOverlaps(tasks)).toEqual([]);
  });

  it("4. A→B chain editing the same file (B dependsOn A) → NO finding (sequenced, not parallel)", () => {
    const tasks = [
      task({ id: "a", task: "Edit `src/foo/analytics.ts` to add a metric" }),
      task({ id: "b", task: "Edit `src/foo/analytics.ts` to fix a bug", dependsOn: ["a"] }),
    ];
    expect(findSiblingFileOverlaps(tasks)).toEqual([]);
  });

  it("5. A→B→C transitive: A and C edit the same file; C dependsOn B, B dependsOn A → NO finding", () => {
    const tasks = [
      task({ id: "a", task: "Edit `src/foo/analytics.ts` to add a metric" }),
      task({ id: "b", task: "Edit `src/bar/unrelated.ts` to add logging", dependsOn: ["a"] }),
      task({ id: "c", task: "Edit `src/foo/analytics.ts` to add more", dependsOn: ["b"] }),
    ];
    expect(findSiblingFileOverlaps(tasks)).toEqual([]);
  });

  it("6. diamond A→B, A→C where B and C edit the same file and neither depends on the other → ONE finding (B,C)", () => {
    const tasks = [
      task({ id: "a", task: "Edit `src/base/setup.ts` to scaffold" }),
      task({ id: "b", task: "Edit `src/foo/analytics.ts` to add a metric", dependsOn: ["a"] }),
      task({ id: "c", task: "Edit `src/foo/analytics.ts` to fix a bug", dependsOn: ["a"] }),
    ];
    const overlaps = findSiblingFileOverlaps(tasks);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].a).toBe("b");
    expect(overlaps[0].b).toBe("c");
    expect(overlaps[0].exact).toEqual(["src/foo/analytics.ts"]);
  });

  it("7. a dependsOn referencing a nonexistent id → ignored, no crash, correct result", () => {
    const tasks = [
      task({ id: "a", task: "Edit `src/foo/analytics.ts` to add a metric", dependsOn: ["ghost"] }),
      task({ id: "b", task: "Edit `src/foo/analytics.ts` to fix a bug" }),
    ];
    expect(() => findSiblingFileOverlaps(tasks)).not.toThrow();
    const overlaps = findSiblingFileOverlaps(tasks);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].a).toBe("a");
    expect(overlaps[0].b).toBe("b");
    expect(overlaps[0].exact).toEqual(["src/foo/analytics.ts"]);
  });

  it("8. three independent tasks all editing the same file → 3 pair findings", () => {
    const tasks = [
      task({ id: "a", task: "Edit `src/foo/analytics.ts` to add a metric" }),
      task({ id: "b", task: "Edit `src/foo/analytics.ts` to fix a bug" }),
      task({ id: "c", task: "Edit `src/foo/analytics.ts` to add docs" }),
    ];
    const overlaps = findSiblingFileOverlaps(tasks);
    expect(overlaps).toHaveLength(3);
    const pairs = overlaps.map((o) => `${o.a}-${o.b}`).sort();
    expect(pairs).toEqual(["a-b", "a-c", "b-c"]);
    for (const o of overlaps) {
      expect(o.exact).toEqual(["src/foo/analytics.ts"]);
    }
  });
});

describe("formatSiblingOverlapWarning", () => {
  it("9. returns empty string for an empty array", () => {
    expect(formatSiblingOverlapWarning([])).toBe("");
  });

  it("10. non-empty overlaps produce a string containing both task ids, the file, and a remedy hint", () => {
    const overlaps = findSiblingFileOverlaps([
      task({ id: "alpha", task: "Edit `src/foo/analytics.ts` to add a metric" }),
      task({ id: "beta", task: "Edit `src/foo/analytics.ts` to fix a bug" }),
    ]);
    const warning = formatSiblingOverlapWarning(overlaps);
    expect(warning).toContain("alpha");
    expect(warning).toContain("beta");
    expect(warning).toContain("src/foo/analytics.ts");
    expect(warning).toMatch(/dependsOn|merge/);
  });
});
