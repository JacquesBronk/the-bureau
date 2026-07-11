import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  loadBureauConfig,
  detectOAuthServers,
  expandSource,
  parseServerConfigs,
} from "./mcp-config.js";
import type {
  BureauMcpConfig,
  BureauConfig,
  McpServerConfig,
  OAuthWarning,
} from "./mcp-config.js";
import { DEFAULT_SELF_IMPROVEMENT_CONFIG } from "./self-improvement/types.js";
import { loadBuildConfig, validateBuildConfig, BUILDCONFIG_FILENAME } from "./buildconfig/load.js";
import type { BuildConfig } from "./buildconfig/types.js";
import { detectToolchains } from "./buildconfig/detect.js";
import type { ServiceDetection } from "./buildconfig/detect.js";
import type { ServiceConfig } from "./buildconfig/types.js";

export type { BureauMcpConfig, BureauConfig, McpServerConfig, OAuthWarning };

const BUILDCONFIG_FILE = BUILDCONFIG_FILENAME;

/** Validate then write bureau.buildconfig.json at the repo root. Committed file — no gitignore. */
export function writeBuildConfig(cwd: string, config: unknown): BuildConfig {
  const validated = validateBuildConfig(config); // throws BuildConfigError on invalid input
  writeFileSync(join(cwd, BUILDCONFIG_FILE), JSON.stringify(validated, null, 2) + "\n", "utf-8");
  return validated;
}

export function readExistingBuildConfig(cwd: string): BuildConfig | null {
  return loadBuildConfig(cwd);
}

export function removeBuildConfig(cwd: string): boolean {
  const p = join(cwd, BUILDCONFIG_FILE);
  if (existsSync(p)) { unlinkSync(p); return true; }
  return false;
}

/** Draft a committable BuildConfig from toolchain detection. Only confident, command-trusted
 *  services with a language are included; detection-only metadata is stripped. */
export function detectDraftBuildConfig(cwd: string): { draft: BuildConfig | null; detections: ServiceDetection[] } {
  const { services } = detectToolchains(cwd);
  const confident = services.filter((s) => s.verdict === "confident" && s.commandsTrusted && s.language);
  if (confident.length === 0) return { draft: null, detections: services };
  const draftServices: ServiceConfig[] = confident.map((s) => ({
    name: s.path,
    path: s.path,
    language: s.language as string,
    ...(s.toolchain ? { toolchain: s.toolchain } : {}),
    ...s.commands,
  }));
  return { draft: { version: 1, services: draftServices }, detections: services };
}

// === Types ===

export interface DiscoverySource {
  path: string;
  servers: string[];
  exists: boolean;
}

export interface DiscoveryResult {
  allServers: Record<string, McpServerConfig>;
  sources: DiscoverySource[];
  oauthWarnings: OAuthWarning[];
  currentConfig: BureauConfig | null;
  hasExistingConfig: boolean;
}

export interface SetupChoices {
  inherit: boolean;
  exclude: string[];
  envOverrides?: Record<string, string>;
}

// expandSource and parseServerConfigs are imported from mcp-config.ts
// to avoid duplication of parsing logic.

function ensureBureauInGitignore(cwd: string): void {
  const gitignorePath = join(cwd, ".gitignore");

  const entry = ".bureau/";

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    const lines = content.split("\n").map((l) => l.trim());
    // Already present as ".bureau/" or ".bureau"
    if (lines.includes(".bureau/") || lines.includes(".bureau")) return;
    // Append with a leading newline to avoid joining onto last line
    const suffix = content.endsWith("\n") ? entry + "\n" : "\n" + entry + "\n";
    appendFileSync(gitignorePath, suffix, "utf-8");
  } else {
    writeFileSync(gitignorePath, entry + "\n", "utf-8");
  }
}

// === writeBureauConfig ===

export function writeBureauConfig(cwd: string, config: BureauMcpConfig): void {
  const bureauDir = join(cwd, ".bureau");
  mkdirSync(bureauDir, { recursive: true });

  const bureauConfig: BureauConfig = { mcp: config, selfImprovement: DEFAULT_SELF_IMPROVEMENT_CONFIG };
  writeFileSync(
    join(bureauDir, "config.json"),
    JSON.stringify(bureauConfig, null, 2) + "\n",
    "utf-8"
  );

  ensureBureauInGitignore(cwd);
}

// === discoverAndReport ===

export function discoverAndReport(cwd: string): DiscoveryResult {
  const config = loadBureauConfig(cwd);
  const sourcePaths = config.mcp.sources;

  const sources: DiscoverySource[] = [];
  let allServers: Record<string, McpServerConfig> = {};

  for (const source of sourcePaths) {
    const filePath = expandSource(source, cwd);
    const exists = existsSync(filePath);

    if (!exists) {
      sources.push({ path: filePath, servers: [], exists: false });
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      sources.push({ path: filePath, servers: [], exists: true });
      continue;
    }

    const servers = parseServerConfigs(raw);
    allServers = { ...allServers, ...servers };
    sources.push({ path: filePath, servers: Object.keys(servers), exists: true });
  }

  const oauthWarnings = detectOAuthServers(allServers);

  const configPath = join(cwd, ".bureau", "config.json");
  const hasExistingConfig = existsSync(configPath);
  let currentConfig: BureauConfig | null = null;

  if (hasExistingConfig) {
    try {
      currentConfig = loadBureauConfig(cwd);
    } catch {
      currentConfig = null;
    }
  }

  return { allServers, sources, oauthWarnings, currentConfig, hasExistingConfig };
}

// === applySetupChoices ===

export function applySetupChoices(cwd: string, choices: SetupChoices): void {
  const existing = loadBureauConfig(cwd);

  const mcpConfig: BureauMcpConfig = {
    inherit: choices.inherit,
    include: existing.mcp.include,
    exclude: choices.exclude,
    sources: existing.mcp.sources,
  };

  writeBureauConfig(cwd, mcpConfig);

  if (choices.envOverrides && Object.keys(choices.envOverrides).length > 0) {
    const bureauDir = join(cwd, ".bureau");
    mkdirSync(bureauDir, { recursive: true });

    const lines = Object.entries(choices.envOverrides)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    writeFileSync(join(bureauDir, ".env"), lines + "\n", "utf-8");
  }
}
