import type { AuthMode } from "./config.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Refuse to serve unauthenticated on a non-loopback bind (R11 — inverts the
 *  historical silent fail-open). `none` is allowed only on loopback (dev). */
export function assertBindAllowed(mode: AuthMode, host: string): void {
  if (mode === "oidc") return;
  if (LOOPBACK.has(host)) return;
  throw new Error(
    `fail-closed: BUREAU_AUTH_MODE=none is only permitted on a loopback bind; ` +
    `refusing to serve on ${host}. Set BUREAU_AUTH_MODE=oidc (with BUREAU_AUTH_ISSUER) ` +
    `or bind to 127.0.0.1.`,
  );
}
