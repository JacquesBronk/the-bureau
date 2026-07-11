## Fixture: EARS, gate, tiering
### Case 1 — requirements → EARS with provenance; NFRs preserved
Input: "When a visitor submits the contact form, email us. It should look modern and load fast."
Expected: "WHEN a visitor submits the contact form THE SYSTEM SHALL send an email to the owner"
          → EarsCriterion provenance:"paraphrased", testable:true, must_cover:true.
          "look modern" → nfr_register entry (why_untestable set), NOT dropped.
          "load fast" → EarsCriterion provenance:"quantified-by-BA" (a proposed number such as
          "200ms"), must_cover:false pending the user's explicit confirmation — the
          quantify-and-confirm path, not nfr_register, since latency has a scale the BA can
          propose a target against.
Result: PASS — "when a visitor submits the contact form, email us" fits the `event` pattern
        (`WHEN <trigger> THE SYSTEM SHALL <response>`) verbatim from `contract.md`'s EARS table;
        `## EARS & gate`'s extract step drafts it as "WHEN a visitor submits the contact form THE
        SYSTEM SHALL send an email to the owner" — the user's words reshaped into EARS form but not
        their exact phrasing, so `provenance:"paraphrased"` per `## Plan provenance`. The testability
        self-check asks whether the response is observable/assertable: sending an email is, so
        `testable:true`, and since nothing here is an invented number (no `quantified-by-BA` block
        applies), it clears straight to `must_cover:true`. "Look modern" and "load fast" both name a
        quality attribute with no observable pass/fail as stated, but the section's decision rule
        splits them by whether a scale exists to propose a number against: "look modern" is purely
        aesthetic with no such scale, so it routes straight to `nfr_register` as
        `Requirement{text, why_untestable, human_signed_off:false}` — aesthetic judgment has no test
        assertion. "Load fast" does have an implicit scale (latency), so it takes the
        quantify-and-confirm path owned by `## Plan provenance` instead: the BA proposes a concrete
        number (e.g. "200ms"), drafts the criterion `provenance:"quantified-by-BA"`,
        `must_cover:false`, and gates it on the user's explicit confirmation of that number — it
        falls back to `nfr_register` only if the user declines to commit to any number. Neither is
        dropped: "look modern" surfaces at the next check-in's distinct nfr block, and "load fast"
        surfaces as a pending-confirmation criterion, both per `## Plan provenance`'s distinct-block
        rule.

### Case 2 — honest gate on implement
Input: elicitation is complete for a small internal admin tool (complexity_tier:"trivial", no
       risk_flags); the user says "let's go" at the exit prompt.
Expected: the declared graph carries ONE graph-level exec validation criterion whose test command
          embeds the fail-under floor (e.g. pytest --cov-fail-under=30); NO per-task criteria;
          output states "blocks promotion in pod-dispatch; advisory-after-merge in local worktree
          dispatch".
Result: PASS — "let's go" at the exit prompt routes to the **Implement** exit per `## Exit`, and the
        input's trivial tier with no risk flags keeps `coverage_target` at the 30% default, so
        `## EARS & gate`'s "emit the gate" bullet emits exactly one entry on
        `declare_task_graph`'s graph-level `acceptanceCriteria` array — `{name, type:"exec", check}`
        — never a per-task `validation` field and never one criterion per `must_cover` criterion, so
        no per-task criteria exist. The `check` string has `coverage_target` compiled directly into
        it (the section's own example is `pytest --cov-fail-under=30`, matching this input's trivial-tier
        floor), never left as a bare threshold the runner has to look up separately. The section
        requires stating the enforcement in the same substance every time: "blocks promotion in
        pod-dispatch; advisory-after-merge in local worktree dispatch" — matching the fixture's
        expected output verbatim. The section also explicitly disclaims per-SHALL enforcement
        as issue #306's future upgrade, so nothing here overclaims verifying individual
        `must_cover` EarsCriteria one at a time.

### Case 3 — risk raises the floor above tier default
Input: "a simple homepage — but it takes credit-card payments."
Expected: tier reads trivial (default 30%) BUT risk_flags:["payments"] raises coverage_target
          above 30%, and the skill asks the auth/payments/PII risk-probe.
Result: PASS — a single static-ish homepage is small and self-contained, so `## Tiering`'s
        tier-assignment bullet reads it as `complexity_tier:"trivial"` with a `tier_rationale` noting
        the narrow scope (one page, minimal logic) — this matches `contract.md`'s tier table default
        floor of 30%. Before finalizing that tier, the section requires asking the risk-probe
        ("does this touch auth, payments, or personal data?"); the input states credit-card payments
        outright, so `risk_flags:["payments"]` is set. The `coverage_target` bullet then raises the
        floor above the tier default whenever any `risk_flags` are set, "regardless of tier" —
        exactly this case, a trivial-tier plan that touches payments — so `coverage_target` ends up
        above 30% even though `complexity_tier` itself stays "trivial". Nothing in the section lets
        the trivial tier keep its floor once a risk flag is present.

### Case 4 — complex → reviewed decomposition, not mega-graph
Input: "a full CMS with plugins, roles, media library, publishing workflow."
Expected: tier=complex; the skill does NOT emit one mega-graph; it enters the reviewed
          decomposition sub-flow (Task 6).
Result: PASS — a CMS spanning plugins, roles, a media library, and a publishing workflow is
        multiple distinct subsystems, not one self-contained unit or a small set of disjoint files;
        `## Tiering`'s tier-assignment bullet reads this as `complexity_tier:"complex"` with a
        `tier_rationale` naming the multi-subsystem breadth, matching `contract.md`'s tier table
        (complex → 75% default floor, reviewed decomposition shape). The "tier decides implement
        shape" bullet maps `complex` to "the reviewed decomposition sub-flow — never a one-shot
        mega-graph, and never collapsed into a single `declare_task_graph` call just because
        elicitation itself is finished" — so the skill does not emit one mega-graph here. The same
        bullet explicitly hands the decomposition sub-flow itself to Task 6 ("this section only sets
        the tier that triggers it"), so Case 4's expectation that the skill "enters" that sub-flow
        rather than building it inline is exactly the seam this section leaves open, not something
        it attempts to resolve itself.
