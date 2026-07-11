/**
 * source-maps.ts — #219 deliverable 2: source-mapped exception stacktraces.
 *
 * The production server runs from a single esbuild bundle
 * (dist/mcp-server.bundle.cjs). Without source-map support, every
 * `error.stack` frame — and therefore every OTel `exception.stacktrace`
 * recorded via span.recordException — points at the bundle artifact with
 * mangled names (e.g. `/app/mcp-server.bundle.cjs:9217`). quipu's THROW_SITE
 * parser can't match those to SCIP symbols.
 *
 * Node has native source-map support: when enabled, it reads the
 * `//# sourceMappingURL=` comment emitted alongside the bundle (see
 * scripts/bundle.sh `--sourcemap=linked`) and rewrites `Error.stack` to the
 * original `src/…ts` paths and un-minified names. recordException reads
 * `error.stack` after this rewrite, so no change is needed at the recording
 * sites — enabling it once at process start is sufficient.
 *
 * We use Node's built-in rather than the `source-map` npm package: it is
 * zero-dependency, handles the bundle's linked map automatically, and rewrites
 * lazily at stack-format time (no per-exception async resolution on the hot path).
 */

let enabled = false;

/**
 * Enable Node's native source-map support for `Error.stack` rewriting.
 *
 * Idempotent and best-effort: safe to call multiple times, and never throws
 * (a runtime without `process.setSourceMapsEnabled` simply no-ops). Call once
 * at process startup, before the first exception is recorded.
 */
export function enableSourceMaps(): void {
  if (enabled) return;
  try {
    if (typeof process.setSourceMapsEnabled === 'function') {
      process.setSourceMapsEnabled(true);
      enabled = true;
    }
  } catch {
    // Swallow — source-map support is an observability nicety, never load-bearing.
  }
}

/**
 * Reset internal state — unit tests only.
 * @internal
 */
export function _resetForTesting(): void {
  enabled = false;
}
