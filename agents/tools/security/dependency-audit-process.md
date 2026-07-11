# Dependency Audit Process
> Structured workflow for auditing project dependencies: ecosystem detection, vulnerability scanning, license compliance, transitive risk, and SBOM generation.

## When to Use
Load this tool when performing a dependency audit on any project. Follow the phases in order — do not skip phases. Each phase produces findings that feed into the final report.

## Phase 1: Ecosystem Detection

Scan the project root for package manifests. A project may use multiple ecosystems.

| Manifest File | Ecosystem | Lock File | Scanner Command |
|---|---|---|---|
| `package.json` | npm/Node.js | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` | `npm audit --json`, `pnpm audit --json`, `yarn audit --json` |
| `pyproject.toml`, `requirements.txt`, `setup.py` | Python | `poetry.lock`, `requirements.txt` (pinned) | `pip-audit --format=json`, `safety check --json` |
| `Cargo.toml` | Rust | `Cargo.lock` | `cargo audit --json` |
| `go.mod` | Go | `go.sum` | `govulncheck ./...` |
| `Gemfile` | Ruby | `Gemfile.lock` | `bundler-audit check` |
| `pom.xml`, `build.gradle` | Java/JVM | (varies) | `mvn dependency-check:check`, `gradle dependencyCheckAnalyze` |
| `composer.json` | PHP | `composer.lock` | `composer audit` |

**Missing lock file is a finding.** If a manifest exists without its lock file, report it as a moderate-severity issue — builds are non-reproducible and vulnerable to supply chain substitution.

## Phase 2: Vulnerability Scanning

For each detected ecosystem:

1. Run the appropriate scanner command. Capture full JSON output.
2. Parse each vulnerability. For every CVE/advisory found, record:
   - Package name and installed version
   - Severity (critical/high/moderate/low) as reported by the scanner
   - CVE or advisory ID
   - Whether a fix version exists
   - Whether the dependency is direct or transitive
3. **Cross-reference critical/high findings** against the NVD or OSV database if the scanner output lacks detail. Use `research-methodology.md` discipline for this.
4. **Score ambiguous findings** using `severity-assessment.md` when the scanner severity seems miscalibrated (e.g., a "critical" with no network vector and no known exploit).

### Dev vs Production Dependencies

Classify each finding by dependency scope:
- **Production** (`dependencies`, default features, non-optional): Full severity applies.
- **Dev-only** (`devDependencies`, `[dev-dependencies]`, test extras): Downgrade severity by one level unless the vulnerability affects build output (e.g., malicious postinstall script, compromised build tool).

## Phase 3: Outdated Package Assessment

Run the ecosystem's outdated check (`npm outdated`, `pip list --outdated`, `cargo outdated`).

For each outdated package, assess:

| Factor | Action |
|---|---|
| Patch update available (x.y.Z) | Recommend update — low risk |
| Minor update available (x.Y.0) | Check changelog for breaking changes, then recommend |
| Major update available (X.0.0) | Flag for review — do NOT recommend auto-update. Note breaking changes from changelog |
| No updates for >2 years | Flag as potentially abandoned — check repo activity |
| Deprecated | Flag with replacement suggestion if available |

## Phase 4: License Compliance

1. **Read the project's own license** (LICENSE file, `license` field in manifest). This is the baseline.
2. **Extract licenses for all dependencies** (direct + transitive). Use `npm ls --all --json`, `pip-licenses`, `cargo-about`, or equivalent.
3. **Apply the compatibility matrix:**

| Project License | Allowed Dependency Licenses | Flagged (review needed) | Blocked |
|---|---|---|---|
| MIT | MIT, BSD-2, BSD-3, ISC, Apache-2.0, 0BSD, Unlicense | LGPL-2.1, LGPL-3.0, MPL-2.0 | GPL-2.0, GPL-3.0, AGPL-3.0, SSPL, BSL |
| Apache-2.0 | MIT, BSD-2, BSD-3, ISC, Apache-2.0, 0BSD, Unlicense | LGPL-2.1, LGPL-3.0, MPL-2.0 | GPL-2.0, GPL-3.0, AGPL-3.0, SSPL, BSL |
| GPL-3.0 | All OSI-approved | Proprietary, SSPL, BSL | None (GPL is maximally permissive inward) |
| Proprietary/Commercial | MIT, BSD-2, BSD-3, ISC, Apache-2.0, 0BSD, Unlicense | LGPL-2.1, LGPL-3.0, MPL-2.0 | GPL-2.0, GPL-3.0, AGPL-3.0 |

4. **Flag these license issues:**
   - `UNKNOWN` or missing license field — always flag
   - `SEE LICENSE IN <file>` — read the file, classify manually
   - Dual-licensed packages — note which license applies based on usage
   - License changed between installed version and latest version

## Phase 5: Transitive Dependency Risk

Assess the dependency tree for structural risks:

| Risk Factor | Detection | Severity |
|---|---|---|
| Tree depth > 5 levels | `npm ls --all`, `pip show`, `cargo tree` | Moderate — increases supply chain attack surface |
| Single-maintainer package in critical path | Check GitHub contributors, npm owner count | Moderate — bus factor risk |
| Package with <100 weekly downloads in production deps | Check registry stats | Low-Moderate — low community review |
| Package abandoned (no commits/releases in 2+ years) | Check repo last commit date | Moderate if no alternatives; High if CVEs exist |
| Dependency on fork (not original) | Check if package is a fork with low divergence | Low — note it, may indicate upstream abandonment |
| Typosquatting risk | Compare package names against known popular packages | High if detected |

## Phase 6: SBOM Generation (When Requested)

Generate a Software Bill of Materials when the task requests it or when the project has compliance requirements.

**Format selection:**
- **CycloneDX** — preferred for security-focused audits. Better vulnerability correlation. Use `cyclonedx-npm`, `cyclonedx-py`, `cargo-cyclonedx`.
- **SPDX** — preferred when license compliance is the primary concern. Richer license metadata. Use `spdx-sbom-generator`, `syft`.

**Minimum SBOM fields:** component name, version, package URL (purl), license, hash/checksum, direct/transitive classification.

## Report Structure

Compile findings into this format:

```
## Audit Summary
Ecosystems audited: [list]
Overall health: [healthy | caution | critical]
Total findings: X critical, Y high, Z moderate, W low

## Vulnerabilities
| Package | Severity | CVE | Description | Fix Version | Direct/Transitive | Scope |
|---------|----------|-----|-------------|-------------|-------------------|-------|

## Outdated Packages
| Package | Current | Latest | Update Type | Breaking Changes | Abandoned |
|---------|---------|--------|-------------|------------------|-----------|

## License Issues
| Package | Detected License | Issue | Recommendation |
|---------|-----------------|-------|----------------|

## Transitive Dependency Risks
[Deep trees, single-maintainer, abandoned deps, typosquatting concerns]

## SBOM
[Generated: yes/no. Format. Location.]

## Recommendations
[Prioritized actions. Most critical first. Include specific commands.]
```

## Iron Law
Never dismiss a vulnerability finding without stating the specific reason (e.g., "dev-only dependency not included in production build" or "CVE applies to server-side usage, this package is used client-side only"). Document every dismissal.

## Red Flags
- "No vulnerabilities found" after scanning — verify the scanner actually ran and parsed the lock file. An empty result from a project with 200+ dependencies warrants suspicion.
- "I'll skip the license check, it's all MIT" — verify. Transitive dependencies often introduce unexpected licenses.
- "This CVE doesn't apply" without checking the affected version range — always verify the installed version falls within (or outside) the vulnerable range.
- "It's just a dev dependency" — dev dependencies with malicious postinstall scripts compromise the build environment. Check the vulnerability type before downgrading.
- "I'll update everything to latest" — major version bumps introduce breaking changes. Check changelogs first.
