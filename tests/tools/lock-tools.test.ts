import { describe, it, expect, vi } from "vitest";
import { registerLockFiles } from "../../src/tools/lock-files.js";
import { registerUnlockFiles } from "../../src/tools/unlock-files.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

function captureHandler(register: (server: any) => void) {
  let handler: (...args: any[]) => any;
  const server = {
    registerTool: vi.fn((_name: string, _schema: unknown, h: (...args: any[]) => any) => {
      handler = h;
    }),
  };
  register(server);
  return (args: Record<string, unknown>) => handler(args);
}

const lockConfig = createStaticResolver({
  sessionId: "sess-1",
  project: "my-proj",
  taskId: "task-1",
  graphId: "graph-1",
});

describe("lock_files tool", () => {
  it("reports acquired locks", async () => {
    const fileLocks = {
      acquireLocks: vi.fn().mockResolvedValue({
        acquired: ["src/a.ts", "src/b.ts"],
        conflicts: [],
      }),
    };

    const invoke = captureHandler((server) =>
      registerLockFiles(server, fileLocks as any, lockConfig),
    );

    const result = await invoke({ paths: ["src/a.ts", "src/b.ts"], mode: "exclusive" });
    expect(result.content[0].text).toContain("Acquired 2 lock(s)");
    expect(result.content[0].text).toContain("src/a.ts");
    expect(result.isError).toBeFalsy();
  });

  it("reports conflicts and sets isError when all locks fail", async () => {
    const fileLocks = {
      acquireLocks: vi.fn().mockResolvedValue({
        acquired: [],
        conflicts: [
          { path: "src/a.ts", heldBy: { sessionId: "other-session-xyz", taskId: "task-x" } },
        ],
      }),
    };

    const invoke = captureHandler((server) =>
      registerLockFiles(server, fileLocks as any, lockConfig),
    );

    const result = await invoke({ paths: ["src/a.ts"], mode: "exclusive" });
    expect(result.content[0].text).toContain("Failed to acquire 1 lock(s)");
    expect(result.content[0].text).toContain("other-se"); // first 8 chars of sessionId
    expect(result.isError).toBe(true);
  });

  it("reports partial success (some acquired, some conflicted) without isError", async () => {
    const fileLocks = {
      acquireLocks: vi.fn().mockResolvedValue({
        acquired: ["src/a.ts"],
        conflicts: [
          { path: "src/b.ts", heldBy: { sessionId: "other-session-xyz", taskId: "task-x" } },
        ],
      }),
    };

    const invoke = captureHandler((server) =>
      registerLockFiles(server, fileLocks as any, lockConfig),
    );

    const result = await invoke({ paths: ["src/a.ts", "src/b.ts"], mode: "exclusive" });
    expect(result.content[0].text).toContain("Acquired 1 lock(s)");
    expect(result.content[0].text).toContain("Failed to acquire 1 lock(s)");
    // isError is false when at least one lock was acquired
    expect(result.isError).toBeFalsy();
  });

  it("passes config to acquireLocks correctly", async () => {
    const fileLocks = {
      acquireLocks: vi.fn().mockResolvedValue({ acquired: [], conflicts: [] }),
    };

    const invoke = captureHandler((server) =>
      registerLockFiles(server, fileLocks as any, lockConfig),
    );

    await invoke({ paths: ["src/c.ts"], mode: "shared" });
    expect(fileLocks.acquireLocks).toHaveBeenCalledWith("my-proj", {
      sessionId: "sess-1",
      taskId: "task-1",
      graphId: "graph-1",
      paths: ["src/c.ts"],
      mode: "shared",
    });
  });
});

describe("unlock_files tool", () => {
  const unlockConfig = createStaticResolver({ sessionId: "sess-1", project: "my-proj" });

  it("releases specified paths and reports counts", async () => {
    const fileLocks = {
      releaseLocks: vi.fn().mockResolvedValue({ released: ["src/a.ts"], notHeld: [] }),
    };

    const invoke = captureHandler((server) =>
      registerUnlockFiles(server, fileLocks as any, unlockConfig),
    );

    const result = await invoke({ paths: ["src/a.ts"] });
    expect(result.content[0].text).toContain("Released: 1");
    expect(result.content[0].text).toContain("Not held: 0");
    expect(fileLocks.releaseLocks).toHaveBeenCalledWith("my-proj", "sess-1", ["src/a.ts"]);
  });

  it("releases all locks when no paths given", async () => {
    const fileLocks = {
      releaseAllForSession: vi.fn().mockResolvedValue(4),
    };

    const invoke = captureHandler((server) =>
      registerUnlockFiles(server, fileLocks as any, unlockConfig),
    );

    const result = await invoke({});
    expect(result.content[0].text).toContain("Released all 4 lock(s)");
    expect(fileLocks.releaseAllForSession).toHaveBeenCalledWith("my-proj", "sess-1");
  });

  it("releases all locks when paths is empty array", async () => {
    const fileLocks = {
      releaseAllForSession: vi.fn().mockResolvedValue(2),
    };

    const invoke = captureHandler((server) =>
      registerUnlockFiles(server, fileLocks as any, unlockConfig),
    );

    const result = await invoke({ paths: [] });
    expect(result.content[0].text).toContain("Released all 2");
    expect(fileLocks.releaseAllForSession).toHaveBeenCalled();
  });
});
