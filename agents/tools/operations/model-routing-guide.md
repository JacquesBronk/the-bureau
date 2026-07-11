# Model Routing Guide
> Match agent tasks to the right Claude model tier for cost-effective quality.

## When to Use
When assigning model tiers to agents, reviewing model assignments for cost optimization, or designing task graphs that need model tier decisions.

## Model Tiers

| Tier | Model | Strengths | Cost Profile |
|------|-------|-----------|-------------|
| **Haiku** | claude-haiku-4-5 | Fast, cheap. Structured output, classification, monitoring, status checks, changelog, docs | Lowest |
| **Sonnet** | claude-sonnet-4-6 | Balanced. Code implementation, testing, research, standard code review, feature development | Mid |
| **Opus** | claude-opus-4-6 | Deep reasoning. Architecture, security analysis, complex debugging, nuanced judgment calls | Highest |

## Routing Table

| Task Type | Recommended Tier | Rationale |
|-----------|-----------------|-----------|
| Health checks, status monitoring | Haiku | Repetitive, low-complexity, high-frequency |
| Documentation, changelog | Haiku | Structured output from templates, minimal reasoning |
| Log analysis, telemetry compilation | Haiku | Data aggregation, table formatting |
| Code implementation | Sonnet | Needs code understanding + generation balance |
| Test writing | Sonnet | Pattern-following with moderate reasoning |
| Code review (standard) | Sonnet | Pattern matching against known issues |
| Research, web search synthesis | Sonnet | Breadth over depth, summarization |
| Architecture design | Opus | Cross-cutting concerns, trade-off reasoning |
| Security review | Opus | Must catch subtle vulnerabilities, high consequence of misses |
| Complex debugging | Opus | Multi-step causal reasoning across codebases |
| Prompt engineering | Opus | Meta-reasoning about LLM behavior, subtle behavioral tuning |
| Code review (architecture-level) | Opus | Needs experienced judgment about design implications |

## Decision Process

1. **What's the consequence of a miss?** High-consequence tasks (security, architecture) warrant Opus even if they seem simple.
2. **Is the task pattern-following or reasoning-heavy?** Template-filling and structured output = Haiku. Novel reasoning = Sonnet or Opus.
3. **How much context does the task need?** Tasks requiring cross-file reasoning or large context benefit from stronger models.
4. **What's the frequency?** High-frequency tasks (monitoring, health checks) multiply cost — use the cheapest viable tier.

## Iron Law
Never downgrade security review or architecture tasks to save cost. The cost of a missed vulnerability or flawed architecture dwarfs model pricing.

## Red Flags
- "This security task is simple enough for Haiku" — security tasks have high miss-consequence regardless of apparent simplicity.
- "We can save money by running all agents on Haiku" — false economy; weak models produce more rework, which costs more overall.
- "Opus for everything to be safe" — wasteful; Haiku handles structured tasks as well as Opus at a fraction of the cost.

## Effort Level Guidance

Pair model tier with effort level for additional cost control:

| Effort | When | Effect |
|--------|------|--------|
| **low** | Monitoring, status, simple lookups | Reduces reasoning tokens |
| **medium** | Standard implementation, testing | Default balance |
| **high** | Architecture, security, complex analysis | Full reasoning budget |

## Advisory Note
These are recommendations, not rules. Actual performance depends on prompt quality — a well-structured Haiku prompt can outperform a vague Opus prompt. Always evaluate model routing alongside prompt quality.
