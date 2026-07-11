# Business Analyst — Shared Contract

The single source of truth for the plan object and the convergence rules. Every later business-analyst asset (`SKILL.md`, eval fixtures, and Spec 2) references the field and type names defined here **verbatim** — they are frozen by this document.

## Plan object

```
title:            string
problem:          string
proposal:         string
complexity_tier:  "trivial" | "standard" | "complex"   # a REVIEWED field
tier_rationale:   string
risk_flags:       ("auth" | "payments" | "pii" | "external-integration")[]
coverage_target:  number          # floor; defaulted from tier, RAISED by risk_flags
acceptance:       EarsCriterion[]
assumptions:      Assumption[]
nfr_register:     Requirement[]    # real but not machine-verifiable — human sign-off, NOT dropped
attachments:      Attachment[]
open_questions:   string[]
dependencies:     string[]
feasibility:      ConsultNote[]

EarsCriterion = { earsId: string, pattern: "ubiquitous"|"event"|"state"|"optional"|"unwanted"|"complex",
                  text: string, provenance: "verbatim"|"paraphrased"|"quantified-by-BA",
                  must_cover: boolean, testable: boolean }
Assumption    = { text: string, provenance: "assumed"|"inferred", confirmed: boolean }
Requirement   = { text: string, why_untestable: string, human_signed_off: boolean }
ConsultNote   = { question: string, answer: string, source: "rag"|"subagent", provenance: string }
Attachment    = { kind: "text"|"log"|"code"|"asset-pack"|"image", location: string, ingested: boolean }
```

Every field on the plan object above is defined either inline (scalar / union / array-of-scalar) or by one of the five types (`EarsCriterion`, `Assumption`, `Requirement`, `ConsultNote`, `Attachment`) declared alongside it. No other fields exist on the plan object, and no later asset may add one without updating this contract first.

## EARS definition

EARS (Easy Approach to Requirements Syntax) gives each acceptance criterion one of six canonical patterns:

| pattern | canonical form |
|---|---|
| ubiquitous | `THE SYSTEM SHALL <response>` |
| event | `WHEN <trigger> THE SYSTEM SHALL <response>` |
| state | `WHILE <state> THE SYSTEM SHALL <response>` |
| optional | `WHERE <feature is present> THE SYSTEM SHALL <response>` |
| unwanted | `IF <unwanted condition> THEN THE SYSTEM SHALL <response>` |
| complex | a combination of the above (e.g. `WHILE <state>, WHEN <trigger> THE SYSTEM SHALL <response>`) |

Caveat (verbatim): *"EARS guarantees form, not validity, and not fidelity to intent."*

A criterion that parses as valid EARS can still be the wrong requirement, or a faithful-looking paraphrase of something the stakeholder never said — that is what `provenance` (`verbatim`|`paraphrased`|`quantified-by-BA`) on `EarsCriterion` is for: it tracks how far the text has drifted from what was actually said.

Convergence rule: a `quantified-by-BA` value (a number or threshold the user never stated) cannot become `must_cover` until explicitly confirmed by the user.

## Coverage / tier / risk table

Illustrative, config-defaulted — the floors below are defaults, not hard limits, and are expected to live in config rather than be hardcoded.

| tier | default floor | implement-now shape |
|---|---|---|
| trivial | 30% | one self-contained task graph |
| standard | 50% | single or parallel-disjoint-file graph |
| complex | 75% | reviewed decomposition sub-flow (never a one-shot mega-graph) |

Risk rule (verbatim): *"`risk_flags` (auth/payments/pii/external-integration) raise `coverage_target` above the tier default regardless of tier."*

## Honest gate contract

*"Spec 1 emits exactly one graph-level `exec` validation criterion; the coverage floor is compiled into the test command (e.g. `pytest --cov-fail-under=75`). Enforcement: blocks promotion in pod-dispatch; advisory-after-merge in local worktree dispatch. Per-SHALL must-cover requires #306 and is not claimed here."*

The validation criterion's type is always `exec` — never `script` or `command`. Spec 1 does not attempt to verify individual `must_cover` criteria one at a time; that finer-grained per-SHALL enforcement is explicitly deferred to issue #306 and must not be implied as already delivered.

## Exit protocol contract

Every plan converges to exactly one of three exits:

1. **implement** — hand the plan to `declare_task_graph` (or `use_template`), shaped per the coverage/tier/risk table above.
2. **file-issue** — record the plan as a Forgejo issue for later triage instead of building now.
3. **discard** — the elicitation concludes without producing implementable or trackable output.

Complex-tier requirement: a plan at `complexity_tier: "complex"` MUST go through a reviewed decomposition sub-flow before the implement exit — never dispatched as a one-shot mega-graph.

Before any exit is taken: *"show the artifact for review before acting; surface assumptions + nfr_register loudly; redact secrets before any issue_write body."* This review step is also where the convergence rule above is enforced: a `quantified-by-BA` value cannot become `must_cover` until explicitly confirmed by the user.
