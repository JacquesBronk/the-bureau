import type { TemplateDefinition } from "../template-engine.js";

export const audit: TemplateDefinition = {
  id: "audit",
  name: "Audit",
  description: "Read-mostly audit that produces findings; an agent review criterion gates completion. No mutation, no per-task validation.",
  whenToUse: "Assess an existing codebase along a focus area (security, deps, perf, a11y). Output is a findings report.",
  parameters: {
    target: { type: "string", required: true, description: "What to audit." },
    focus: { type: "string", default: "security", description: "Audit focus: security | deps | perf | a11y." },
    role: { type: "string", default: "code-reviewer", description: "Auditing role." },
  },
  graph: {
    acceptanceCriteria: [
      { name: "audit-review", type: "agent", check: "The audit report is thorough for the stated focus, cites concrete evidence, and ranks findings by severity.", onFail: "fail" },
    ],
    tasks: [
      {
        id: "audit",
        role: "{{role}}",
        task: "Audit {{target}} with a {{focus}} focus (read-only). Produce a findings report: each finding with evidence (file:line), severity, and a concrete remediation.",
      },
    ],
  },
};
