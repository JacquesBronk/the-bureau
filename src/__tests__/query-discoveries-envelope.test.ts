import { describe, it, expect, vi } from "vitest";
import { buildQueryDiscoveriesHandler } from "../tools/query-discoveries.js";
import type { Discovery } from "../types/workspace.js";

/** Split a tool text response on the '---' envelope separator and parse the JSON tail. */
function parseEnvelope(text: string): { human: string; json: unknown } {
  const idx = text.indexOf("\n---\n");
  expect(idx).toBeGreaterThanOrEqual(0);
  return { human: text.slice(0, idx), json: JSON.parse(text.slice(idx + 5)) };
}

const GRAPH_ID = "test-graph-1";

function buildMocks(discoveries: Discovery[] = []) {
  const discoveryStore = {
    queryDiscoveries: vi.fn().mockResolvedValue(discoveries),
  } as any;
  const getContext = vi.fn().mockReturnValue({ graphId: GRAPH_ID });
  return { discoveryStore, getContext };
}

const EXTRA = {};

describe("query_discoveries envelope (#310)", () => {
  it("returns structured empty discoveries when none exist", async () => {
    const { discoveryStore, getContext } = buildMocks([]);
    const handler = buildQueryDiscoveriesHandler(discoveryStore, getContext);

    const result = await handler({}, EXTRA);
    const text = result.content[0].text;

    const { json } = parseEnvelope(text);
    expect(json).toEqual({ discoveries: [] });
    expect(text).toMatch(/No discoveries found/);
  });

  it("returns structured empty discoveries with filter description when filters apply", async () => {
    const { discoveryStore, getContext } = buildMocks([]);
    const handler = buildQueryDiscoveriesHandler(discoveryStore, getContext);

    const result = await handler({ topic: "auth" }, EXTRA);
    const { human, json } = parseEnvelope(result.content[0].text);

    expect(human).toMatch(/No discoveries found matching topic="auth"/);
    expect(json).toEqual({ discoveries: [] });
  });

  it("returns human text and JSON discoveries array when discoveries exist", async () => {
    const ts = new Date("2026-06-21T10:00:00Z").getTime();
    const discovery: Discovery = {
      id: "1234-0",
      taskId: "task-a",
      role: "coder",
      topic: "schema-change",
      content: "Renamed users table to accounts",
      files: ["src/db/schema.ts"],
      scope: "graph",
      timestamp: ts,
    };
    const { discoveryStore, getContext } = buildMocks([discovery]);
    const handler = buildQueryDiscoveriesHandler(discoveryStore, getContext);

    const result = await handler({}, EXTRA);
    const { human, json } = parseEnvelope(result.content[0].text);

    expect(human).toMatch(/1 discovery\(ies\) found/);
    expect(human).toMatch(/schema-change/);
    expect(human).toMatch(/Renamed users table to accounts/);
    expect(json).toEqual({ discoveries: [discovery] });
  });

  it("returns isError and no envelope when graphId is missing", async () => {
    const discoveryStore = { queryDiscoveries: vi.fn() } as any;
    const getContext = vi.fn().mockReturnValue({ graphId: undefined });
    const handler = buildQueryDiscoveriesHandler(discoveryStore, getContext);

    const result = await handler({}, EXTRA);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/requires graph context/);
    expect(result.content[0].text).not.toContain("---");
    expect(discoveryStore.queryDiscoveries).not.toHaveBeenCalled();
  });

  it("passes filter args to discoveryStore.queryDiscoveries", async () => {
    const { discoveryStore, getContext } = buildMocks([]);
    const handler = buildQueryDiscoveriesHandler(discoveryStore, getContext);

    await handler({ topic: "db", taskId: "worker-1", since: "100-0" }, EXTRA);

    expect(discoveryStore.queryDiscoveries).toHaveBeenCalledWith(GRAPH_ID, {
      topic: "db",
      taskId: "worker-1",
      since: "100-0",
    });
  });
});
