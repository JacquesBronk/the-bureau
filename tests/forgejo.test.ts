import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AnalysisFinding } from "../src/self-improvement/types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after stubbing
const { fileForgejoIssue, resolveForgejoLabel } = await import("../src/forgejo.js");

const mockLog = {
  warn: vi.fn(),
  info: vi.fn(),
} as any;

const baseFinding: AnalysisFinding = {
  id: "finding-1",
  category: "auto-improve",
  title: "Test finding",
  description: "Some description",
  evidence: "Observed in logs",
  estimatedImpact: "medium",
  suggestedAction: "Fix something",
  affectedFiles: ["src/foo.ts"],
};

describe("resolveForgejoLabel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns existing label id when found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 42, name: "auto-improve" }, { id: 7, name: "other" }],
    });

    const result = await resolveForgejoLabel("http://git.local", "tok", "owner", "repo", "auto-improve");
    expect(result).toBe(42);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("creates label when not found and returns new id", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 7, name: "other" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 99 }),
      });

    const result = await resolveForgejoLabel("http://git.local", "tok", "owner", "repo", "new-label");
    expect(result).toBe(99);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const createCall = mockFetch.mock.calls[1];
    expect(createCall[1].method).toBe("POST");
    expect(JSON.parse(createCall[1].body)).toMatchObject({ name: "new-label", color: "#0075ca" });
  });

  it("returns null when list request fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await resolveForgejoLabel("http://git.local", "tok", "owner", "repo", "any");
    expect(result).toBeNull();
  });

  it("returns null when create request fails", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false });
    const result = await resolveForgejoLabel("http://git.local", "tok", "owner", "repo", "any");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network failure"));
    const result = await resolveForgejoLabel("http://git.local", "tok", "owner", "repo", "any");
    expect(result).toBeNull();
  });
});

describe("fileForgejoIssue", () => {
  const origEnv = process.env;

  beforeEach(() => {
    mockFetch.mockReset();
    mockLog.warn.mockReset();
    mockLog.info.mockReset();
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("skips and logs warn when FORGEJO_URL is missing", async () => {
    delete process.env.FORGEJO_URL;
    process.env.FORGEJO_TOKEN = "tok";
    await fileForgejoIssue(baseFinding, "auto-improve", mockLog);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: "finding-1", label: "auto-improve" }),
      expect.stringContaining("FORGEJO_URL or FORGEJO_TOKEN not set"),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips and logs warn when FORGEJO_TOKEN is missing", async () => {
    process.env.FORGEJO_URL = "http://git.local";
    delete process.env.FORGEJO_TOKEN;
    await fileForgejoIssue(baseFinding, "auto-improve", mockLog);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: "finding-1" }),
      expect.stringContaining("FORGEJO_URL or FORGEJO_TOKEN not set"),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("files issue successfully with label id", async () => {
    process.env.FORGEJO_URL = "http://git.local";
    process.env.FORGEJO_TOKEN = "tok";
    process.env.FORGEJO_OWNER = "myorg";
    process.env.FORGEJO_REPO = "myrepo";

    // resolveForgejoLabel call
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 5, name: "auto-improve" }],
      })
      // fileForgejoIssue POST call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 123 }),
      });

    await fileForgejoIssue(baseFinding, "auto-improve", mockLog);

    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: "finding-1", issueNumber: 123 }),
      expect.stringContaining("Forgejo issue filed"),
    );
    const postCall = mockFetch.mock.calls[1];
    expect(postCall[0]).toContain("/repos/myorg/myrepo/issues");
    const payload = JSON.parse(postCall[1].body);
    expect(payload.title).toBe("Test finding");
    expect(payload.labels).toEqual([5]);
    expect(payload.body).toContain("**Affected files:** src/foo.ts");
  });

  it("files issue without label when label resolution returns null", async () => {
    process.env.FORGEJO_URL = "http://git.local";
    process.env.FORGEJO_TOKEN = "tok";

    // resolveForgejoLabel fails
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      // POST issue
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 55 }),
      });

    await fileForgejoIssue(baseFinding, "auto-improve", mockLog);

    const postCall = mockFetch.mock.calls[1];
    const payload = JSON.parse(postCall[1].body);
    expect(payload.labels).toBeUndefined();
    expect(mockLog.info).toHaveBeenCalled();
  });

  it("logs warn when POST fails", async () => {
    process.env.FORGEJO_URL = "http://git.local";
    process.env.FORGEJO_TOKEN = "tok";

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] })   // list labels → empty
      .mockResolvedValueOnce({ ok: false })                          // create label → fail → labelId null
      .mockResolvedValueOnce({ ok: false, status: 422 });            // POST issue → fail

    await fileForgejoIssue(baseFinding, "auto-improve", mockLog);

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: "finding-1", status: 422 }),
      expect.stringContaining("Forgejo issue filing failed"),
    );
  });

  it("logs warn on fetch exception", async () => {
    process.env.FORGEJO_URL = "http://git.local";
    process.env.FORGEJO_TOKEN = "tok";

    // resolveForgejoLabel list call succeeds (returns labelId), then POST throws
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 5, name: "auto-improve" }] })
      .mockRejectedValueOnce(new Error("socket hang up"));

    await fileForgejoIssue(baseFinding, "auto-improve", mockLog);

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: "finding-1", err: expect.stringContaining("socket hang up") }),
      expect.stringContaining("Forgejo issue filing error"),
    );
  });

  it("omits affectedFiles line when affectedFiles is empty", async () => {
    process.env.FORGEJO_URL = "http://git.local";
    process.env.FORGEJO_TOKEN = "tok";

    const findingNoFiles = { ...baseFinding, affectedFiles: [] };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false }) // create label fails
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1 }) });

    await fileForgejoIssue(findingNoFiles, "auto-improve", mockLog);

    const postCall = mockFetch.mock.calls[2];
    const payload = JSON.parse(postCall[1].body);
    expect(payload.body).not.toContain("**Affected files:**");
  });
});
