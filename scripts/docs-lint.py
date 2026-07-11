#!/usr/bin/env python3
"""Detect internal / non-public content in the docs tree.

Categories:
  infra        homelab hostnames, IPs, cluster/infra names  (MUST remove)
  commit_sha   git commit hashes and ranges in prose         (dev noise)
  issue_ref    #NNN issue references to the private tracker   (dev noise)
  version      release/version churn narrative                (dev noise)
  provenance   verification / re-anchor / dogfood prose       (dev noise)

Code:line citations (src/foo.ts:123) are NOT flagged — they are useful and
point at this repo's source.

Exit non-zero if any 'infra' hit is found (the hard gate); other categories
are reported for the cleanup pass but do not fail by default.
"""
import os, re, sys
from collections import defaultdict

D = os.path.join(os.path.dirname(__file__), "..", "docs")
D = os.path.abspath(D)

PATTERNS = {
    # Generic IdP product names (Keycloak, Cloudflare Access) are allowed as
    # *examples*; only homelab-specific identifiers are hard leaks.
    "infra": re.compile(
        r"jcqb\.dev|forgejo\.local|forgejo\.forgejo|h\.jcqb|"
        r"\b192\.168\.\d+\.\d+|\b10\.43\.\d+|green-night|"
        r"registry\.local|redis\.local|"
        r"son-of-anton|\bpve2\b|\bai-node\b|adguard|klipper",
        re.I),
    "commit_sha": re.compile(r"\bcommit [0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b|@[0-9a-f]{7,40}\b"),
    "issue_ref": re.compile(r"(?<![\w/])#\d{2,4}\b"),
    "version": re.compile(r"\brelease: v\d|\bv\d+\.\d+\.\d+"),
    "provenance": re.compile(
        r"re-pinned|re-anchor|byte-for-byte|\bgit log\b|coverage-map|"
        r"HEAD `|\bdogfood|status: verified|verified against|adversarial", re.I),
}

def main():
    per_file = defaultdict(lambda: defaultdict(int))
    totals = defaultdict(int)
    for root, _, files in os.walk(D):
        for f in sorted(files):
            if not f.endswith(".md"):
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, D)
            text = open(p, encoding="utf-8").read()
            for cat, rx in PATTERNS.items():
                n = len(rx.findall(text))
                if n:
                    per_file[rel][cat] = n
                    totals[cat] += n

    cats = list(PATTERNS)
    hdr = f"{'file':52} " + " ".join(f"{c:>10}" for c in cats)
    print(hdr)
    print("-" * len(hdr))
    for rel in sorted(per_file):
        row = per_file[rel]
        print(f"{rel[:52]:52} " + " ".join(f"{row.get(c,0):>10}" for c in cats))
    print("-" * len(hdr))
    print(f"{'TOTAL':52} " + " ".join(f"{totals.get(c,0):>10}" for c in cats))
    print(f"\nfiles with any internal content: {len(per_file)}")
    if totals["infra"]:
        print(f"\nFAIL: {totals['infra']} infra leak(s) — must be removed before publish.")
        return 1
    print("\nOK: no infra leaks. (dev-noise categories above are for the cleanup pass.)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
