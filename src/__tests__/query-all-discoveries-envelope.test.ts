import { describe, it, expect, vi } from "vitest";
import { buildQueryAllDiscoveriesHandler } from "../tools/query-all-discoveries.js";
import type { DiscoveryWithGraph } from "../types/workspace.js";

/** Split a tool text response on the '---' envelope separator and parse the JSON tail. */
function parseEnvelope(text: string): { human: string; json: unknown } {
  const idx = text.indexOf("\n---\n");
  expect(idx).toBeGreaterThanOrEqual(0);
  return { human: text.slice(0, idx), json: JSON.parse(text.slice(idx + 5)) };
}

function buildMockStore(discoveries: DiscoveryWithGraph[] = []) {
  return {
    queryAllDiscoveries: vi.fn().mockResolvedValue(discoveries),
  } as any;
}

describe("query_all_discoveries envelope (#310)", () => {
  it("returns structured empty discoveries when none exist", async () => {
    const store = buildMockStore([]);
    const handler = buildQueryAllDiscoveriesHandler(store);

    const result = await handler({});
    const text = result.content[0].text;

    const { json } = parseEnvelope(text);
    expect(json).toEqual({ discoveries: [] });
    expect(text).toMatch(/No discoveries found across all graphs/);
  });

  it("returns structured empty discoveries with filter description when topic filter applies", async () => {
    const store = buildMockStore([]);
    const handler = buildQueryAllDiscoveriesHandler(store);

    const result = await handler({ topic: "auth" });
    const { human, json } = parseEnvelope(result.content[0].text);

    expect(human).toMatch(/No discoveries found matching topic="auth" across all graphs/);
    expect(json).toEqual({ discoveries: [] });
  });

  it("returns human text and JSON discoveries array including graphId", async () => {
    const ts = new Date("2026-06-21T10:00:00Z").getTime();
    const discovery: DiscoveryWithGraph = {
      id: "1234-0",
      taskId: "task-a",
      role: "coder",
      topic: "schema-change",
      content: "Renamed users table to accounts",
      files: ["src/db/schema.ts"],
      scope: "graph",
      timestamp: ts,
      graphId: "graph-42",
    };
    const store = buildMockStore([discovery]);
    const handler = buildQueryAllDiscoveriesHandler(store);

    const result = await handler({});
    const { human, json } = parseEnvelope(result.content[0].text);

    expect(human).toMatch(/1 discovery\(ies\) found across all graphs/);
    expect(human).toMatch(/schema-change/);
    expect(human).toMatch(/graph-42/);
    expect(human).toMatch(/Renamed users table to accounts/);
    expect(json).toEqual({ discoveries: [discovery] });
  });

  it("passes topic filter to discoveryStore.queryAllDiscoveries", async () => {
    const store = buildMockStore([]);
    const handler = buildQueryAllDiscoveriesHandler(store);

    await handler({ topic: "redis" });

    expect(store.queryAllDiscoveries).toHaveBeenCalledWith({ topic: "redis" });
  });

  it("passes undefined topic when no filter provided", async () => {
    const store = buildMockStore([]);
    const handler = buildQueryAllDiscoveriesHandler(store);

    await handler({});

    expect(store.queryAllDiscoveries).toHaveBeenCalledWith({ topic: undefined });
  });
});
