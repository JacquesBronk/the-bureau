import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpAuth } from "./registry.js";

export type SecretResolver = (secretRef: string) => Record<string, string>;

/** Read a k8s Secret's keys from its projected-volume directory. k8s mounts each
 *  Secret key as a file named after the key whose contents are the value. */
export function defaultSecretResolver(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  const root = env.BUREAU_MCP_SECRETS_DIR;
  return (secretRef: string): Record<string, string> => {
    if (!root) return {};
    const dir = join(root, secretRef);
    if (!existsSync(dir)) return {};
    const out: Record<string, string> = {};
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isFile()) out[name] = readFileSync(p, "utf8").trim();
    }
    return out;
  };
}

/** Translate an entry's auth + resolved secret into outbound request headers. */
export function authHeaders(auth: McpAuth, secrets: Record<string, string>): Record<string, string> {
  switch (auth.mode) {
    case "headers": return { ...secrets };
    case "bearer": return secrets.token ? { Authorization: `Bearer ${secrets.token}` } : {};
    case "none": return {};
  }
}
