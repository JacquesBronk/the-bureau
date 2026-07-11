import { createRequire } from "node:module";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { Redis } from "ioredis";
import { isEnabled, getMeter } from "../telemetry/core.js";
import type { GetVersionOutput } from "../types/api.js";

// When running from the esbuild bundle, BUNDLE_VERSION/BUNDLE_NAME are defined
// at build time via --define. Fall back to reading package.json for unbundled dev.
declare const BUNDLE_VERSION: string | undefined;
declare const BUNDLE_NAME: string | undefined;

const pkg = typeof BUNDLE_VERSION !== "undefined"
  ? { name: BUNDLE_NAME!, version: BUNDLE_VERSION! }
  : (() => { const r = createRequire(import.meta.url); return r("../../package.json"); })();

export function registerGetVersion(
  server: McpServer,
  redis: Redis,
): void {
  registerInstrumentedTool(server, 
    "get_version",
    {
      title: "Get Version",
      description: "Returns The Bureau version, build info, and runtime diagnostics. Use for debugging version mismatches between orchestrator and agents.",
      inputSchema: z.object({}),
    },
    async () => {
      const redisInfo = await redis.info("server").catch(() => "unavailable");
      const redisVersion = redisInfo.match(/redis_version:(.+)/)?.[1]?.trim() ?? "unknown";

      const otelEnabled = isEnabled();
      const meter = getMeter();

      const info: GetVersionOutput = {
        name: pkg.name,
        version: pkg.version,
        node: process.version,
        redis: redisVersion,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        platform: process.platform,
        cwd: process.cwd(),
        otel: {
          enabled: otelEnabled,
          hasMeter: !!meter,
          protocol: process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "unset",
          endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "unset",
        },
      };

      return {
        content: [{
          type: "text" as const,
          text: [
            `The Bureau v${info.version}`,
            `Node: ${info.node} | Redis: ${info.redis}`,
            `PID: ${info.pid} | Uptime: ${info.uptime}s`,
            `Platform: ${info.platform}`,
            `CWD: ${info.cwd}`,
            `OTEL: enabled=${info.otel.enabled} meter=${info.otel.hasMeter}`,
            `---`,
            JSON.stringify(info, null, 2),
          ].join("\n"),
        }],
      };
    },
  );
}
