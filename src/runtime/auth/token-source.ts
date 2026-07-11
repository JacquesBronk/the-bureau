type Headers = Record<string, string | string[] | undefined>;

function firstHeader(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Strip an optional `Bearer ` scheme; return the trimmed remainder, or undefined if empty. */
function stripBearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  return v.toLowerCase().startsWith("bearer ") ? v.slice(7).trim() || undefined : v;
}

/** Extract the bearer JWT from the incoming request headers.
 *
 *  Default (`tokenHeader` unset/Authorization): read `Authorization`, requiring the
 *  `Bearer ` scheme — the engine-signed worker/operator path. Behavior unchanged.
 *
 *  When `tokenHeader` names a gateway-injected assertion header (e.g.
 *  `Cf-Access-Jwt-Assertion` behind Cloudflare Access — a raw JWT, no `Bearer ` prefix),
 *  read it first, then fall back to `Authorization: Bearer` so in-cluster workers/operators
 *  that never traverse the gateway keep working.
 *
 *  Header names are matched case-insensitively (Node lowercases incoming header keys). */
export function extractToken(headers: Headers, tokenHeader?: string): string | undefined {
  const name = (tokenHeader ?? "authorization").toLowerCase();
  if (name !== "authorization") {
    const fromHeader = stripBearer(firstHeader(headers[name]));
    if (fromHeader) return fromHeader;
  }
  const auth = firstHeader(headers["authorization"]);
  return auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() || undefined : undefined;
}
