# Security Severity Assessment
> Structured severity grading for security findings with CWE mapping and exploitability scoring.

## When to Use
Load this tool when writing up security findings. Use it to assign consistent severity levels and CWE identifiers. Every finding must go through this assessment before being reported.

## Process

For each finding, answer these four questions in order. The answers determine the severity.

### Step 1: Identify the CWE

Map the vulnerability to the most specific CWE entry. Use these common mappings as a starting point:

| Vulnerability Type | Primary CWE | Related CWEs |
|---|---|---|
| SQL Injection | CWE-89 | CWE-564 |
| OS Command Injection | CWE-78 | CWE-77 |
| Cross-Site Scripting (XSS) | CWE-79 | CWE-80, CWE-87 |
| Path Traversal | CWE-22 | CWE-23, CWE-36 |
| SSRF | CWE-918 | — |
| Broken Authentication | CWE-287 | CWE-306, CWE-384 |
| Broken Access Control (IDOR) | CWE-639 | CWE-862, CWE-863 |
| Missing Authorization | CWE-862 | CWE-285 |
| Hardcoded Credentials | CWE-798 | CWE-259 |
| Sensitive Data Exposure | CWE-200 | CWE-209, CWE-532 |
| Insecure Deserialization | CWE-502 | — |
| Weak Cryptography | CWE-327 | CWE-328, CWE-916 |
| Open Redirect | CWE-601 | — |
| CSRF | CWE-352 | — |
| XXE | CWE-611 | — |
| Race Condition | CWE-362 | CWE-367 |
| Integer Overflow | CWE-190 | CWE-191 |
| Buffer Overflow | CWE-120 | CWE-787, CWE-125 |
| Use After Free | CWE-416 | — |
| Improper Input Validation | CWE-20 | — |

If the vulnerability doesn't map cleanly, use the closest parent CWE and note the specifics in the finding description.

### Step 2: Assess Exploitability

Score each factor:

| Factor | High (3) | Medium (2) | Low (1) |
|---|---|---|---|
| **Attack Vector** | Network/remote, no auth required | Network with auth, or adjacent network | Local access or physical required |
| **Complexity** | No special conditions needed | Requires specific config or timing | Requires chaining multiple conditions |
| **Privileges Required** | None (anonymous) | Low (any authenticated user) | High (admin or specific role) |
| **User Interaction** | None | Victim must click a link or visit a page | Victim must perform unusual actions |

**Exploitability Score** = sum of four factors (4-12)

### Step 3: Assess Impact

Score each factor:

| Factor | High (3) | Medium (2) | Low (1) |
|---|---|---|---|
| **Confidentiality** | All data accessible or secrets exposed | Partial data leak (some records, non-critical secrets) | Minimal info disclosure (versions, paths) |
| **Integrity** | Arbitrary data modification, RCE | Modify some data or inject limited content | Cosmetic or self-only modification |
| **Availability** | Full service denial | Degraded performance or partial outage | Negligible impact |

**Impact Score** = sum of three factors (3-9)

### Step 4: Determine Severity

Combine exploitability and impact scores:

| Exploitability | Impact 7-9 | Impact 4-6 | Impact 1-3 |
|---|---|---|---|
| **10-12** | Critical | High | Medium |
| **7-9** | High | Medium | Low |
| **4-6** | Medium | Low | Low |

### Override Conditions

Regardless of the score, upgrade to **Critical** if:
- Real secrets (API keys, passwords, private keys) are exposed in code or responses
- Authentication can be completely bypassed
- Remote code execution is achievable
- SQL injection yields full database access

Regardless of the score, downgrade by one level if:
- The vulnerable code path is unreachable in the current deployment
- An upstream control (WAF, reverse proxy, network segmentation) fully mitigates the vector
- Document the mitigation — it may be removed later

## Output Template

Use this structure for each finding:

```
### [SEVERITY] CWE-NNN: Vulnerability Title

**Location:** `path/to/file.ext:LINE`
**CWE:** CWE-NNN — Vulnerability Name
**Exploitability:** SCORE/12 (vector: X, complexity: X, privileges: X, interaction: X)
**Impact:** SCORE/9 (confidentiality: X, integrity: X, availability: X)

**Attack Vector:**
Step-by-step description of how an adversary would exploit this.

**Proof of Concept:**
Example payload, request, or code path. Never include real secrets — use {{PLACEHOLDER}}.

**Remediation:**
Specific code change. Show the fix, not just "sanitize input."
```

## Iron Law
Every finding gets a CWE ID and a scored severity. No "it feels like a Medium." Show the math.

## Red Flags
- "This is Critical because injection is always Critical" — Score it. SQL injection with no data and local-only access is not the same as SQL injection on a public API with PII.
- "Low because it's just information disclosure" — CWE-200 with internal IP ranges or stack traces enables further attacks. Score the impact of what's disclosed.
- "I'll skip the CWE, it's obvious" — CWE IDs enable tracking, deduplication, and trend analysis. Always include them.
