/**
 * #313-B P1 visibility: the get_agent_log tool increments
 * bureau.transcript.read{consumer=get_agent_log,result} — ok when content is
 * returned, missing when no log file is resolvable or the content is empty.
 *
 * The tool's read semantics (tail, maxBytes) are unchanged — the counter only
 * observes the outcome.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture the handler registered by registerGetAgentLog so we can invoke it directly.
const captured: { handler?: (args: { sessionId: string; maxBytes?: number }) => Promise<unknown> } = {};
vi.mock("../src/telemetry/instrumentation/mcp-register.js", () => ({
  registerInstrumentedTool: (
    _server: unknown,
    _name: string,
    _config: unknown,
    handler: (args: { sessionId: string; maxBytes?: number }) => Promise<unknown>,
  ) => {
    captured.handler = handler;
  },
}));

vi.mock("../src/telemetry/domain/transcript.js", () => ({
  onTranscriptRead: vi.fn(),
}));

import { registerGetAgentLog } from "../src/tools/get-agent-log.js";
import { onTranscriptRead } from "../src/telemetry/domain/transcript.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function register(entry: any) {
  const processMonitor = { get: vi.fn(() => entry) } as any;
  const redis = { get: vi.fn(async () => null) } as any;
  registerGetAgentLog({} as any, processMonitor, redis);
  return captured.handler!;
}

describe("get_agent_log — #313-B P1 transcript.read counter", () => {
  beforeEach(() => {
    vi.mocked(onTranscriptRead).mockClear();
    captured.handler = undefined;
  });

  it("emits result=ok when log content is returned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gal-cnt-"));
    const logFile = join(dir, "output.log");
    writeFileSync(logFile, "agent produced this output");

    const handler = register({ logFile });
    await handler({ sessionId: "sess-ok" });

    expect(onTranscriptRead).toHaveBeenCalledWith("get_agent_log", "ok");
    expect(onTranscriptRead).not.toHaveBeenCalledWith("get_agent_log", "missing");
  });

  it("emits result=missing when the resolved log file is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gal-cnt-"));
    const logFile = join(dir, "output.log");
    writeFileSync(logFile, "");

    const handler = register({ logFile });
    await handler({ sessionId: "sess-empty" });

    expect(onTranscriptRead).toHaveBeenCalledWith("get_agent_log", "missing");
    expect(onTranscriptRead).not.toHaveBeenCalledWith("get_agent_log", "ok");
  });

  it("emits result=missing when no log file can be resolved", async () => {
    const handler = register(undefined);
    await handler({ sessionId: "sess-nonexistent-xyz-123" });

    expect(onTranscriptRead).toHaveBeenCalledWith("get_agent_log", "missing");
  });
});
