import { buildSpawnCommand } from "../spawner.js";
import type { AgentRuntime, LaunchSpec } from "./types.js";

/** The native-MCP runtime: Claude Code is itself the MCP client + tool-loop.
 *  Proprietary — bring-your-own, never bundled. Thin façade over buildSpawnCommand;
 *  the model/endpoint/auth swap happens via spec.providerEnv (see resolve-agent). */
export const ClaudeCodeRuntime: AgentRuntime = {
  id: "claude-code",
  redistributable: false,
  coordination: "native-mcp",
  hookSettingsFor(spec: LaunchSpec, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!spec.workerHttp) return undefined;
    if (env.BUREAU_STEERING === "off") return undefined;
    return "/etc/bureau/steer-settings.json";
  },
  buildLaunch(spec: LaunchSpec) {
    const steeringSettingsPath = this.hookSettingsFor?.(spec, process.env);
    return buildSpawnCommand({ ...spec, steeringSettingsPath });
  },
};

/** Registry of available runtime adapters, keyed by id. Phase 2 adds the
 *  wrapped-mcp Goose/OpenHands adapter here. */
export const runtimeRegistry: Record<string, AgentRuntime> = {
  [ClaudeCodeRuntime.id]: ClaudeCodeRuntime,
};
