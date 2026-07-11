/**
 * Tests for save_criteria_plugin MCP tool handler (src/tools/save-criteria-plugin.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMkdir, mockWriteFile, mockChmod, mockExecFile } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockChmod: vi.fn().mockResolvedValue(undefined),
  mockExecFile: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  chmod: mockChmod,
}));

vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: object, cb: (err: null, result: object) => void) => {
    const result = mockExecFile(_cmd, _args, _opts);
    result.then((r: object) => cb(null, r)).catch((e: Error) => cb(e as null, {}));
    return {} as any;
  },
}));

import { registerSaveCriteriaPlugin } from "../../src/tools/save-criteria-plugin.js";

function buildHandler() {
  let handler: (args: {
    name: string;
    description: string;
    tags: string[];
    script: string;
    entrypoint?: string;
    inputs?: Record<string, { description: string; required?: boolean; default?: string }>;
  }) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  registerSaveCriteriaPlugin(mockServer, "/fake/plugins");
  return { handler: handler! };
}

describe("save_criteria_plugin handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("creates plugin directory with mkdir", async () => {
    const { handler } = buildHandler();

    await handler({ name: "my-check", description: "Desc", tags: ["test"], script: "#!/bin/bash\nexit 0", entrypoint: "check.sh" });

    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining("my-check"), { recursive: true });
  });

  it("writes plugin.json with correct manifest", async () => {
    const { handler } = buildHandler();

    await handler({
      name: "my-check",
      description: "Checks something",
      tags: ["quality"],
      script: "#!/bin/bash\nexit 0",
      entrypoint: "check.sh",
      inputs: { threshold: { description: "Threshold value", required: true } },
    });

    const manifestCall = mockWriteFile.mock.calls.find((c) => c[0].endsWith("plugin.json"));
    expect(manifestCall).toBeDefined();
    const manifest = JSON.parse(manifestCall![1] as string);
    expect(manifest.name).toBe("my-check");
    expect(manifest.description).toBe("Checks something");
    expect(manifest.tags).toEqual(["quality"]);
    expect(manifest.entrypoint).toBe("check.sh");
    expect(manifest.inputs.threshold.required).toBe(true);
  });

  it("writes script file and marks it executable", async () => {
    const { handler } = buildHandler();

    await handler({ name: "my-check", description: "D", tags: [], script: "#!/bin/bash\nexit 0", entrypoint: "check.sh" });

    const scriptCall = mockWriteFile.mock.calls.find((c) => c[0].endsWith("check.sh"));
    expect(scriptCall).toBeDefined();
    expect(scriptCall![1]).toContain("exit 0");
    expect(mockChmod).toHaveBeenCalledWith(expect.stringContaining("check.sh"), 0o755);
  });

  it("returns confirmation text including plugin name", async () => {
    const { handler } = buildHandler();

    const result = await handler({ name: "my-check", description: "D", tags: [], script: "exit 0", entrypoint: "check.sh" });

    expect(result.content[0].text).toContain("my-check");
    expect(result.isError).toBeUndefined();
  });

  it("swallows git commit failure and still returns success", async () => {
    mockExecFile.mockRejectedValue(new Error("not a git repo"));
    const { handler } = buildHandler();

    const result = await handler({ name: "bad-git", description: "D", tags: [], script: "exit 0", entrypoint: "check.sh" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("bad-git");
  });

  it("supports a custom entrypoint filename", async () => {
    const { handler } = buildHandler();

    await handler({ name: "my-check", description: "D", tags: [], script: "exit 0", entrypoint: "run.sh" });

    const manifestCall = mockWriteFile.mock.calls.find((c) => c[0].endsWith("plugin.json"));
    const manifest = JSON.parse(manifestCall![1] as string);
    expect(manifest.entrypoint).toBe("run.sh");
    expect(mockChmod).toHaveBeenCalledWith(expect.stringContaining("run.sh"), 0o755);
  });
});
