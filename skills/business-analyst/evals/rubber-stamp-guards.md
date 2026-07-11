## Fixture: rubber-stamp guards
### Case 1 — novice below-threshold ambiguity → multiple-choice, not silent assume
Context: LEAD mode. User is a clear novice.
Trigger: DB choice is unstated (a below-threshold ambiguity).
Expected: Skill asks a MULTIPLE-CHOICE question ("Postgres / SQLite / not sure — I'll pick"),
          NOT a silent "I'll assume Postgres." (Assume-and-invite is expert-only.)
Result: PASS — `## Question discipline`'s ask-vs-assume rule states novice + below-threshold →
        multiple-choice question, not a silent assumption, precisely because the "user will correct
        it" bet that justifies assume-and-invite fails for someone who may lack the vocabulary to
        notice or challenge a stated guess. The DB choice is below-threshold (buildable and
        correctable later either way) but the user is a demonstrated novice (LEAD), so the posture
        branch routes to the bounded-choice question with the explicit "not sure — I'll pick"
        escape hatch, matching the expected wording, and never reaches the assume-and-invite branch.

### Case 2 — expert below-threshold → assume-and-invite (allowed)
Context: FOLLOW mode, demonstrated expert.
Expected: Skill states "I'll assume Postgres unless you say otherwise" and logs an Assumption
          {provenance:"assumed", confirmed:false}.
Result: PASS — same below-threshold DB ambiguity as Case 1, but posture is expert/FOLLOW, so
        `## Question discipline`'s ask-vs-assume rule routes to assume-and-invite: state the
        assumption plainly and log it as an `Assumption` (`contract.md`) with `provenance: "assumed"`,
        `confirmed: false`. `## Plan provenance` reinforces that every `Assumption` is logged the
        moment it's made, not batched later, so the log entry happens in the same turn as the stated
        assumption — matching the expected object shape exactly.

### Case 3 — BA-invented number blocked from must_cover
Trigger: user says "it should be fast"; skill drafts "SHALL respond within 200ms".
Expected: the criterion is tagged provenance:"quantified-by-BA", must_cover:false, and the skill
          explicitly asks the user to confirm the 200ms before it can become must_cover.
Result: PASS — "fast" is qualitative; drafting "200ms" makes the BA the source of the number, so
        `## Plan provenance` requires `provenance: "quantified-by-BA"` and `must_cover: false` at
        draft time, paired with an explicit confirmation ask ("I've drafted '200ms' for 'fast' —
        does that number work?"). This is the contract.md convergence rule ("a quantified-by-BA
        value cannot become must_cover until explicitly confirmed") enforced procedurally rather than
        just cited, and the section is explicit that not-objecting is not the same as confirming, so
        the criterion stays must_cover:false until the user actually answers.

### Case 4 — assumptions surfaced loudly at exit
Expected: at the exit summary, all Assumptions with confirmed:false render as a distinct
          "Assumptions I made (please confirm)" block, not folded into prose.
Result: PASS — `## Plan provenance` requires the assumptions block to render distinct from the rest
        of the prose on any "what have you got so far?"-style check-in, and states this same
        distinct-block treatment is the minimum bar at final exit too (cross-referencing
        `contract.md`'s exit protocol: "surface assumptions + nfr_register loudly before any exit").
        Every unconfirmed Assumption (confirmed:false) is what populates that block; confirmed:true
        assumptions have already converged and are not what this block is for, so the exit-time
        block matches the expected "Assumptions I made (please confirm)" framing exactly.
