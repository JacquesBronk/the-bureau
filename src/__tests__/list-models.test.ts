import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Mock fetch — list_models calls LiteLLM's /model/info endpoint
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { buildListModelsHandler } from "../tools/list-models.js";

function join(...parts: string[]) {
  return resolve(...parts);
}

const AGENTS_JSON = JSON.stringify({
  version: "2.0.0",
  providers: {
    "local-qwen": {
      transport: "anthropic",
      baseUrl: "http://litellm.local:4000",
      model: "qwen2.5-coder:14b",
      auth: { mode: "gateway", env: "LITELLM_KEY" },
    },
    "local-only": {
      transport: "anthropic",
      baseUrl: "http://litellm.local:4000",
      auth: { mode: "gateway", env: "LITELLM_KEY" },
    },
    anthropic: {
      transport: "anthropic",
      auth: { mode: "api-key", env: "ANTHROPIC_API_KEY" },
    },
  },
  runtimes: {},
});

const LITELLM_MODEL_INFO = {
  data: [
    {
      model_name: "qwen2.5-coder:14b",
      litellm_params: { model: "ollama_chat/qwen2.5-coder:14b", num_ctx: 65536 },
      model_info: {
        description: "Code-focused 14B, 64k ctx, nano agents",
        tags: ["nano", "local", "code"],
        max_tokens: 65536,
      },
    },
    {
      model_name: "qwen3:14b",
      litellm_params: { model: "ollama_chat/qwen3:14b", num_ctx: 32768 },
      model_info: {
        description: "General purpose 14B, 32k ctx, tools",
        tags: ["general", "tools"],
        max_tokens: 32768,
      },
    },
    {
      model_name: "mxbai-embed-large",
      litellm_params: { model: "ollama/mxbai-embed-large" },
      model_info: {},
    },
  ],
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bureau-list-models-"));
  writeFileSync(join(tempDir, "agents.json"), AGENTS_JSON, "utf-8");
  mockFetch.mockReset();
  vi.stubEnv("LITELLM_KEY", "test-key");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("list_models handler", () => {
  it("returns models from a named gateway provider", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => LITELLM_MODEL_INFO,
    });
    const handler = buildListModelsHandler(tempDir);
    const result = await handler({ provider: "local-qwen" });

    expect(result.provider).toBe("local-qwen");
    expect(result.models.length).toBe(3);
    const coder = result.models.find((m) => m.name === "qwen2.5-coder:14b");
    expect(coder).toBeDefined();
    expect(coder!.description).toBe("Code-focused 14B, 64k ctx, nano agents");
    expect(coder!.tags).toEqual(["nano", "local", "code"]);
    expect(coder!.maxTokens).toBe(65536);
  });

  it("calls the correct /model/info endpoint with Bearer auth", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => LITELLM_MODEL_INFO });
    const handler = buildListModelsHandler(tempDir);
    await handler({ provider: "local-qwen" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://litellm.local:4000/model/info");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
  });

  it("omits models with no model_info (embedding models)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => LITELLM_MODEL_INFO });
    const handler = buildListModelsHandler(tempDir);
    const result = await handler({ provider: "local-qwen" });

    // mxbai-embed-large has empty model_info — still returned but with no description/tags
    const embed = result.models.find((m) => m.name === "mxbai-embed-large");
    expect(embed).toBeDefined();
    expect(embed!.description).toBeUndefined();
    expect(embed!.tags).toBeUndefined();
  });

  it("auto-discovers first gateway provider when no provider specified", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => LITELLM_MODEL_INFO });
    const handler = buildListModelsHandler(tempDir);
    const result = await handler({});

    expect(result.provider).toMatch(/^local-qwen|local-only$/);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("throws when the named provider has no baseUrl (e.g. anthropic)", async () => {
    const handler = buildListModelsHandler(tempDir);
    await expect(handler({ provider: "anthropic" })).rejects.toThrow(/no baseUrl/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when the named provider does not exist", async () => {
    const handler = buildListModelsHandler(tempDir);
    await expect(handler({ provider: "nonexistent" })).rejects.toThrow(/unknown provider/i);
  });

  it("degrades to a structured empty result when no gateway provider is configured (#303)", async () => {
    writeFileSync(
      join(tempDir, "agents.json"),
      JSON.stringify({ version: "2.0.0", providers: { anthropic: { transport: "anthropic", auth: { mode: "api-key", env: "ANTHROPIC_API_KEY" } } }, runtimes: {} }),
      "utf-8",
    );
    const handler = buildListModelsHandler(tempDir);
    const result = await handler({});
    expect(result.provider).toBeNull();
    expect(result.baseUrl).toBeNull();
    expect(result.models).toEqual([]);
    expect(result.providerUnavailable).toBe(true);
    expect(result.reason).toMatch(/no gateway provider configured/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("degrades to a structured empty result when the gateway is unreachable (#303)", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const handler = buildListModelsHandler(tempDir);
    const result = await handler({ provider: "local-qwen" });
    expect(result.provider).toBe("local-qwen");
    expect(result.baseUrl).toBe("http://litellm.local:4000");
    expect(result.models).toEqual([]);
    expect(result.providerUnavailable).toBe(true);
    expect(result.reason).toMatch(/unreachable/i);
    expect(result.reason).toMatch(/fetch failed/i);
  });

  it("throws when LiteLLM returns a non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" });
    const handler = buildListModelsHandler(tempDir);
    await expect(handler({ provider: "local-qwen" })).rejects.toThrow(/401/);
  });
});
