import { describe, it, expect } from "vitest";
import { buildStartupDiagnostics } from "../src/startup-diagnostics.js";
import type { StartupDiagnosticsParams } from "../src/startup-diagnostics.js";

function makeParams(overrides: Partial<StartupDiagnosticsParams> = {}): StartupDiagnosticsParams {
  return {
    version: "0.1.73",
    profile: "full",
    toolCount: 40,
    redisStatus: "connected",
    sessionId: "sess-abc123",
    role: "orchestrator",
    graphId: undefined,
    taskId: undefined,
    enrichmentEnabled: true,
    graphContext: false,
    ...overrides,
  };
}

describe("buildStartupDiagnostics", () => {
  it("passes through all params unchanged", () => {
    const params = makeParams();
    const diag = buildStartupDiagnostics(params);

    expect(diag.version).toBe("0.1.73");
    expect(diag.profile).toBe("full");
    expect(diag.toolCount).toBe(40);
    expect(diag.redisStatus).toBe("connected");
    expect(diag.sessionId).toBe("sess-abc123");
    expect(diag.role).toBe("orchestrator");
    expect(diag.enrichmentEnabled).toBe(true);
    expect(diag.graphContext).toBe(false);
  });

  it("adds nodeVersion and platform from process", () => {
    const diag = buildStartupDiagnostics(makeParams());

    expect(diag.nodeVersion).toBe(process.version);
    expect(diag.platform).toBe(process.platform);
    expect(typeof diag.nodeVersion).toBe("string");
    expect(diag.nodeVersion.startsWith("v")).toBe(true);
  });

  it("includes graphId and taskId when provided", () => {
    const params = makeParams({
      graphId: "graph-xyz",
      taskId: "task-001",
      graphContext: true,
    });
    const diag = buildStartupDiagnostics(params);

    expect(diag.graphId).toBe("graph-xyz");
    expect(diag.taskId).toBe("task-001");
    expect(diag.graphContext).toBe(true);
  });

  it("reflects enrichment disabled and error redis status", () => {
    const params = makeParams({
      enrichmentEnabled: false,
      redisStatus: "error",
      profile: "minimal",
      toolCount: 13,
    });
    const diag = buildStartupDiagnostics(params);

    expect(diag.enrichmentEnabled).toBe(false);
    expect(diag.redisStatus).toBe("error");
    expect(diag.profile).toBe("minimal");
    expect(diag.toolCount).toBe(13);
  });
});
