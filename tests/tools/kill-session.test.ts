/**
 * Tests for kill_session MCP tool handler (src/tools/kill-session.ts).
 * Mocks the spawner's killSession to test both found and not-found paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/spawner.js", () => ({
  killSession: vi.fn(),
}));

import { registerKillSession } from "../../src/tools/kill-session.js";
import * as spawner from "../../src/spawner.js";

function buildHandler() {
  let handler: (args: { sessionId: string }) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  registerKillSession(mockServer);
  return { handler: handler! };
}

describe("kill_session handler", () => {
  beforeEach(() => {
    vi.mocked(spawner.killSession).mockReset();
  });

  it("confirms termination when session exists", async () => {
    vi.mocked(spawner.killSession).mockReturnValue(true);
    const { handler } = buildHandler();

    const result = await handler({ sessionId: "sess-running" });
    expect(spawner.killSession).toHaveBeenCalledWith("sess-running");
    expect(result.content[0].text).toBe("Session sess-running terminated.");
  });

  it("reports not found when session is unknown", async () => {
    vi.mocked(spawner.killSession).mockReturnValue(false);
    const { handler } = buildHandler();

    const result = await handler({ sessionId: "sess-gone" });
    expect(result.content[0].text).toContain("not found in active processes");
    expect(result.content[0].text).toContain("sess-gone");
  });
});
