## Fixture: posture routing
### Case 1 — expert brain-dump → FOLLOW
Input: "Build a REST API for gym class bookings. Postgres, JWT auth, Stripe for payments,
        FastAPI. Members book/cancel classes; instructors see rosters."
Expected: Skill enters FOLLOW. It EXTRACTS a draft (does not ask a sequential questionnaire),
          reflects it back, and asks only about genuine gaps. It does NOT walk one-question-at-a-time.
Result: PASS — the named concrete stack (Postgres/JWT/Stripe/FastAPI) and the volunteered
        constraints (members book/cancel classes; instructors see rosters) are the primary
        behavioral FOLLOW cues in `## Posture`; message length and jargon density are tie-break-only
        under the weighting rule and are not what drives this classification. `## Modes` → FOLLOW
        says extract-then-reflect-back and ask only about gaps/contradictions/ambiguities, explicitly
        not a sequential questionnaire — that's LEAD's shape, which FOLLOW is defined in contrast to.

### Case 2 — vague opener → LEAD
Input: "I want an app for my gym."
Expected: Skill enters LEAD and delegates to the brainstorming flow: ONE question at a time,
          multiple-choice preferred.
Result: PASS — the input hands over a bare goal with zero direction (no named stack, no
        volunteered constraints, no answer to any specific question) and implicitly asks the
        agent to drive from here — that is a request for help, the behavioral LEAD cue in
        `## Posture`, not the sentence's length or vagueness. The short/vague phrasing only
        CONFIRMS this as a tie-break signal, the same way Cases 1 and 4 use stylistic cues to
        confirm rather than drive their behavioral classification. `## Modes` → LEAD says apply
        the `brainstorming` skill's elicitation flow verbatim, which is one question at a time,
        multiple-choice preferred.

### Case 3 — stuck → ASSIST
Input (mid-conversation): "honestly I don't know, what are my options?"
Expected: Skill offers a named-technique menu (e.g. Pre-mortem, Stakeholder Round Table) —
          pulled, not a mandatory menu after every section.
Result: PASS — "what are my options?" plus self-professed not-knowing is listed verbatim as an
        ASSIST cue in `## Posture`. `## Modes` → ASSIST says the technique library is pulled only
        when the user is stuck, never a forced menu, and lists Pre-mortem/Red-Blue Team/Stakeholder
        Round Table/Tree of Thoughts as the named options to offer.

### Case 4 — terse + named stack → FOLLOW (tie-break)
Input: "JWT, Postgres, RBAC. Go."
Expected: FOLLOW (not LEAD). Terse alone is not a LEAD signal when a concrete stack is named.
Result: PASS — `## Posture` states terseness is not a cue by itself and gives the exact tie-break:
        terse + named concrete stack ⇒ FOLLOW. This input names three concrete technologies, so the
        tie-break fires and the classifier does not fall back to treating brevity as a LEAD signal.
        This still holds under the weighting rule: the named stack is the behavioral cue doing the
        work, and terseness is only the stylistic tie-break confirming it, never an independent
        signal.

### Case 5 — no thrash
Input: a detailed turn, then "yeah ok", then another detailed turn.
Expected: Stays in FOLLOW across all three; does NOT flip to LEAD on "yeah ok".
Result: PASS — `## Posture`'s damping rule holds a rolling initiative score with a dead-band and a
        minimum dwell (no flip for at least 2 user turns after entering a mode, short of an explicit
        switch request or a full-spec reset). "yeah ok" is a short acknowledgment, not a LEAD cue (no
        request for help, no hedge, no vague opener) and not strong contrary evidence, so it clears
        neither the dead-band nor the dwell floor. The third turn is another detailed, behaviorally
        FOLLOW-consistent message arriving inside the dwell window, so there is nothing trying to flip
        the mode anyway — the rolling score keeps the session in FOLLOW throughout.

### Case 6 — LEAD converges through the gate + exit, not brainstorming's terminal state
Input: "I want an app for my gym." (same opener as Case 2) → brainstorming's elicitation runs
       one question at a time (venue capacity, class types, booking window, ...) until
       brainstorming reaches its own elicitation-complete point and presents a design summary;
       the user then says "ok, let's go."
Expected: the session does NOT stop at brainstorming's design-summary output. Control resumes in
          this skill: requirements are drafted into `EarsCriterion`s (`## EARS & gate`), a single
          graph-level `exec` criterion is emitted, and the plan converges through `## Exit`'s
          artifact-review + "N covered by gate, M accepted by human review" line before
          `declare_task_graph` fires on the Implement exit.
Result: PASS — `## Modes` → LEAD invokes `brainstorming` for the LEAD elicitation flow only and
        states explicitly that brainstorming owns LEAD elicitation, "not the terminal state of the
        BA session": when brainstorming's elicitation concludes, control RESUMES in this skill at
        `## EARS & gate` and `## Exit`. So brainstorming's design-summary is not where the session
        stops — it hands back here. "Ok, let's go" is then read at `## Exit` exactly as any other
        exit trigger: the plan (by now carrying `EarsCriterion`s drafted from the brainstorming
        transcript per `## EARS & gate`, tiered per `## Tiering`) is shown with the distinct
        assumptions/`nfr_register` block, the gate is emitted per `## EARS & gate`'s "emit the
        gate" bullet (exactly one graph-level `exec` criterion, never per-task), the "N covered by
        gate, M accepted by human review" line is stated, and only then does `declare_task_graph`
        fire on the Implement exit. Every session, LEAD or FOLLOW, converges through this same
        shared gate + exit — LEAD is not a separate terminal path that ends inside brainstorming.
