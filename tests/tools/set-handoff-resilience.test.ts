import { describe, it, expect, vi } from "vitest";
import { registerSetHandoff, handoffInputSchema, applyTruncation } from "../../src/tools/set-handoff.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

// #326: set_handoff auto-truncates oversized free text instead of hard-rejecting
// it, and reports what it truncated in the tool response. #327: investigation
// found the client-side __unparsedToolInput wrapper never reaches this handler
// (see comment in src/tools/set-handoff.ts), so no recovery path is tested here
// — only the tool-description guidance that discourages the inputs that cause it.

function captureRegistration(register: (server: any) => void) {
  let capturedSchema: any;
  let handler: (...args: any[]) => any;
  const server = {
    registerTool: vi.fn((_name: string, schema: unknown, h: (...args: any[]) => any) => {
      capturedSchema = schema;
      handler = h;
    }),
  };
  register(server);
  return {
    invoke: (args: Record<string, unknown>) => handler(args),
    schema: capturedSchema!,
  };
}

function setup() {
  const handoffManager = { setHandoff: vi.fn().mockResolvedValue(undefined) };
  const getContext = createStaticResolver({ sessionId: "session-1", taskId: "task-1", graphId: "graph-1" });
  const { invoke, schema } = captureRegistration((server) =>
    registerSetHandoff(server, handoffManager as any, getContext),
  );
  return { handoffManager, invoke, schema };
}

describe("set_handoff — soft-cap auto-truncation (#326)", () => {
  it("truncates an over-cap summary with a marker and reports it", async () => {
    const { invoke, handoffManager } = setup();
    const oversized = "a".repeat(900);

    const result = await invoke({ summary: oversized });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("truncated");
    expect(result.content[0].text).toContain("summary");

    const stored = handoffManager.setHandoff.mock.calls[0][0];
    expect(stored.summary.length).toBeLessThanOrEqual(800);
    expect(stored.summary.endsWith("…[truncated]")).toBe(true);
  });

  it("truncates an over-cap decisions[].what and decisions[].why", async () => {
    const { invoke, handoffManager } = setup();
    const result = await invoke({
      summary: "short",
      decisions: [{ what: "w".repeat(600), why: "y".repeat(900), alternatives: [] }],
    });

    expect(result.content[0].text).toContain("decisions[0].what");
    expect(result.content[0].text).toContain("decisions[0].why");

    const stored = handoffManager.setHandoff.mock.calls[0][0];
    expect(stored.decisions[0].what.length).toBeLessThanOrEqual(500);
    expect(stored.decisions[0].what.endsWith("…[truncated]")).toBe(true);
    expect(stored.decisions[0].why.length).toBeLessThanOrEqual(800);
    expect(stored.decisions[0].why.endsWith("…[truncated]")).toBe(true);
  });

  it("truncates an over-cap decisions[].alternatives entry", async () => {
    const { invoke, handoffManager } = setup();
    const result = await invoke({
      summary: "short",
      decisions: [{ what: "w", why: "y", alternatives: ["a".repeat(400)] }],
    });

    expect(result.content[0].text).toContain("decisions[0].alternatives[0]");

    const stored = handoffManager.setHandoff.mock.calls[0][0];
    expect(stored.decisions[0].alternatives[0].length).toBeLessThanOrEqual(300);
    expect(stored.decisions[0].alternatives[0].endsWith("…[truncated]")).toBe(true);
  });

  it("truncates an over-cap warnings entry", async () => {
    const { invoke, handoffManager } = setup();
    const result = await invoke({
      summary: "short",
      warnings: ["w".repeat(600)],
    });

    expect(result.content[0].text).toContain("warnings[0]");

    const stored = handoffManager.setHandoff.mock.calls[0][0];
    expect(stored.warnings[0].length).toBeLessThanOrEqual(500);
    expect(stored.warnings[0].endsWith("…[truncated]")).toBe(true);
  });

  it("truncates an over-cap filesChanged[].summary", async () => {
    const { invoke, handoffManager } = setup();
    const result = await invoke({
      summary: "short",
      filesChanged: [{ path: "src/a.ts", action: "modified", summary: "s".repeat(600) }],
    });

    expect(result.content[0].text).toContain("filesChanged[0].summary");

    const stored = handoffManager.setHandoff.mock.calls[0][0];
    expect(stored.filesChanged[0].summary.length).toBeLessThanOrEqual(500);
    expect(stored.filesChanged[0].summary.endsWith("…[truncated]")).toBe(true);
  });

  it("passes under-cap text through unchanged with no truncation reported", async () => {
    const { invoke, handoffManager } = setup();
    const result = await invoke({
      summary: "Fixed the thing",
      decisions: [{ what: "used X", why: "simpler than Y", alternatives: ["Y"] }],
      warnings: ["watch out for Z"],
      filesChanged: [{ path: "src/a.ts", action: "modified", summary: "fix" }],
    });

    expect(result.content[0].text).not.toContain("truncated");

    const stored = handoffManager.setHandoff.mock.calls[0][0];
    expect(stored.summary).toBe("Fixed the thing");
    expect(stored.decisions[0].what).toBe("used X");
    expect(stored.decisions[0].why).toBe("simpler than Y");
    expect(stored.decisions[0].alternatives[0]).toBe("Y");
    expect(stored.warnings[0]).toBe("watch out for Z");
    expect(stored.filesChanged[0].summary).toBe("fix");
  });

  it("applyTruncation is a pure function reporting exactly the fields it shortened", () => {
    const { value, truncated } = applyTruncation({
      summary: "a".repeat(900),
      decisions: [{ what: "fine", why: "fine", alternatives: [] }],
    } as any);

    expect(truncated).toEqual(["summary"]);
    expect(value.summary.length).toBeLessThanOrEqual(800);
    expect(value.decisions![0].what).toBe("fine");
  });

  // #326 completion (review-326-327 Major blocker): every remaining prose field is
  // truncated, not rejected — commits.message, findings.*, testResults.failures,
  // schemaChanges, configChanges.
  it("truncates over-cap commits[].message, schemaChanges, configChanges, testResults.failures", () => {
    const { value, truncated } = applyTruncation({
      summary: "ok",
      commits: [{ sha: "abc1234", message: "m".repeat(400) }],
      schemaChanges: ["s".repeat(300)],
      configChanges: ["c".repeat(300)],
      testResults: { passed: 1, failed: 1, skipped: 0, failures: ["f".repeat(300)] },
    } as any);

    expect(truncated).toEqual([
      "schemaChanges[0]",
      "configChanges[0]",
      "testResults.failures[0]",
      "commits[0].message",
    ]);
    expect(value.commits![0].message.length).toBeLessThanOrEqual(300);
    expect(value.commits![0].message.endsWith("…[truncated]")).toBe(true);
    expect(value.commits![0].sha).toBe("abc1234");
    expect(value.schemaChanges![0].length).toBeLessThanOrEqual(200);
    expect(value.configChanges![0].length).toBeLessThanOrEqual(200);
    expect(value.testResults!.failures![0].length).toBeLessThanOrEqual(200);
    expect(value.testResults!.passed).toBe(1);
  });

  it("truncates over-cap findings prose (description/evidence/suggestedAction) and leaves structure intact", () => {
    const { value, truncated } = applyTruncation({
      summary: "ok",
      findings: [{
        id: "f1", category: "auto-improve", title: "t",
        description: "d".repeat(1200), evidence: "e".repeat(600),
        estimatedImpact: "low", suggestedAction: "a".repeat(600),
      }],
    } as any);

    expect(truncated).toEqual([
      "findings[0].description",
      "findings[0].evidence",
      "findings[0].suggestedAction",
    ]);
    expect(value.findings![0].description.length).toBeLessThanOrEqual(1000);
    expect(value.findings![0].evidence.length).toBeLessThanOrEqual(500);
    expect(value.findings![0].suggestedAction.length).toBeLessThanOrEqual(500);
    expect(value.findings![0].id).toBe("f1");
    expect(value.findings![0].title).toBe("t");
  });

  it("schema accepts prose beyond old hard caps on the newly-covered fields (below safety bound)", () => {
    const result = handoffInputSchema.safeParse({
      summary: "ok",
      commits: [{ sha: "abc1234", message: "m".repeat(301) }],
      schemaChanges: ["s".repeat(201)],
      configChanges: ["c".repeat(201)],
      testResults: { passed: 0, failed: 0, skipped: 0, failures: ["f".repeat(201)] },
      findings: [{
        id: "f1", category: "investigate", title: "t",
        description: "d".repeat(1001), evidence: "e".repeat(501),
        estimatedImpact: "low", suggestedAction: "a".repeat(501),
      }],
    });
    expect(result.success).toBe(true);
  });
});

describe("set_handoff — hard limits preserved", () => {
  it("still hard-rejects more than 20 decisions (array-count cap)", () => {
    const result = handoffInputSchema.safeParse({
      summary: "short",
      decisions: Array.from({ length: 21 }, () => ({ what: "w", why: "y", alternatives: [] })),
    });
    expect(result.success).toBe(false);
  });

  it("still hard-rejects more than 10 warnings (array-count cap)", () => {
    const result = handoffInputSchema.safeParse({
      summary: "short",
      warnings: Array.from({ length: 11 }, () => "w"),
    });
    expect(result.success).toBe(false);
  });

  it("still hard-rejects more than 10 alternatives per decision (array-count cap)", () => {
    const result = handoffInputSchema.safeParse({
      summary: "short",
      decisions: [{ what: "w", why: "y", alternatives: Array.from({ length: 11 }, () => "a") }],
    });
    expect(result.success).toBe(false);
  });

  it("still hard-rejects a summary beyond the 4000-char safety bound", () => {
    const result = handoffInputSchema.safeParse({
      summary: "a".repeat(4001),
    });
    expect(result.success).toBe(false);
  });

  it("still hard-rejects a decisions[].why beyond the 4000-char safety bound", () => {
    const result = handoffInputSchema.safeParse({
      summary: "short",
      decisions: [{ what: "w", why: "y".repeat(4001), alternatives: [] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("set_handoff — tool description guidance (#327)", () => {
  it("documents auto-truncation instead of hard character limits", () => {
    const { schema } = setup();
    expect(schema.description).toContain("auto-truncated");
  });

  it("discourages embedding code/diffs and heavy escaping that cause malformed tool calls", () => {
    const { schema } = setup();
    expect(schema.description.toLowerCase()).toContain("plain prose");
    expect(schema.description.toLowerCase()).toContain("diffs");
    expect(schema.description.toLowerCase()).toContain("backslash");
  });
});
