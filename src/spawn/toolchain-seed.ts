import type { Toolchain } from "./toolchain-registry.js";

/** The set of worker images to approve in the ImageCatalog at boot: every
 *  registry image plus the back-compat default (so the dogfood Node path is
 *  never gated out). Deduped. */
export function toolchainImages(registry: Toolchain[], defaultImage: string): string[] {
  const set = new Set<string>(registry.map((t) => t.image));
  set.add(defaultImage);
  return [...set];
}
