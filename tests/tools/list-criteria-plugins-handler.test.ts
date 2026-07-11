/**
 * Tests for list_criteria_plugins MCP tool handler (src/tools/list-criteria-plugins.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { registerListCriteriaPlugins } from "../../src/tools/list-criteria-plugins.js";

vi.mock("../../src/criterion-engine.js", () => ({
  CriterionEngine: vi.fn().mockImplementation(function (this: any) {
    this.listPlugins = vi.fn().mockResolvedValue([]);
  }),
}));

import { CriterionEngine } from "../../src/criterion-engine.js";

function buildHandler(plugins: object[] = []) {
  const MockEngine = CriterionEngine as unknown as ReturnType<typeof vi.fn>;
  MockEngine.mockImplementation(function (this: any) {
    this.listPlugins = vi.fn().mockResolvedValue(plugins);
  });

  let handler: (args: Record<string, never>) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  registerListCriteriaPlugins(mockServer, "/fake/plugins");
  return { handler: handler! };
}

describe("list_criteria_plugins handler", () => {
  it("returns 'no plugins found' message when list is empty", async () => {
    const { handler } = buildHandler([]);

    const result = await handler({});

    expect(result.content[0].text).toContain("No criteria plugins found");
  });

  it("formats a single plugin with name, version, description, tags, and inputs", async () => {
    const { handler } = buildHandler([{
      name: "test-coverage",
      version: "1.0.0",
      description: "Checks test coverage thresholds",
      tags: ["testing", "quality"],
      inputs: {
        threshold: { description: "Coverage threshold", required: true },
        report: { description: "Report file path" },
      },
    }]);

    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain("**test-coverage**");
    expect(text).toContain("v1.0.0");
    expect(text).toContain("Checks test coverage thresholds");
    expect(text).toContain("testing");
    expect(text).toContain("quality");
    expect(text).toContain("threshold (required)");
    expect(text).toContain("report:");
  });

  it("renders multiple plugins separated by blank lines", async () => {
    const { handler } = buildHandler([
      { name: "plugin-a", version: "1.0.0", description: "A", tags: [], inputs: {} },
      { name: "plugin-b", version: "2.0.0", description: "B", tags: [], inputs: {} },
    ]);

    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain("**plugin-a**");
    expect(text).toContain("**plugin-b**");
    expect(text.indexOf("**plugin-a**")).toBeLessThan(text.indexOf("**plugin-b**"));
  });

  it("shows (none) for inputs when plugin has no inputs", async () => {
    const { handler } = buildHandler([{
      name: "simple", version: "1.0.0", description: "Simple", tags: [], inputs: {},
    }]);

    const result = await handler({});

    expect(result.content[0].text).toContain("Inputs: (none)");
  });
});
