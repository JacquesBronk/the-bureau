#!/usr/bin/env python3
"""docs-anchor.py — resolve a symbol-anchored citation to a {span, hash} cache entry.

The documentation system anchors every code claim on a STABLE symbol (a function /
class / interface / type / const name) rather than a line number. Line numbers drift on
every insertion above them; a symbol name only changes when the code is genuinely
renamed or deleted. This helper turns an anchor (file + symbol) into the small cache the
freshness check needs:

  - span  = [start, end]  the symbol's line extent in the file, at the given commit
  - hash  = sha1(span text)[:12]  a fingerprint of the symbol body at verify time

Both are recorded in the coverage map at VERIFICATION time, in the same commit
coordinates as the note's `verified_sha`. The cheap freshness check then asks only:
"did any line changed between verified_sha..HEAD fall inside a cited span?" — no LLM, no
quipu, no network. quipu is used at the expensive verify step to locate the symbol's
start line; this helper is the deterministic span+hash half that must agree everywhere.

The span END is resolved by brace-matching for block symbols (interface/class/function/
enum) and is single-line for `const`/`type` one-liners. It is deliberately biased to
OVER-include (extend to the next top-level `export` if a block never closes cleanly):
a span that is a little too wide only costs a spurious re-verify; a span that is too
narrow could miss real drift. Suspicion over precision — the LLM verify is ground truth.

Usage:
  docs-anchor.py span  <file> <symbol> [--sha SHA] [--repo DIR]
      -> prints:  <start> <end> <hash>
  docs-anchor.py check <file> <symbol> --span A B --hash H [--sha SHA] [--repo DIR]
      -> exit 0 if the symbol still hashes to H at --sha; exit 3 if drifted; 4 if absent
"""
import argparse, hashlib, re, subprocess, sys

# an exported (or bare) declaration for a named symbol
DECL = re.compile(
    r'^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?'
    r'(?:abstract\s+)?(?:function|class|interface|enum|type|const|let|var)\s+'
    r'([A-Za-z_$][\w$]*)'
)
# any top-level export — used as the over-inclusive fallback boundary
TOP_EXPORT = re.compile(r'^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?'
                        r'(?:abstract\s+)?(?:function|class|interface|enum|type|const|let|var)\s+')


def file_at(repo, sha, path):
    if sha:
        out = subprocess.run(["git", "-C", repo, "show", f"{sha}:{path}"],
                             capture_output=True, text=True)
        if out.returncode != 0:
            sys.exit(f"ERROR: cannot read {path}@{sha}: {out.stderr.strip()}")
        return out.stdout.splitlines()
    with open(f"{repo}/{path}", errors="ignore") as fh:
        return fh.read().splitlines()


def find_span(lines, symbol):
    """Return (start, end) 1-indexed inclusive, or None if the symbol is absent."""
    start = None
    for i, line in enumerate(lines):
        m = DECL.match(line)
        if m and m.group(1) == symbol:
            start = i  # 0-indexed
            break
    if start is None:
        return None
    decl = lines[start]
    # one-liner (type alias / simple const with no open brace that stays open)
    opens = decl.count("{") + decl.count("(") + decl.count("[")
    closes = decl.count("}") + decl.count(")") + decl.count("]")
    if opens == 0 or opens == closes:
        # single logical line, but a `const x = {` style may open on this line only;
        # if balanced already, it's one line
        return (start + 1, start + 1)
    # brace-match forward
    depth = opens - closes
    j = start
    while j + 1 < len(lines) and depth > 0:
        j += 1
        depth += lines[j].count("{") + lines[j].count("(") + lines[j].count("[")
        depth -= lines[j].count("}") + lines[j].count(")") + lines[j].count("]")
    if depth > 0:
        # never closed cleanly — over-include to the line before the next top-level export
        j = start
        while j + 1 < len(lines):
            j += 1
            if TOP_EXPORT.match(lines[j]):
                j -= 1
                break
    return (start + 1, j + 1)


def span_hash(lines, span):
    start, end = span
    body = "\n".join(lines[start - 1:end])
    return hashlib.sha1(body.encode("utf-8")).hexdigest()[:12]


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("span", "check"):
        p = sub.add_parser(name)
        p.add_argument("file")
        p.add_argument("symbol")
        p.add_argument("--sha", default=None)
        p.add_argument("--repo", default=".")
        if name == "check":
            p.add_argument("--span", nargs=2, type=int, required=True)
            p.add_argument("--hash", required=True)
    args = ap.parse_args()

    lines = file_at(args.repo, args.sha, args.file)
    span = find_span(lines, args.symbol)
    if span is None:
        if args.cmd == "check":
            print(f"ABSENT {args.symbol}", file=sys.stderr)
            sys.exit(4)
        sys.exit(f"ERROR: symbol {args.symbol} not found in {args.file}")

    if args.cmd == "span":
        print(f"{span[0]} {span[1]} {span_hash(lines, span)}")
        return
    # check
    h = span_hash(lines, span)
    if h == args.hash:
        sys.exit(0)
    print(f"DRIFT {args.symbol} span={span} hash={h} expected={args.hash}", file=sys.stderr)
    sys.exit(3)


if __name__ == "__main__":
    main()
