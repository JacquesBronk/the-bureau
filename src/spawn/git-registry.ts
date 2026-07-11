import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { loadRemoteMergeConfig } from "./remote-merge.js";
import { loadBureauConfig } from "../mcp-config.js";

/** A named git destination. `secretRef` is the k8s Secret workers mount via
 *  secretKeyRef; `tokenEnv` is the env var the engine reads the PAT from. */
export interface GitDestination {
  name: string;
  url: string;
  baseRef: string;
  secretRef: string;
  tokenEnv: string;
  provider?: string;
  isDefault?: boolean;
  completionPolicy?: 'promote' | 'pr-only';
}

interface RegistryDoc {
  destinations?: Array<Partial<GitDestination> & { name: string; url: string; baseRef: string; secretRef: string }>;
}

/**
 * Load the git destination registry. Precedence:
 *   1. BUREAU_GIT_REGISTRY_FILE — a single YAML doc with a `destinations:` list.
 *   2. .bureau/config.json `destinations` key — new middle tier (requires cwd).
 *   3. BUREAU_GIT_URL — synthesize one default destination (back-compat).
 *   4. neither — [] (engine has no merge destinations; pod-mode merge stays off).
 */
export function loadGitRegistry(env: NodeJS.ProcessEnv = process.env, cwd?: string): GitDestination[] {
  // Tier 1: BUREAU_GIT_REGISTRY_FILE
  const file = env.BUREAU_GIT_REGISTRY_FILE;
  if (file && existsSync(file)) {
    let doc: RegistryDoc | null;
    try {
      doc = parseYaml(readFileSync(file, "utf8")) as RegistryDoc | null;
    } catch (err) {
      // Fail loud with a clear, actionable message rather than a raw YAML stack
      // trace at engine boot — a GitOps ConfigMap typo should be obvious in logs.
      throw new Error(`BUREAU_GIT_REGISTRY_FILE (${file}) is not valid YAML: ${String(err)}`);
    }
    const dests = (doc?.destinations ?? []).map((d) => ({
      tokenEnv: "BUREAU_GIT_TOKEN",
      completionPolicy: "promote" as const,
      ...d,
    })) as GitDestination[];
    for (const d of dests) {
      if (!d.name || !d.url || !d.baseRef || !d.secretRef) {
        throw new Error(
          `git registry entry is missing a required field (name/url/baseRef/secretRef): ${JSON.stringify(d)}`,
        );
      }
    }
    if (dests.length > 0) return dests;
  }

  // Tier 2: .bureau/config.json destinations
  if (cwd) {
    const config = loadBureauConfig(cwd);
    if (config.destinations && config.destinations.length > 0) {
      return config.destinations.map((d) => ({
        name: d.name,
        url: d.url,
        baseRef: d.baseRef,
        secretRef: d.secretRef,
        tokenEnv: d.tokenEnv ?? "BUREAU_GIT_TOKEN",
        completionPolicy: d.completionPolicy ?? "promote",
        ...(d.isDefault !== undefined && { isDefault: d.isDefault }),
        ...(d.provider !== undefined && { provider: d.provider }),
      }));
    }
  }

  // Tier 3: BUREAU_GIT_URL (legacy back-compat)
  const base = loadRemoteMergeConfig(env); // null when BUREAU_GIT_URL unset
  if (!base) return [];
  return [{
    name: env.BUREAU_GIT_DEFAULT_DEST_NAME || "default",
    url: base.gitUrl,
    baseRef: base.baseRef,
    secretRef: env.BUREAU_GIT_SECRET || "bureau-git",
    tokenEnv: "BUREAU_GIT_TOKEN",
    isDefault: true,
    completionPolicy: "promote",
  }];
}

/** Resolve a destination by name, or the default (isDefault, else first) when
 *  no name is given. Returns undefined for an unknown name or empty registry. */
export function resolveDestination(
  registry: GitDestination[],
  name?: string,
): GitDestination | undefined {
  if (name) return registry.find((d) => d.name === name);
  return registry.find((d) => d.isDefault) ?? registry[0];
}
