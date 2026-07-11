import type { TemplateDefinition } from "../template-engine.js";

export const designProposal: TemplateDefinition = {
  id: "design-proposal",
  name: "Design Proposal",
  description: "Read-mostly task that produces an architecture/design document for a target. No validation gate.",
  whenToUse: "Design a change before building it. Output is a design/spec document.",
  parameters: {
    target: { type: "string", required: true, description: "What to design." },
    role: { type: "string", default: "architect", description: "Designing role." },
  },
  graph: {
    tasks: [
      {
        id: "design",
        role: "{{role}}",
        task: "Produce a design proposal for: {{target}}\n\nCover architecture, components, data flow, trade-offs, and a recommended approach. Read the codebase as needed; do not implement.",
      },
    ],
  },
};
