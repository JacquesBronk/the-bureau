import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/** A named worker toolchain. `image` is gated by ImageCatalog at dispatch. The
 *  command fields are parsed but UNUSED in Phase 1 — kept so the YAML format is
 *  forward-stable for Phase 2 (descriptor + worker-side validation). */
export interface Toolchain {
  name: string;
  image: string;
  isDefault?: boolean;
  install?: string;
  build?: string;
  test?: string;
  lint?: string;
}

interface RegistryDoc {
  toolchains?: Array<Partial<Toolchain> & { name: string; image: string }>;
}

const DEFAULT_IMAGE = "bureau-worker:latest";

/**
 * Load the toolchain registry. Precedence:
 *   1. BUREAU_TOOLCHAIN_REGISTRY_FILE — a single YAML doc with a `toolchains:` list.
 *   2. neither — synthesize one default `node` entry from BUREAU_WORKER_IMAGE (back-compat).
 */
export function loadToolchainRegistry(env: NodeJS.ProcessEnv = process.env): Toolchain[] {
  const file = env.BUREAU_TOOLCHAIN_REGISTRY_FILE;
  if (file && existsSync(file)) {
    let doc: RegistryDoc | null;
    try {
      doc = parseYaml(readFileSync(file, "utf8")) as RegistryDoc | null;
    } catch (err) {
      throw new Error(`BUREAU_TOOLCHAIN_REGISTRY_FILE (${file}) is not valid YAML: ${String(err)}`);
    }
    const entries = (doc?.toolchains ?? []) as Toolchain[];
    for (const t of entries) {
      if (!t.name || !t.image) {
        throw new Error(
          `toolchain registry entry is missing a required field (name/image): ${JSON.stringify(t)}`,
        );
      }
    }
    if (entries.length > 0) return entries;
    // File present and parsed, but no entries — warn and fall through to synth default.
    console.warn(
      `BUREAU_TOOLCHAIN_REGISTRY_FILE (${file}) has an empty toolchains list; falling back to synthesized default node entry.`,
    );
  }

  return [{ name: "node", image: env.BUREAU_WORKER_IMAGE || DEFAULT_IMAGE, isDefault: true }];
}

/** Resolve a toolchain by name, or the default (isDefault, else first) when no
 *  name is given. Returns undefined for an unknown name or empty registry. */
export function resolveToolchain(registry: Toolchain[], name?: string): Toolchain | undefined {
  if (name) return registry.find((t) => t.name === name);
  return registry.find((t) => t.isDefault) ?? registry[0];
}
