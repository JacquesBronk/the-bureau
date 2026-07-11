import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildConfig, ServiceConfig, ResolvedCommands } from "./types.js";

export class BuildConfigError extends Error {}

export const BUILDCONFIG_FILENAME = "bureau.buildconfig.json";
const FILE = BUILDCONFIG_FILENAME;
const CMD_KEYS = ["install", "build", "test", "integrationTest", "lint"] as const;

export function loadBuildConfig(dir: string): BuildConfig | null {
  const path = join(dir, FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new BuildConfigError(`${FILE} is not valid JSON: ${(e as Error).message}`); }
  return validateBuildConfig(raw);
}

export function validateBuildConfig(raw: unknown): BuildConfig {
  if (typeof raw !== "object" || raw === null) throw new BuildConfigError(`buildconfig must be a JSON object`);
  const obj = raw as Record<string, unknown>;
  const { services: _s, version: _v, autoRework: rawAutoRework, ...flat } = obj;
  const services: ServiceConfig[] = Array.isArray(obj.services)
    ? (obj.services as ServiceConfig[])
    : [flat as unknown as ServiceConfig]; // flat form → single element (strip envelope keys)
  for (const s of services) {
    if (!s.language || !s.path) throw new BuildConfigError(`buildconfig: each service needs language + path (got ${JSON.stringify(s)})`);
    if (!s.name) s.name = s.path;
  }
  const result: BuildConfig = { version: 1, services };
  if (rawAutoRework !== undefined) {
    if (typeof rawAutoRework !== "object" || rawAutoRework === null || Array.isArray(rawAutoRework)) {
      throw new BuildConfigError(`buildconfig: autoRework must be an object (got ${JSON.stringify(rawAutoRework)})`);
    }
    result.autoRework = rawAutoRework as BuildConfig["autoRework"];
  }
  return result;
}

export function resolveCommands(
  svc: ServiceConfig,
  toolchainDefaults: Partial<ResolvedCommands>,
  overrides: Partial<ResolvedCommands> = {},
): ResolvedCommands {
  const out = {} as ResolvedCommands;
  for (const k of CMD_KEYS) {
    out[k] = overrides[k] ?? (svc[k] as string | undefined) ?? toolchainDefaults[k] ?? "";
  }
  return out;
}

export function findService(cfg: BuildConfig, ref?: string): ServiceConfig | undefined {
  if (ref) return cfg.services.find(s => s.name === ref || s.path === ref);
  return cfg.services.length === 1 ? cfg.services[0] : undefined;
}
