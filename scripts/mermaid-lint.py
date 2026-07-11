#!/usr/bin/env python3
"""mermaid-lint.py — scan Markdown for Mermaid code blocks and flag (or fix) the
syntax danglers that LLM-authored diagrams commonly produce.

Usage:
  scripts/mermaid-lint.py [--fix] [--json] PATH [PATH ...]

  PATH    files or directories (directories are recursed for *.md). Default: cwd.
  --fix   apply the safe mechanical fixes in place and re-report what remains.
  --json  emit findings as a JSON array instead of text.

Exit status:
  0  no unresolved issues (report mode: none found; --fix: all auto-fixable ones fixed
     and nothing left needing review)
  1  issues remain — either found in report mode, or review-only issues after --fix

Rules
  SEQ_SEMICOLON    [auto-fix]  ';' inside a sequenceDiagram message label. Mermaid treats
                               ';' as a statement separator, so it truncates the message and
                               errors ("expecting arrow, got NEWLINE"). Fix: ';' -> ','.

  Flowchart label breakers [review-only] — these break `flowchart`/`graph` diagrams by putting
  a grammar-significant character inside an UNQUOTED label. They are flagged, NOT auto-fixed:
  the safe fix is to wrap the label in "double quotes" (and convert \n -> <br>) or rename a node
  id, both of which need human judgement (renaming a node id means renaming every reference; a
  naive quote-insert can't reliably find the label span — see the dropped-rule note below).
    FLOW_NESTED_BRACKET   a '[' inside an unquoted [node label], e.g. K[uncovered: [E-03]].
                          Mermaid can't nest '[' — "got 'SQS'". ([[subroutine]] shapes excluded.)
    FLOW_PIPE_IN_NODE     a '|' inside an unquoted [node label], e.g. H[exit rc1||rc2].
                          '|' is edge-label syntax — "got 'PIPE'".
    FLOW_PAREN_IN_EDGE    a '(' or ')' inside an unquoted |edge label|, e.g. A -->|get()| B.
                          Parens aren't allowed there — "got 'PS'".
    FLOW_RESERVED_NODE_ID a reserved keyword used as a node id directly before a shape opener,
                          e.g. `--> graph[...]` or `end[...]`. graph/subgraph/end/class/etc. are
                          keywords — "got 'GRAPH'". (Reported only at statement-start or right
                          after a link arrow, and only when directly touching '['/'('/'{', so the
                          word merely appearing in label text — "child graph" — is NOT flagged.)

This ships PRECISE, low-false-positive rules rather than speculative ones: a linter that flags
valid diagrams gets ignored. The flowchart rules use character-class boundaries that stop at a
'"' so every "quoted" label is skipped, and require statement-position for the reserved-id rule.
(A flowchart LABEL_SEMICOLON rule was tried and dropped — a ';' inside a "quoted" label or an
HTML entity (&lt;/&gt;) is valid, and quoted labels can contain [](){} which defeats naive
span-matching, so it produced false positives on correct diagrams. The rules below only fire on
UNQUOTED labels for exactly that reason.)
"""
import sys, os, re, json

ARROW = r'(?:--?>>?|-->>?|->>|-\)|--\))'           # sequence arrows: ->>, -->>, -), --)
SEQ_MSG = re.compile(rf'{ARROW}\s*[^:]*:(.*)$')     # ...ARROW target: <message>

# --- flowchart label-breaker rules (review-only; UNQUOTED labels only) ---
# '[' opening a node label that is NOT the '[[' subroutine shape and NOT quoted, whose content
# (up to the first '"' or ']') contains another '[':
FLOW_NESTED_BRACKET = re.compile(r'[A-Za-z0-9_)\]}]\[(?!\[)[^"\]]*\[')
# ...whose content contains a '|':
FLOW_PIPE_IN_NODE   = re.compile(r'[A-Za-z0-9_)\]}]\[(?!\[)[^"\]|]*\|')
# A pipe-delimited edge label (right after a link char) whose unquoted content has a paren:
FLOW_PAREN_IN_EDGE  = re.compile(r'[->.=xo]\|(?!")[^"|]*[()][^"|]*\|')
# A reserved keyword used as a node id: at statement start or right after a link, directly
# touching a shape opener '[' '(' or '{' (a space before the opener => label text, skipped):
_RESERVED = r'(?:graph|subgraph|end|class|classDef|click|style|linkStyle|direction|flowchart)'
FLOW_RESERVED_NODE_ID = re.compile(
    rf'(?:^\s*|(?:--+|==+|-\.-*|\.-+)[.>xo]?\s*){_RESERVED}[\[({{]')

def _flowchart_findings(line):
    """Names of review-only breaker rules matching a single flowchart/graph body line."""
    out = []
    if FLOW_NESTED_BRACKET.search(line):   out.append('FLOW_NESTED_BRACKET')
    if FLOW_PIPE_IN_NODE.search(line):     out.append('FLOW_PIPE_IN_NODE')
    if FLOW_PAREN_IN_EDGE.search(line):    out.append('FLOW_PAREN_IN_EDGE')
    if FLOW_RESERVED_NODE_ID.search(line): out.append('FLOW_RESERVED_NODE_ID')
    return out

def md_files(paths):
    for p in paths:
        if os.path.isfile(p) and p.endswith('.md'):
            yield p
        elif os.path.isdir(p):
            for root, _, files in os.walk(p):
                for f in files:
                    if f.endswith('.md'):
                        yield os.path.join(root, f)

def scan(path):
    """Return (findings, fixed_text_or_None). findings: list of dicts."""
    text = open(path, encoding='utf-8').read()
    lines = text.split('\n')
    findings = []
    out = []
    in_mermaid = False
    diagram = None
    changed = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not in_mermaid and stripped.startswith('```mermaid'):
            in_mermaid = True; diagram = None
            out.append(line); continue
        if in_mermaid and stripped == '```':
            in_mermaid = False; diagram = None
            out.append(line); continue
        if in_mermaid:
            header = diagram is None and bool(stripped)   # the `flowchart TD` / `graph LR` line
            if header:
                diagram = stripped.split()[0].lower()
            newline = line
            if diagram == 'sequencediagram':
                m = SEQ_MSG.search(line)
                if m and ';' in m.group(1):
                    findings.append({'file': path, 'line': i + 1, 'rule': 'SEQ_SEMICOLON',
                                     'fixable': True, 'text': stripped[:100]})
                    head, _, msg = line.partition(':')
                    newline = head + ':' + msg.replace(';', ',')
                    if newline != line:
                        changed = True
            elif diagram in ('flowchart', 'graph') and not header:
                for rule in _flowchart_findings(line):
                    findings.append({'file': path, 'line': i + 1, 'rule': rule,
                                     'fixable': False, 'text': stripped[:100]})
            out.append(newline)
        else:
            out.append(line)
    fixed = '\n'.join(out)
    return findings, (fixed if changed else None)

def main():
    args = sys.argv[1:]
    do_fix = '--fix' in args
    as_json = '--json' in args
    paths = [a for a in args if not a.startswith('--')] or ['.']

    all_findings = []
    for path in sorted(set(md_files(paths))):
        findings, fixed = scan(path)
        if do_fix and fixed is not None:
            open(path, 'w', encoding='utf-8').write(fixed)
        all_findings.extend(findings)

    # after a --fix pass, the auto-fixable ones are resolved; only review items remain unresolved
    unresolved = [f for f in all_findings if not (do_fix and f['fixable'])]

    if as_json:
        print(json.dumps({'findings': all_findings, 'fixed': do_fix,
                          'unresolved': len(unresolved)}, indent=2))
    else:
        if not all_findings:
            print('mermaid-lint: clean — no diagram danglers found')
        else:
            for f in all_findings:
                tag = 'FIXED' if (do_fix and f['fixable']) else ('AUTOFIXABLE' if f['fixable'] else 'REVIEW')
                rel = os.path.relpath(f['file'])
                print(f"[{tag}] {f['rule']} {rel}:{f['line']}  {f['text']}")
            fixed_n = sum(1 for f in all_findings if do_fix and f['fixable'])
            print(f"\nmermaid-lint: {len(all_findings)} finding(s)"
                  + (f", {fixed_n} auto-fixed" if do_fix else "")
                  + f", {len(unresolved)} needing review/attention")
    sys.exit(1 if unresolved else 0)

if __name__ == '__main__':
    main()
