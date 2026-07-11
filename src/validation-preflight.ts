/**
 * Fail-fast TCP preflight for integration-validation gate pods.
 *
 * An `integration` gate leases ephemeral test services (redis/postgres) and injects
 * their connection strings as $BUREAU_REDIS_URL / $BUREAU_POSTGRES_URL into the exec
 * criterion pod (see graph-dispatch.ts). If the service is unreachable — e.g. a
 * NetworkPolicy egress gap on the `bureau-worker` pod (the-bureau #268) — a typical
 * test suite's Redis/PG client retries the connection *forever*, so the gate pod hangs
 * until task timeout (observed: 20+ min at 0/1 done) instead of failing. The gate then
 * provides no signal and burns a pod.
 *
 * This preflight is prepended to the synthesized gate command. The worker entrypoint
 * runs the command under `bash -lc`, so it can use bash's `/dev/tcp` to bound the wait
 * for each declared service (~30s) and exit non-zero fast, turning a genuine
 * connectivity failure into a seconds-long failure instead of a hang. Once the service
 * is reachable the preflight is a sub-second no-op.
 *
 * Portability: worker images are `node:22-slim` (Debian bookworm) and the entrypoint
 * uses `bash -lc`, so bash `/dev/tcp`, `$SECONDS`, `sleep`, and coreutils `timeout` are
 * all present; `redis-cli` / `nc` / `psql` are NOT guaranteed, which is why this uses
 * `/dev/tcp` rather than a service-specific CLI. IPv6 hosts are not supported (same
 * limitation as the Redis NAT-map parser); the URLs injected here are always in-cluster
 * DNS names.
 *
 * Each connect attempt is wrapped in `timeout` so a *dropped* SYN (a NetworkPolicy that
 * DROPs rather than REJECTs) can't block on the kernel TCP handshake timeout — without
 * this the preflight would itself hang on exactly the failure mode it exists to catch.
 * An overall `$SECONDS` deadline bounds total wait regardless of drop-vs-reject.
 */

const SVC: Record<string, { env: string; port: number }> = {
  redis: { env: "BUREAU_REDIS_URL", port: 6379 },
  postgres: { env: "BUREAU_POSTGRES_URL", port: 5432 },
};

/**
 * Build the bash preflight prefix for the given declared test services.
 *
 * Returns a single-line snippet of the form `<fn-def>; <call1> && <call2>` (no trailing
 * separator) so the caller can splice it into the gate command as
 * `${preflight} && <install> && <test>`. Returns "" when no known service is declared,
 * so the gate command is unchanged for non-integration / service-less graphs.
 */
export function buildIntegrationPreflight(testServices: readonly string[] | undefined): string {
  const svcs = (testServices ?? []).filter((s) => s in SVC);
  if (svcs.length === 0) return "";

  // Defined on one line so it survives as a single BUREAU_EXEC_CMD env value.
  // Args: $1 connection URL, $2 human label, $3 default port.
  const fn =
    '__bureau_wait_svc(){ ' +
    'u="$1"; n="$2"; dp="$3"; ' +
    'if [ -z "$u" ]; then echo "[bureau-gate] WARN: $n url unset, skipping preflight"; return 0; fi; ' +
    'hp="${u#*://}"; hp="${hp##*@}"; hp="${hp%%/*}"; h="${hp%%:*}"; p="${hp##*:}"; ' +
    'if [ "$p" = "$h" ] || [ -z "$p" ]; then p="$dp"; fi; ' +
    'echo "[bureau-gate] preflight: waiting up to 30s for $n at $h:$p"; ' +
    'end=$((SECONDS+30)); ' +
    'while [ "$SECONDS" -lt "$end" ]; do ' +
    'if timeout 3 bash -c "exec 3<>/dev/tcp/$h/$p" 2>/dev/null; then echo "[bureau-gate] $n reachable"; return 0; fi; ' +
    'sleep 1; done; ' +
    'echo "[bureau-gate] FATAL: $n unreachable at $h:$p after 30s (leased test-service egress/lease failure — see the-bureau #268) — failing gate fast" >&2; ' +
    'return 1; }';

  const calls = svcs
    .map((s) => `__bureau_wait_svc "$${SVC[s].env}" ${s} ${SVC[s].port}`)
    .join(" && ");

  return `${fn}; ${calls}`;
}

// Test-file path patterns (#320). Toolchain-independent: a `.test.ts` path is a
// node test file regardless of declared toolchain; a `test_x.py` path is pytest's.
// No toolchain lookup needed — see design doc for the rationale.
const NODE_TEST_FILE_RE = /\.(test|spec)\.(c|m)?[jt]sx?$/;
const PYTHON_TEST_FILE_RE = /(^|\/)(test_[^/]+|[^/]+_test)\.py$/;
// [PT-F1] Any glob metacharacter disqualifies a token: `[ -e "$f" ]` does NOT expand
// a quoted glob, so a whole-dir command like `vitest run tests/**/*.test.ts` would
// otherwise look for a literal (nonexistent) file named `tests/**/*.test.ts` and
// false-fail the gate. Only literal paths are ever enumerated.
const GLOB_META_RE = /[*?[\]{}]/;

/**
 * Extract test-file paths referenced by a gate `command` and build a bash
 * existence-check preflight for them (#320: a `vitest run <file-list>` gate
 * treats missing args as filters and false-greens instead of failing when a
 * referenced test file was renamed/deleted).
 *
 * Extraction (TypeScript, not fragile bash tokenization) — a token is kept only if
 * it contains a path separator `/` (a path, not a bare substring filter), matches a
 * known test-file pattern (node/vitest/jest or python/pytest), does NOT contain a
 * glob metacharacter [PT-F1], does NOT start with `-` (a flag value) [PT-F3], and
 * does NOT contain a single quote (can't be safely embedded — real test paths never
 * do). Duplicate paths are deduped.
 *
 * Returns "" when no test-file paths are found (e.g. a whole-suite `vitest run` /
 * `npm test` command), so the caller's splice is a byte-unchanged no-op.
 */
export function buildTestFileExistencePreflight(command: string): string {
  const paths = new Set<string>();

  for (const raw of command.split(/\s+/).filter(Boolean)) {
    let token = raw;
    const first = token[0];
    const last = token[token.length - 1];
    if (token.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
      token = token.slice(1, -1);
    }

    if (!token.includes("/")) continue;
    if (token.startsWith("-")) continue;
    if (GLOB_META_RE.test(token)) continue;
    if (token.includes("'")) continue;
    if (!(NODE_TEST_FILE_RE.test(token) || PYTHON_TEST_FILE_RE.test(token))) continue;

    paths.add(token);
  }

  if (paths.size === 0) return "";

  // Single-line fn-def + call so it survives as one BUREAU_EXEC_CMD env value,
  // mirroring buildIntegrationPreflight's splice pattern above.
  const fileList = [...paths].map((p) => `'${p}'`).join(" ");
  return (
    "__bureau_check_files(){ " +
    `for f in ${fileList}; do ` +
    '[ -e "$f" ] || { echo "[bureau-gate] FATAL: referenced test file $f is missing — failing gate (a renamed/deleted test would otherwise be silently skipped, #320)" >&2; return 1; }; ' +
    "done; }; __bureau_check_files"
  );
}
