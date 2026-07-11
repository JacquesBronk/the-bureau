# Prompt & Tool Description Evaluation
> Structured criteria for evaluating agent prompts and MCP tool descriptions in multi-agent systems.

## When to Use
Load this tool when auditing agent prompts, reviewing tool descriptions, or assessing prompt quality during prompt engineering. Used by both prompt-auditor (read-only evaluation) and prompt-engineer (evaluation before rewrite).

## Part 1: Tool Description Evaluation

### Anthropic's Principles for Tool Descriptions

These principles are derived from Anthropic's official documentation and engineering guidance.

**Principle 1 — Detailed, self-contained descriptions.**
Each tool description must contain everything the model needs to use it correctly. Aim for 3-4 sentences minimum. Include: what the tool does, when to use it (and when not to), what each parameter means, return format, and caveats. A model reading only this description — with no system prompt or other tools visible — should know exactly when and how to call it.

**Principle 2 — Consolidate related operations.**
Group related actions into fewer tools with an `action` parameter rather than creating separate tools for each operation. Fewer tools = fewer decisions = better accuracy. Example: one `github_pr` tool with actions (create, review, merge) instead of three separate tools.

**Principle 3 — Minimize description overlap.**
If two tools have similar descriptions, the model will struggle to choose. Each tool must have a clear, unique purpose visible in the description alone. When tools span multiple services, use meaningful namespace prefixes (e.g., `github_list_prs`, `slack_send_message`).

**Principle 4 — Curate the tool set per task.**
Not every task needs every tool. Use deferred loading (`defer_loading: true`) for infrequent tools. Keep 3-5 always-loaded tools; discover the rest on demand. Apply tool search when definitions exceed ~10K tokens.

**Principle 5 — Return high-signal information.**
Tool responses should return semantic, stable identifiers (names, slugs) rather than opaque internal IDs. Include only fields the model needs for its next reasoning step. Implement pagination and filtering with sensible defaults.

### Tool Description Scoring

Score each tool description on these dimensions:

| Dimension | 1 (Poor) | 3 (Adequate) | 5 (Excellent) |
|-----------|----------|--------------|----------------|
| **Completeness** | One sentence, no usage guidance | Explains purpose and basic usage | Full context: purpose, when/when-not, parameters, return format, caveats |
| **Disambiguation** | Could be confused with 2+ other tools | Minor overlap with one tool | Clearly unique purpose, no confusion possible |
| **Parameter clarity** | No parameter descriptions | Types specified but meaning unclear | Each parameter has type, description, example, and constraints |
| **Actionability** | Model would guess when to call | Model would usually call correctly | Model would always call at exactly the right time |
| **Token efficiency** | Bloated with redundant text (>500 tokens) | Reasonable length with some waste | Every sentence earns its tokens (~100-300 tokens) |

### Tool Description Red Flags

- Description under 15 words — too vague for reliable invocation
- No "when to use" guidance — model must guess from the name alone
- Overlapping verbs with another tool (e.g., two tools that both "search" the same domain)
- Parameters named generically (`data`, `input`, `value`) without context
- Return format undocumented — model cannot parse results reliably
- Description references other tools or system prompt for context (violates self-containment)

## Part 2: Agent Prompt Evaluation

### Quality Dimensions

Score each agent prompt on these dimensions:

| Dimension | 1 (Poor) | 3 (Adequate) | 5 (Excellent) |
|-----------|----------|--------------|----------------|
| **Behavioral constraints** | No hard gates or NEVER rules; vague guidance | Some constraints but gaps in coverage; agent could rationalize around them | Specific hard gates for known failure modes; red flags listed; iron laws with consequences |
| **Workflow clarity** | No step-by-step process; agent improvises | Steps listed but some are vague ("analyze the code"); gaps between steps | Every step is a concrete action; clear input/output per step; traceable from task receipt to completion |
| **Calibration examples** | No examples; relies entirely on abstract instructions | Some output format examples but no behavioral calibration | Input/output pairs that calibrate tone, verbosity, judgment calls, and edge cases |
| **Failure mode coverage** | No guidance for when things go wrong | Basic error handling ("if stuck, ask") | Specific blocked-state guidance; recovery procedures for common failures; escalation criteria |
| **Scope discipline** | No boundaries section; agent expands freely | Boundaries listed but generic ("don't do things outside scope") | Explicit NOT-do list; anti-gold-plating constraints; specific scope-creep patterns addressed |
| **Token efficiency** | Redundant sections; repeated instructions; filler | Some waste but mostly useful content | Every instruction earns its tokens; no redundancy; right-sized for model tier |

### Agent Prompt Structural Checklist

Check for presence and quality of each section:

- [ ] **Identity** — Who the agent is, how it thinks (2-4 sentences, not aspirational)
- [ ] **Core Capabilities** — Specific, not aspirational ("can do X" not "strives to do X")
- [ ] **Tools Available** — References to `agents/tools/` paths for just-in-time loading
- [ ] **Pre-Task Investigation** — Mandatory steps before starting work
- [ ] **Workflow** — Numbered steps from task receipt to completion
- [ ] **Think-Before-Act** — Domain-specific reasoning questions before significant actions
- [ ] **Communication Protocol** — Status, messaging, handoff usage with phase examples
- [ ] **Output Format** — Specific deliverable structure
- [ ] **Boundaries** — Explicit NOT-do list with anti-gold-plating
- [ ] **Between-Tasks Behavior** — What to do when idle

### Agent Prompt Red Flags

- "Be helpful and thorough" without specific constraints — leads to gold-plating
- No NEVER rules — agent will rationalize boundary violations
- Workflow steps that say "analyze" or "evaluate" without specifying criteria
- Communication protocol that doesn't match available MCP tools
- Heartbeat/health-check sections — infrastructure handles this, not agents
- References to `/slash-commands` or `superpowers:*` — external dependencies
- Model tier mismatched to task complexity (Opus for mechanical work, Haiku for reasoning)
- Token count exceeding 3000 tokens without proportional behavioral value
- Contradictory instructions across sections

## Part 3: Cross-Cutting Evaluation

### System-Level Checks

When auditing multiple agents or tools together:

1. **Tool overlap matrix** — For every pair of tools, check: could a model confuse these? If yes, descriptions need disambiguation or tools need consolidation.
2. **Communication consistency** — Do all agents use the same status phases, message types, and handoff format?
3. **Convention drift** — Do agents follow the same structural template? Are section names consistent?
4. **Model tier alignment** — Is each agent on the right tier per the model routing guide? (Reference: `agents/tools/operations/model-routing-guide.md`)
5. **Tool coverage** — Are there behavioral disciplines referenced in prompts but not available as tools? Are there tools that no agent references?

### Severity Classification for Findings

| Severity | Definition | Example |
|----------|-----------|---------|
| **Critical** | Will cause incorrect behavior in production | Tool description so vague that wrong tool gets called; contradictory workflow steps |
| **High** | Likely to cause inconsistent behavior | Missing failure mode coverage; no calibration for scoring rubric |
| **Medium** | Reduces quality but agent still functions | Generic boundaries; some token waste; missing think-before-act |
| **Low** | Cosmetic or minor optimization | Section ordering; minor wording improvements; formatting |

## Iron Law

Never rate a prompt based on how "nice" or "professional" it reads. Rate it on whether it produces correct, consistent behavior from the target model. A terse, constraint-heavy prompt that works beats an eloquent prompt that drifts.

## Example: Calibrating a Score

<example>
<input>
Agent: changelog-writer
Prompt excerpt: "You write changelogs. Be thorough and accurate. Follow the project's conventions."
</input>
<evaluation>
- Behavioral constraints: 1/5 — No constraints at all. "Be thorough" is aspirational. No NEVER rules.
- Workflow clarity: 1/5 — No steps. Agent must invent its own process.
- Calibration examples: 1/5 — No examples of what a good changelog entry looks like.
- Failure mode coverage: 1/5 — No guidance for: empty git history, merge commits, unclear commit messages.
- Scope discipline: 1/5 — No boundaries. Agent might rewrite the entire changelog, add commentary, or restructure sections.
- Token efficiency: 3/5 — Short, but only because it says almost nothing useful.
- Overall: POOR — This prompt would produce wildly inconsistent results across runs.
</evaluation>
</example>

<example>
<input>
Agent: code-reviewer
Prompt excerpt includes: identity paragraph, confidence-based filtering (high/medium/low with specific thresholds), severity classification (blocker/concern/suggestion/question/praise with definitions), think-before-filing checks (4 gates), pre-review investigation steps, score calibration (1-5 with anchors), red flags section, output format template.
</input>
<evaluation>
- Behavioral constraints: 5/5 — Iron law ("never present low-confidence as high-confidence"), 4 think-before-filing gates, confidence thresholds.
- Workflow clarity: 4/5 — Pre-review steps are specific. Review process could be more explicit about ordering.
- Calibration examples: 4/5 — Score anchors are calibrated (5=exemplary, 1=significant issues). Would benefit from a full input/output example.
- Failure mode coverage: 3/5 — Covers low-confidence findings well. Missing guidance for: no findings at all, huge PRs, unfamiliar languages.
- Scope discipline: 4/5 — Red flags section catches common scope-creep. Could explicitly state "do not suggest architectural changes in a review."
- Token efficiency: 4/5 — Well-structured. Minor redundancy between confidence filtering and think-before-filing.
- Overall: GOOD — Produces consistent, reliable behavior. Minor gaps in failure modes.
</evaluation>
</example>
