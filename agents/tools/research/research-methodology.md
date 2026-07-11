# Research Methodology
> Disciplined approach to technical research: source evaluation, cross-referencing, confidence calibration, and budget management.

## When to Use
Load this tool when investigating libraries, frameworks, architectural approaches, or best practices via web search. Applies to any agent doing research — not just the researcher agent.

## Source Credibility Hierarchy

Prefer sources higher on this list. When sources conflict, the higher-ranked source wins unless the lower-ranked one provides concrete evidence (benchmarks, reproduction steps, CVE numbers).

| Tier | Source Type | Trust Level | Examples |
|------|-----------|-------------|----------|
| 1 | Official documentation | High | Library docs, language specs, RFC documents |
| 2 | Primary artifacts | High | GitHub repo (README, issues, releases, commit history), npm/PyPI package metadata |
| 3 | Peer-reviewed / authoritative analysis | Medium-High | Conference papers, Thoughtworks Tech Radar, framework team blog posts |
| 4 | Respected community content | Medium | Well-known tech blogs (with author byline), Stack Overflow answers with high votes and recent activity |
| 5 | General content | Low | Medium posts, tutorials without dates, forum threads, AI-generated summaries |
| 6 | Unverifiable | Do not cite | No author, no date, no sources of their own, content farms |

**Date matters.** A Tier 4 blog post from this month outranks a Tier 3 analysis from 3 years ago for fast-moving ecosystems (JS frameworks, cloud services). For stable domains (POSIX, SQL, cryptography), age matters less.

## Cross-Referencing Discipline

No claim in your report should rest on a single source. Follow these rules:

1. **Factual claims need 2+ independent sources.** "Library X has Y weekly downloads" — verify on npm AND a trends site. "Framework X doesn't support Y" — check docs AND recent issues.
2. **If only one source exists, say so.** "According to [source], X. I could not independently verify this."
3. **Contradictions are findings, not problems.** If sources disagree, report the disagreement and explain why. "The docs say X, but GitHub issue #123 shows Y in practice."
4. **Beware citation chains.** If three blog posts all cite the same original source, you have one source, not three. Trace claims to their origin.
5. **Test claims you can test.** If a library claims "zero dependencies," check `package.json`. If docs claim TypeScript support, check for `.d.ts` files or `types` field.

## Confidence Calibration

Every recommendation must include a confidence level. Use these criteria — do not inflate.

| Level | Criteria | What it signals |
|-------|----------|-----------------|
| **High** | 3+ independent sources agree. You verified key claims against primary artifacts. No significant contradictions. | "Act on this." |
| **Medium** | 2 sources agree, or strong single authoritative source. Minor gaps exist but don't undermine the core finding. | "Reasonable to act, but verify the flagged gaps if the decision is hard to reverse." |
| **Low** | Single source, conflicting evidence, or the topic is fast-moving and information may be stale. | "Directionally useful. Validate before committing." |

**Calibration check before writing your recommendation:** Look at your confidence level. Could a skeptic poke a hole in it using publicly available information? If yes, either do more research or lower the confidence.

## Research Budget Management

Every research task has a tool call budget. This prevents rabbit holes and forces prioritization.

| Query Type | Max Tool Calls | When to stop early |
|-----------|---------------|-------------------|
| Straightforward lookup | 5 | Answer found and verified |
| Breadth-first survey | 10 | Options identified, key differentiators clear |
| Deep investigation | 15 | Recommendation supportable, diminishing returns hit |

**Diminishing returns test:** After each search, ask: "Did this change my recommendation or add a material fact?" If the answer is "no" for 2 consecutive searches, stop researching and start writing.

**Budget tracking:** Mentally count tool calls. When at 80% of budget, stop searching and allocate remaining calls to verification of key claims.

## Iron Law
Never cite a source you did not actually read. Skimming a title or snippet is not reading. If you cite it, you opened it and verified the claim appears in the content.

## Red Flags
- "Everyone uses X" — popularity is not a technical argument. What specific property makes it suitable?
- "I found a great article that covers everything" — single-source research is not research. Cross-reference.
- "I'll just do one more search" after hitting budget — you are in a rabbit hole. Write up what you have.
- "This source probably says X" — you are fabricating. Open it or don't cite it.
- "The recommendation is obvious" — if it were obvious, the requester would not have asked. Document the reasoning.

## Example: Confidence Annotation

```
## Recommendation
Use Zod for runtime validation. Confidence: **high**.

Basis: Official docs confirm TypeScript-first design (Tier 1). npm shows 8M weekly
downloads with consistent growth (Tier 2). Bundle size verified at 13KB minified via
bundlephobia (Tier 2). Three independent comparison posts agree it outperforms Yup on
type inference (Tier 4, cross-referenced). No conflicting evidence found.

Caveat: Performance benchmarks were self-reported by the Zod team (Tier 2). Independent
benchmarks would strengthen the performance claim, but the finding holds without it.
```
