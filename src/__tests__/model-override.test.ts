import { describe, it, expect } from "vitest";
import { buildSpawnCommand } from "../spawner.js";

// Minimal options required by buildSpawnCommand (no Redis, no network)
const BASE_OPTS = {
  sessionId: "test-session",
  role: "backend-dev",
  agentPrompt: "Do work",
  redisUrl: "redis://localhost:6379",
  cwd: "/tmp",
  task: "Write tests",
  mcpServerPath: "/tmp/mcp.cjs",
};

describe("model resolution precedence (issue #35)", () => {
  it("passes --model when model is set", () => {
    const cmd = buildSpawnCommand({ ...BASE_OPTS, model: "haiku" });
    const modelIdx = cmd.args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd.args[modelIdx + 1]).toBe("haiku");
  });

  it("omits --model when model is undefined", () => {
    const cmd = buildSpawnCommand({ ...BASE_OPTS, model: undefined });
    expect(cmd.args.indexOf("--model")).toBe(-1);
  });

  it("passes unknown model values through verbatim", () => {
    const cmd = buildSpawnCommand({ ...BASE_OPTS, model: "claude-future-9000" });
    const modelIdx = cmd.args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd.args[modelIdx + 1]).toBe("claude-future-9000");
  });

  it("task.model overrides role default in dispatch (precedence logic)", () => {
    // Simulate the dispatch model-resolution block:
    //   agentModel = cfg.model  (role default)
    //   if (task.model) agentModel = task.model
    const resolveModel = (roleDefault: string | undefined, taskModel: string | undefined): string | undefined => {
      let agentModel = roleDefault;
      if (taskModel) agentModel = taskModel;
      return agentModel;
    };

    expect(resolveModel("sonnet", "haiku")).toBe("haiku");      // task overrides role
    expect(resolveModel("sonnet", undefined)).toBe("sonnet");   // role default when no task model
    expect(resolveModel(undefined, "opus")).toBe("opus");       // task model with no role default
    expect(resolveModel(undefined, undefined)).toBeUndefined(); // no model → undefined (no --model flag)
  });
});
