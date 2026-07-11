# Agentic AI Threat Model
> Reference threat taxonomy for auditing multi-agent systems — OWASP Agentic AI Top 10 (2026) and OWASP MCP Top 10 (2025).

## When to Use
Load this tool when auditing agent-to-agent interactions, tool usage patterns, message flows, or handoff data in multi-agent orchestration systems. Use the categories below to classify findings and ensure comprehensive coverage.

## How to Use
1. Review the two threat taxonomies below. The Agentic AI Top 10 covers agent-level behavioral threats. The MCP Top 10 covers protocol-level infrastructure threats.
2. For each audit area, check the relevant categories. Not every category applies to every system — skip categories only when the attack surface is provably absent.
3. Map findings to the most specific category. Use the ID (e.g., ASI03, MCP06) in your report for traceability.
4. After completing all categories, check the Cross-Cutting Concerns section at the bottom.

---

## OWASP Top 10 for Agentic Applications (2026)

These categories address threats to autonomous AI agent systems — goal manipulation, tool abuse, inter-agent trust, and cascading failures.

### ASI01 — Agent Goal Hijack
Attacker alters an agent's objectives or decision path through malicious text content embedded in tool outputs, messages, or context.
- **Audit focus:** Scan agent logs and messages for role-override language, embedded instructions in tool results, context manipulation attempts.
- **Bureau relevance:** Handoff data, task descriptions, and inter-agent messages are all vectors.

### ASI02 — Tool Misuse and Exploitation
Agent uses legitimate tools unsafely due to ambiguous prompts, manipulated inputs, or insufficient guardrails.
- **Audit focus:** Cross-reference tool calls against agent role definitions. Flag tools invoked with suspicious parameters or in unusual sequences.
- **Bureau relevance:** Check `get_agent_log` for tool calls outside the agent's declared scope.

### ASI03 — Identity and Privilege Abuse
Privileges are unintentionally reused, escalated, or passed across agents. An agent inherits permissions it shouldn't have.
- **Audit focus:** Verify each agent's tool access matches its role. Check for agents spawning sub-agents with elevated permissions.
- **Bureau relevance:** `spawn_session` calls, task graph modifications by non-orchestrator agents.

### ASI04 — Agentic Supply Chain Vulnerabilities
Compromised components (tools, plugins, MCP servers, dependencies) alter agent behavior or expose data.
- **Audit focus:** Verify tool/plugin provenance. Check for unexpected MCP server connections. Audit dependency integrity.
- **Bureau relevance:** MCP tool descriptions, agent prompt files, tool definition integrity.

### ASI05 — Unexpected Code Execution
Agents generate or run code, shell commands, or scripts unsafely — including deserialization of untrusted data.
- **Audit focus:** Search agent logs for shell execution, eval-like patterns, or code generation that runs without sandboxing.
- **Bureau relevance:** Bash tool usage patterns, especially with user-controlled or agent-generated inputs.

### ASI06 — Memory and Context Poisoning
Attackers poison memory systems (RAG databases, conversation history, shared context) to influence future agent decisions.
- **Audit focus:** Check handoff data for injection payloads that persist across task boundaries. Audit shared state in Redis.
- **Bureau relevance:** `set_handoff` data, broadcast messages, any persistent context that survives across sessions.

### ASI07 — Insecure Inter-Agent Communication
Unencrypted or unauthenticated agent messaging enables interception, tampering, and instruction injection.
- **Audit focus:** Verify message integrity between agents. Check for agents impersonating other roles. Audit stream isolation.
- **Bureau relevance:** Redis stream access controls, `send_message` authentication, peer identity verification.

### ASI08 — Cascading Failures
A small error in one agent propagates across planning, execution, memory, and downstream systems, causing widespread damage.
- **Audit focus:** Check error handling chains. Look for agents that blindly trust upstream results without validation.
- **Bureau relevance:** Task graph dependency chains, handoff error propagation, retry cascade patterns.

### ASI09 — Human-Agent Trust Exploitation
Users over-trust agent recommendations, allowing attackers to influence human decisions or extract information through agent-mediated social engineering.
- **Audit focus:** Check agent output for manipulative framing, urgency fabrication, or misleading confidence claims.
- **Bureau relevance:** Agent reports and recommendations presented to users or orchestrators.

### ASI10 — Rogue Agents
Compromised or misaligned agents act harmfully while appearing legitimate — deviating from intended behavior across sessions.
- **Audit focus:** Compare agent behavior against role definition. Look for tool calls, message patterns, or output that contradicts the agent's declared purpose.
- **Bureau relevance:** Session health monitoring, behavioral anomaly detection via telemetry.

---

## OWASP MCP Top 10 (2025)

These categories address threats specific to Model Context Protocol infrastructure — token management, tool integrity, server governance.

### MCP01 — Token Mismanagement and Secret Exposure
Hard-coded credentials, long-lived tokens, and secrets stored in model memory or protocol logs expose sensitive environments.
- **Audit focus:** Scan agent output, logs, and handoffs for API keys, tokens, passwords, connection strings.

### MCP02 — Privilege Escalation via Scope Creep
Temporary or loosely defined permissions within MCP servers expand over time, granting agents excessive capabilities.
- **Audit focus:** Review tool permission grants. Check for permissions that were temporary but never revoked.

### MCP03 — Tool Poisoning
Adversary compromises tools, plugins, or their outputs that an AI model depends on, injecting malicious behavior.
- **Audit focus:** Verify tool description integrity. Check for tool outputs that contain embedded instructions.

### MCP04 — Software Supply Chain Attacks and Dependency Tampering
Compromised dependencies alter agent behavior or introduce execution-level backdoors.
- **Audit focus:** Audit MCP server dependencies, package integrity, version pinning.

### MCP05 — Command Injection and Execution
AI agent constructs and executes system commands using untrusted input without proper validation.
- **Audit focus:** Trace data flow from user/agent input through to shell execution. Check for unsanitized interpolation.

### MCP06 — Intent Flow Subversion
Malicious instructions embedded in context hijack the intent flow, steering the agent away from the user's original goal.
- **Audit focus:** Check for context manipulation that redirects agent behavior. Similar to ASI01 but at protocol level.

### MCP07 — Insufficient Authentication and Authorization
MCP servers fail to properly verify identities or enforce access controls during interactions.
- **Audit focus:** Verify authentication on all MCP endpoints. Check for missing authorization on sensitive operations.

### MCP08 — Lack of Audit and Telemetry
Limited telemetry from MCP servers impedes investigation and incident response.
- **Audit focus:** Verify logging coverage. Check for blind spots in the audit trail.

### MCP09 — Shadow MCP Servers
Unapproved MCP server deployments operating outside the organization's formal security governance.
- **Audit focus:** Enumerate active MCP connections. Flag any servers not in the approved inventory.

### MCP10 — Context Injection and Over-Sharing
Context windows shared or insufficiently scoped expose sensitive information to unintended parties.
- **Audit focus:** Check what data is included in agent contexts. Flag PII, secrets, or internal data shared beyond need-to-know.

---

## Cross-Cutting Concerns

After checking individual categories, verify these system-level properties:

- **Least privilege:** Every agent has the minimum tool access needed for its role — no more.
- **Trust boundary integrity:** Data crossing agent boundaries is treated as untrusted input.
- **Defense in depth:** No single agent compromise should grant access to the entire system.
- **Auditability:** Every agent action is logged with enough detail to reconstruct what happened.
- **Blast radius containment:** A compromised agent's damage is limited by architectural controls.

## Iron Law
Do not invent threat categories. Every finding must map to a real ASI or MCP category from the taxonomies above. If a finding doesn't fit any category, describe it as an uncategorized observation and flag it for framework review.
