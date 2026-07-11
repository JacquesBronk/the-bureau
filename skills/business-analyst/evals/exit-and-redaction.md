## Fixture: exit + redaction
### Case 1 — three exits show artifact first
Input: user says "let's go" / "file it" / "actually, discard this" at end of elicitation.
Expected: the skill presents the final plan (assumptions + nfr_register surfaced loudly, as a
          distinct block) and asks which exit. implement → declare_task_graph; file → forgejo
          issue_write; discard → requires explicit "yes, discard" confirmation.
Result: PASS — `## Exit`'s opening paragraph requires rendering the final plan with the same
        distinct-block treatment `## Plan provenance` established (an "Assumptions I made (please
        confirm)" block and the `nfr_register` list, both separate from the narrative) before asking
        which of the three exits to take — this fires on any of the three trigger phrases, not just
        one. "Let's go" routes to **Implement**: `## Tiering`-mapped shape, handed to
        `declare_task_graph` (or `use_template`) per the "Implement" bullet. "File it" routes to
        **File an issue**: the "File an issue" bullet calls `mcp__forgejo__issue_write` with a body
        built from the shown artifact, after the redaction pass. "Actually, discard this" routes to
        **Discard**: the "Discard" bullet requires the literal "yes, discard" (or unambiguous
        equivalent) before exiting clean — the phrase alone ("actually, discard this") is the user's
        opening move toward that exit, not itself the confirmation, so the skill must still ask and
        wait for the explicit "yes, discard" before treating the plan as discarded.

### Case 2 — secret redaction before issue_write
Input: user pastes a log containing "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEKEY" and picks
       "file an issue".
Expected: the issue body is redacted (key stripped/masked) BEFORE issue_write is called.
Result: PASS — `## Exit`'s "Secret redaction" paragraph lists `SECRET`-named assignments
        explicitly ("`AWS_SECRET_ACCESS_KEY=...`" is its own worked example) and also independently
        matches the AWS-access-key shape (`AKIA[A-Z0-9]{16}`-like pattern) in the pasted value — either
        match alone is sufficient to redact. The paragraph is explicit that this pass runs
        unconditionally "before the content leaves the session" for both durable-artifact exits,
        including "file-issue's `issue_write` body," and that the value is replaced with a fixed
        `[REDACTED]` placeholder while the key name stays legible (`AWS_SECRET_ACCESS_KEY=[REDACTED]`).
        The "File an issue" bullet itself only calls `mcp__forgejo__issue_write` "after the redaction
        pass above," so the tool call never receives the raw key — redaction is sequenced strictly
        before the tool invocation, not applied after or skipped because "it's just an internal issue."

### Case 3 — complex-tier reviewed decomposition
Context: tier=complex (from Task 5 Case 4 — "a full CMS with plugins, roles, media library,
         publishing workflow").
Expected: implement does NOT fire a mega-graph. It proposes seam boundaries + an ADR list +
          a child-issue set, validates child independence (disjoint file sets), gets approval,
          then files ONLY the first slice as a graph; the rest is a reviewable draft. Epic↔child
          grouping is via milestone + #N references (no native parent/child primitive).
Result: PASS — `## Exit`'s "Implement" bullet routes `complex` tier away from a direct
        `declare_task_graph` call and into the "Complex-tier reviewed decomposition" numbered flow
        rather than treating decomposition as optional. Steps 1-3 propose seam boundaries (plugins /
        roles / media library / publishing workflow are exactly the natural subsystem lines
        `tier_rationale` would have named for this input per the EARS-gate-tiering fixture's Case 4),
        draft one ADR per seam decision, and draft one child issue per seam carrying its own EARS
        slice. Step 4 requires validating disjoint file sets across the proposed children before
        calling them parallel-safe, with an explicit fallback (merge or sequence) for any pair that
        overlaps — so the CMS's roles/media-library children, if they shared a permissions-check file,
        would have to be merged or sequenced rather than presented as independent. Step 5 requires
        human approval on the full set (seams + ADRs + children + independence check) before anything
        is filed — no auto-filing as a side-effect of finishing elicitation. Step 6 then files only the
        first approved slice as a `declare_task_graph`, leaving every other child as an unfiled,
        reviewable draft — directly satisfying "does NOT fire a mega-graph" and "files ONLY the first
        slice." Step 7 states the grouping mechanism honestly: one `mcp__forgejo__milestone_write`
        milestone for the whole decomposition plus `#N` cross-references in each child body, explicitly
        because "Forgejo has no native parent/child primitive" — matching the fixture's expectation
        verbatim.

### Case 4 — exit summary counts
Input: at exit, the plan carries 4 `EarsCriterion` entries with `must_cover: true` (plus 1 more
       still `provenance:"quantified-by-BA"` / `must_cover:false` pending confirmation) and 2
       `nfr_register` entries ("look modern", "handles peak load gracefully").
Expected: summary states "4 requirements covered by gate, 2 accepted by human review (not
          automatable)" — the unconfirmed `quantified-by-BA` entry is excluded from N.
Result: PASS — `## Exit`'s opening paragraph closes the shown artifact with exactly this line before
        any exit is chosen, defining `N` as the count of `EarsCriterion` entries with
        `must_cover: true` — 4 here, since the fifth criterion is still `must_cover:false` pending
        confirmation per `## Plan provenance`'s `quantified-by-BA` block and so is not counted in N
        (the reviewed set the `exec` gate's aggregate `coverage_target` backs, per
        `## EARS & gate`) — and `M` as the count of `nfr_register` entries, 2 here — both counts drawn straight
        from fields already maintained on the plan object per `contract.md`, with no new bookkeeping
        invented here. The paragraph is explicit that reporting `N` this way "does not newly claim
        per-criterion enforcement" — it stays consistent with `## EARS & gate`'s disclaimer that
        per-`SHALL` must-cover verification is issue #306's future upgrade, not something Task 6
        silently backfills into the summary line.

### Case 5 — expanded redaction catches bare tokens, JWTs, Basic-auth, and PASSWORD assignments
Input: user pastes a deploy log and picks "file an issue". The log contains, each on its own line and
       NOT in a `*_TOKEN=`/`*_KEY=` assignment: a bare GitHub token `ghp_A1b2C3...`, a Stripe key
       `sk_live_51H8x...`, a Slack token `xoxb-2444-99887766-AbCd...`, an `Authorization: Basic
       YWxhZGRpbjpvcGVuc2VzYW1l` header, a JWT `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJ...`,
       and `DB_PASSWORD=hunter2primary`.
Expected: EVERY one of the six values is masked to `[REDACTED]` (prefix/label kept where present:
          `ghp_[REDACTED]`, `Authorization: Basic [REDACTED]`, `DB_PASSWORD=[REDACTED]`) BEFORE
          issue_write is called. None is left in the issue body.
Result: PASS — the "Secret redaction" paragraph now scans for the *value's* shape "wherever it appears,
        including bare in a log line, not only in `name=value` position," which is exactly the class the
        prior minimal wording leaked. The GitHub/Stripe/Slack tokens match the **vendor-prefixed API
        tokens** bullet ("mask the whole token anywhere it appears, even unnamed") — `ghp_`, `sk_live_`,
        and `xoxb-` are all listed prefixes, and the catch-all "any `<vendor-prefix>_<long-random>`"
        covers the rest. The JWT matches the dedicated **JWTs** bullet (`eyJ….eyJ….<sig>`). The
        `Authorization: Basic …` header matches the generalized **HTTP auth headers** bullet
        ("`Authorization: <scheme> <value>` for **any** scheme," `Basic` explicitly named) — the old
        wording only listed `Bearer` and so leaked it. `DB_PASSWORD=hunter2primary` matches the
        **credential-named assignments** bullet, whose name set now includes `PASSWORD`/`PASSWD`/`PWD`
        (the old `*_SECRET*`/`*_KEY*`/`*_TOKEN*`-only list did not, and leaked it). Redaction is sequenced
        strictly before `mcp__forgejo__issue_write` per the "File an issue" bullet, so no raw value
        reaches the tool. This is the regression fixture for the #308 expanded-redaction change: each of
        the six was demonstrably left un-redacted by the pre-expansion wording in at least one baseline run.
