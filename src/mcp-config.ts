import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_SELF_IMPROVEMENT_CONFIG, DEFAULT_ANALYZER_TRIGGER_CONFIG } from "./self-improvement/types.js";
import type { SelfImprovementConfig, AnalyzerTriggerConfig } from "./self-improvement/types.js";

// === Types ===

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface BureauMcpConfig {
  inherit: boolean;
  include: string[];
  exclude: string[];
  sources: string[];
}

export interface BureauDestinationConfig {
  name: string;
  url: string;
  baseRef: string;
  secretRef: string;
  tokenEnv?: string;
  isDefault?: boolean;
  completionPolicy?: 'promote' | 'pr-only';
  provider?: string;
}

export interface BureauValidationConfig {
  unit?: string;
  integration?: string;
}

export interface BureauConfig {
  mcp: BureauMcpConfig;
  selfImprovement: SelfImprovementConfig;
  destinations?: BureauDestinationConfig[];
  validation?: BureauValidationConfig;
}

export interface OAuthWarning {
  serverName: string;
  reason: string;
}

export interface MergedMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
  warnings: OAuthWarning[];
}

// === Defaults ===

const DEFAULT_BUREAU_CONFIG: BureauConfig = {
  mcp: {
    inherit: true,
    include: [],
    exclude: ["codebase-memory-mcp"],
    sources: [
      "~/.claude/.mcp.json",
      "~/.claude/settings.json",
      ".mcp.json",
      ".claude/settings.json",
      ".claude/settings.local.json",
    ],
  },
  selfImprovement: DEFAULT_SELF_IMPROVEMENT_CONFIG,
};

// === loadBureauConfig ===

export function loadBureauConfig(cwd: string): BureauConfig {
  const configPath = join(cwd, ".bureau", "config.json");
  if (!existsSync(configPath)) {
    return DEFAULT_BUREAU_CONFIG;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return DEFAULT_BUREAU_CONFIG;
  }

  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_BUREAU_CONFIG;
  }

  const obj = raw as Record<string, unknown>;
  const mcp = typeof obj.mcp === "object" && obj.mcp !== null
    ? (obj.mcp as Record<string, unknown>)
    : {};

  const rawSI = typeof obj.selfImprovement === "object" && obj.selfImprovement !== null
    ? (obj.selfImprovement as Record<string, unknown>)
    : {};

  const analyzerTrigger: AnalyzerTriggerConfig = {
    ...DEFAULT_ANALYZER_TRIGGER_CONFIG,
    ...(typeof rawSI.analyzerTrigger === "object" && rawSI.analyzerTrigger !== null
      ? (rawSI.analyzerTrigger as Partial<AnalyzerTriggerConfig>)
      : {}),
  };

  const selfImprovement: SelfImprovementConfig = {
    ...DEFAULT_SELF_IMPROVEMENT_CONFIG,
    ...(rawSI as Partial<SelfImprovementConfig>),
    analyzerTrigger,
    // Explicit boolean narrowing for fields where non-boolean values would silently misbehave
    ...(typeof rawSI.defaultReview === "boolean" ? { defaultReview: rawSI.defaultReview } : {}),
  };

  // Parse destinations (git registry middle tier — #229)
  const rawDests = Array.isArray(obj.destinations)
    ? (obj.destinations as Array<Record<string, unknown>>)
    : undefined;
  const destinations: BureauDestinationConfig[] | undefined = rawDests
    ? rawDests
        .filter(
          (d) =>
            typeof d.name === "string" &&
            typeof d.url === "string" &&
            typeof d.baseRef === "string" &&
            typeof d.secretRef === "string",
        )
        .map((d) => ({
          name: d.name as string,
          url: d.url as string,
          baseRef: d.baseRef as string,
          secretRef: d.secretRef as string,
          ...(typeof d.tokenEnv === "string" && { tokenEnv: d.tokenEnv }),
          ...(typeof d.isDefault === "boolean" && { isDefault: d.isDefault }),
          ...(typeof d.completionPolicy === "string" && {
            completionPolicy: d.completionPolicy as "promote" | "pr-only",
          }),
          ...(typeof d.provider === "string" && { provider: d.provider }),
        }))
    : undefined;

  // Parse validation command defaults (#230)
  const rawVal =
    typeof obj.validation === "object" && obj.validation !== null
      ? (obj.validation as Record<string, unknown>)
      : undefined;
  const validation: BureauValidationConfig | undefined = rawVal
    ? {
        ...(typeof rawVal.unit === "string" && { unit: rawVal.unit }),
        ...(typeof rawVal.integration === "string" && { integration: rawVal.integration }),
      }
    : undefined;

  return {
    mcp: {
      inherit: typeof mcp.inherit === "boolean" ? mcp.inherit : DEFAULT_BUREAU_CONFIG.mcp.inherit,
      include: Array.isArray(mcp.include) ? (mcp.include as string[]).filter(s => typeof s === "string") : [],
      exclude: Array.isArray(mcp.exclude) ? (mcp.exclude as string[]).filter(s => typeof s === "string") : [],
      sources: Array.isArray(mcp.sources) ? (mcp.sources as string[]).filter(s => typeof s === "string") : DEFAULT_BUREAU_CONFIG.mcp.sources,
    },
    selfImprovement,
    ...(destinations && destinations.length > 0 && { destinations }),
    ...(validation && Object.keys(validation).length > 0 && { validation }),
  };
}

// === Source file parsing helpers ===

export function expandSource(source: string, cwd: string): string {
  if (source.startsWith("~/") || source.startsWith("~\\")) {
    return resolve(homedir(), source.slice(2));
  }
  if (source === "~") {
    return homedir();
  }
  return resolve(cwd, source);
}

export function parseServerConfigs(raw: unknown): Record<string, McpServerConfig> {
  if (typeof raw !== "object" || raw === null) return {};

  const obj = raw as Record<string, unknown>;
  const mcpServers = typeof obj.mcpServers === "object" && obj.mcpServers !== null
    ? (obj.mcpServers as Record<string, unknown>)
    : null;

  if (!mcpServers) return {};

  const result: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(mcpServers)) {
    if (typeof cfg !== "object" || cfg === null) continue;
    const c = cfg as Record<string, unknown>;
    if (typeof c.command !== "string") continue;

    const server: McpServerConfig = { command: c.command };
    if (Array.isArray(c.args)) {
      server.args = (c.args as unknown[]).filter(a => typeof a === "string") as string[];
    }
    if (typeof c.env === "object" && c.env !== null) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
      server.env = env;
    }
    result[name] = server;
  }

  return result;
}

// === readUserMcpServers ===

export function readUserMcpServers(cwd: string): Record<string, McpServerConfig> {
  const config = loadBureauConfig(cwd);

  if (!config.mcp.inherit) return {};

  let merged: Record<string, McpServerConfig> = {};

  for (const source of config.mcp.sources) {
    const filePath = expandSource(source, cwd);
    if (!existsSync(filePath)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      continue;
    }

    const servers = parseServerConfigs(raw);
    // Later sources override earlier (same merge semantics as Claude Code)
    merged = { ...merged, ...servers };
  }

  // Apply include filter: if non-empty, only keep listed names
  if (config.mcp.include.length > 0) {
    const includeSet = new Set(config.mcp.include);
    for (const name of Object.keys(merged)) {
      if (!includeSet.has(name)) delete merged[name];
    }
  }

  // Apply exclude filter
  if (config.mcp.exclude.length > 0) {
    for (const name of config.mcp.exclude) {
      delete merged[name];
    }
  }

  return merged;
}

// === readBureauEnv ===

export function readBureauEnv(cwd: string): Record<string, string> {
  const envPath = join(cwd, ".bureau", ".env");
  if (!existsSync(envPath)) return {};

  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return {};
  }

  const result: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    // Strip inline comments — only strip after value unless quoted
    const line = rawLine.trim();

    // Skip blank lines and comment lines
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;

    let value = line.slice(eqIdx + 1).trim();

    // Handle quoted values (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Strip trailing inline comment (unquoted values)
      const commentIdx = value.indexOf(" #");
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }

    result[key] = value;
  }

  return result;
}

// === detectOAuthServers ===

const OAUTH_NAME_PATTERNS = [/oauth/i, /auth/i];
const OAUTH_ENV_PATTERNS = [/TOKEN/i, /OAUTH/i, /CLIENT_SECRET/i, /REFRESH_TOKEN/i];

export function detectOAuthServers(servers: Record<string, McpServerConfig>): OAuthWarning[] {
  const warnings: OAuthWarning[] = [];

  for (const [name, cfg] of Object.entries(servers)) {
    // Check server name
    for (const pattern of OAUTH_NAME_PATTERNS) {
      if (pattern.test(name)) {
        warnings.push({ serverName: name, reason: `server name matches pattern '${pattern.source}'` });
        break;
      }
    }

    // Check env var keys — emit at most one warning per server
    if (cfg.env) {
      outer: for (const envKey of Object.keys(cfg.env)) {
        for (const pattern of OAUTH_ENV_PATTERNS) {
          if (pattern.test(envKey)) {
            warnings.push({ serverName: name, reason: `env var '${envKey}' matches OAuth pattern` });
            break outer;
          }
        }
      }
    }
  }

  // Deduplicate by serverName (keep first)
  const seen = new Set<string>();
  return warnings.filter(w => {
    if (seen.has(w.serverName)) return false;
    seen.add(w.serverName);
    return true;
  });
}

// === buildMergedMcpConfig ===

export function buildMergedMcpConfig(bureauServer: McpServerConfig, cwd: string): MergedMcpConfig {
  const userServers = readUserMcpServers(cwd);
  const bureauEnv = readBureauEnv(cwd);

  // Apply .bureau/.env overrides to env vars in all user servers
  const augmentedUserServers: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(userServers)) {
    augmentedUserServers[name] = {
      ...cfg,
      env: Object.keys(bureauEnv).length > 0
        ? { ...(cfg.env ?? {}), ...bureauEnv }
        : cfg.env,
    };
  }

  // Apply .bureau/.env overrides to bureau server too
  const augmentedBureauServer: McpServerConfig = Object.keys(bureauEnv).length > 0
    ? { ...bureauServer, env: { ...(bureauServer.env ?? {}), ...bureauEnv } }
    : bureauServer;

  // Use "bureau-agent" for spawned agents to avoid name collision with user-level
  // "the-bureau" in ~/.claude.json. Claude CLI's --strict-mcp-config conflicts when
  // both user config and --mcp-config define the same server name.
  const mcpServers: Record<string, McpServerConfig> = {
    ...augmentedUserServers,
    "bureau-agent": augmentedBureauServer,
  };

  const warnings = detectOAuthServers(augmentedUserServers);

  return { mcpServers, warnings };
}
