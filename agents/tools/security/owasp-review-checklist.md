# OWASP Security Review Checklist
> Systematic vulnerability checklist based on OWASP Top 10 (2021) and CWE Top 25 (2023).

## When to Use
Load this tool when performing a security review of application code. Work through each category in order. Skip categories only when the technology is provably absent (e.g., skip SQL injection for a project with no database).

## How to Use
For each category: (1) check the listed items, (2) note findings with file/line, (3) assign a CWE ID from the listed mappings, (4) move to the next category. After completing all categories, run the supply chain checks at the end.

---

## A01: Broken Access Control (CWE-862, CWE-639, CWE-284, CWE-200)

- [ ] Every endpoint enforces authentication — no unprotected routes that should require login
- [ ] Authorization checks verify the requesting user owns/can access the specific resource (no IDOR)
- [ ] Role/permission checks use allowlists, not denylists ("user must have role X" not "user must not have role Y")
- [ ] Directory traversal: file paths constructed from user input are canonicalized and confined to an allowed directory
- [ ] CORS policy restricts origins to an explicit allowlist — not `*` or reflection of the Origin header
- [ ] API responses do not include fields the requesting user is not authorized to see
- [ ] JWT/session tokens are validated on every request, not just at login

## A02: Cryptographic Failures (CWE-327, CWE-328, CWE-916, CWE-311)

- [ ] No use of broken algorithms: MD5, SHA1 (for security purposes), DES, RC4, ECB mode
- [ ] Passwords hashed with bcrypt, scrypt, or argon2 — not SHA-256 or PBKDF2 with low iterations
- [ ] TLS enforced for all external communication — no HTTP fallbacks
- [ ] Encryption keys and IVs are not hardcoded; IVs/nonces are unique per operation
- [ ] Sensitive data at rest is encrypted (PII, credentials, tokens in databases)
- [ ] Key lengths meet minimums: RSA >= 2048, AES >= 128, ECDSA >= 256

## A03: Injection (CWE-79, CWE-89, CWE-78, CWE-917)

- [ ] SQL queries use parameterized statements or ORM — no string concatenation/interpolation
- [ ] NoSQL queries (MongoDB, etc.) do not pass unsanitized objects from user input
- [ ] OS command execution: no shell=True with user input; prefer library APIs over exec/spawn
- [ ] XSS: all user-supplied content is escaped before rendering in HTML/JS context
- [ ] Template injection: user input never used as template source (Jinja2, Handlebars, etc.)
- [ ] LDAP/XPath/XML injection: user input is escaped for the specific query language
- [ ] Log injection: user input in log messages cannot inject newlines or control characters

## A04: Insecure Design (CWE-209, CWE-256, CWE-501)

- [ ] Rate limiting on authentication endpoints (login, password reset, OTP verification)
- [ ] Rate limiting on expensive operations (search, export, file upload)
- [ ] Business logic abuse: multi-step flows enforce state transitions server-side (can't skip steps)
- [ ] Error messages do not reveal internal state (stack traces, SQL errors, internal IPs, software versions)
- [ ] Account enumeration prevented: login/registration responses are identical for valid/invalid users

## A05: Security Misconfiguration (CWE-16, CWE-611, CWE-1004)

- [ ] Debug mode disabled in production configuration
- [ ] Default credentials changed or removed (admin/admin, test accounts)
- [ ] Security headers present: Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options, Content-Security-Policy
- [ ] XML parsing disables external entity resolution (XXE prevention)
- [ ] Directory listing disabled on web servers
- [ ] Error pages do not expose framework/version information
- [ ] Cookie flags set: Secure, HttpOnly, SameSite=Lax or Strict

## A06: Vulnerable and Outdated Components (CWE-1104)

- [ ] No dependencies with known critical/high CVEs (check against advisory databases)
- [ ] Dependencies pinned to specific versions (not floating ranges like `^` or `~` for security-critical packages)
- [ ] No dependencies abandoned for >2 years without a maintained fork
- [ ] Lock file (package-lock.json, yarn.lock, poetry.lock, etc.) is committed and up to date
- [ ] No unnecessary dependencies — each dependency earns its place

## A07: Identification and Authentication Failures (CWE-287, CWE-384, CWE-613)

- [ ] Passwords have minimum length (8+) and are checked against breach databases or common password lists
- [ ] Multi-factor authentication available for sensitive operations
- [ ] Session tokens regenerated after authentication (prevents session fixation)
- [ ] Session timeout enforced — both idle timeout and absolute timeout
- [ ] Password reset tokens are single-use, time-limited, and cryptographically random
- [ ] Failed login attempts are throttled or locked after N failures

## A08: Software and Data Integrity Failures (CWE-502, CWE-829)

- [ ] Deserialization of untrusted data: no `pickle.loads()`, `unserialize()`, `JSON.parse()` on unvalidated input without schema validation
- [ ] CI/CD pipeline integrity: build scripts do not execute arbitrary code from PRs without review
- [ ] Subresource integrity (SRI) hashes on CDN-loaded scripts/styles
- [ ] Auto-update mechanisms verify signatures before applying updates
- [ ] No `eval()`, `Function()`, or dynamic code execution with user-controlled input

## A09: Security Logging and Monitoring Failures (CWE-778, CWE-223)

- [ ] Authentication events logged (login success/failure, logout, password changes)
- [ ] Authorization failures logged with enough context to investigate
- [ ] Logs do not contain sensitive data (passwords, tokens, PII, credit card numbers)
- [ ] Log injection prevented — user input in logs is sanitized
- [ ] Monitoring/alerting exists for brute force attempts and anomalous patterns

## A10: Server-Side Request Forgery — SSRF (CWE-918)

- [ ] URLs from user input are validated against an allowlist of domains/IPs
- [ ] Internal network addresses blocked: 127.0.0.1, 10.x, 172.16-31.x, 192.168.x, 169.254.x, ::1
- [ ] URL schemes restricted to https (or http if required) — no file://, gopher://, dict://
- [ ] Redirects from user-supplied URLs are not followed blindly — validate the final destination
- [ ] DNS rebinding considered: resolve the hostname and validate the IP before making the request

---

## Supply Chain Checks

These checks apply regardless of OWASP category:

- [ ] `.gitignore` covers: `.env`, `*.pem`, `*.key`, credentials files, IDE configs with tokens
- [ ] No secrets in git history (API keys, passwords, tokens) — check recent commits if feasible
- [ ] Docker images use specific tags (not `latest`) and come from trusted registries
- [ ] GitHub Actions / CI workflows pin actions to commit SHAs, not mutable tags
- [ ] No postinstall scripts in dependencies that execute arbitrary network requests
- [ ] Typosquatting check: verify package names are spelled correctly (e.g., `lodash` not `1odash`)

## Iron Law
Do not skip a category because it "probably doesn't apply." Check it, confirm it doesn't apply, and document that you checked. False negatives in security reviews are worse than false positives.

## Red Flags
- "This is an internal tool, so injection doesn't matter" — Internal tools get compromised. Check it.
- "The framework handles that" — Verify the framework is configured correctly. Defaults are not always secure.
- "There's no user input here" — Trace the data flow. Input may arrive indirectly via database, message queue, or API.
- "I'll flag it as Low and move on" — If you can describe a realistic attack, it's not Low. Grade by exploitability.
