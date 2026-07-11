import { describe, it, expect } from "vitest";
import { buildSpawnCommand } from "../src/spawner.js";

const base = {
  sessionId: "s1", role: "coder", agentPrompt: "do the thing",
  redisUrl: "redis://redis.local:6379/0", cwd: "/workspace",
  task: "implement X", mcpServerPath: "/unused/in/http",
  taskId: "t1", graphId: "g1",
  workerHttp: { engineUrl: "http://bureau-engine.bureau.svc:3917/mcp", token: "TOK123" },
} as any;

describe("buildSpawnCommand — worker HTTP mode", () => {
  const cmd = buildSpawnCommand(base);

  it("emits a type:http bureau-agent MCP server at the engine URL", () => {
    const cfgArg = cmd.args[cmd.args.indexOf("--mcp-config") + 1];
    const cfg = JSON.parse(cfgArg);
    expect(cfg.mcpServers["bureau-agent"].type).toBe("http");
    expect(cfg.mcpServers["bureau-agent"].url).toBe("http://bureau-engine.bureau.svc:3917/mcp");
    expect(cfg.mcpServers["bureau-agent"].headers.Authorization).toBe("Bearer TOK123");
  });

  it("does NOT put REDIS_URL or a stdio bundle command in the worker env/config", () => {
    expect(JSON.stringify(cmd.env ?? {})).not.toContain("REDIS_URL");
    const cfgArg = cmd.args[cmd.args.indexOf("--mcp-config") + 1];
    expect(cfgArg).not.toContain("mcp-server.bundle");
    expect(cfgArg).not.toContain("REDIS_URL");
  });
});
