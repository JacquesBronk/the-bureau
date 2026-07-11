import type { TemplateDefinition } from "../template-engine.js";

export const investigation: TemplateDefinition = {
  id: "investigation",
  name: "Investigation / Spike",
  description: "Read-only research task that produces a findings document. No code changes, no validation gate.",
  whenToUse: "Answer a question or de-risk an approach before implementing. Output is a findings write-up, not code.",
  parameters: {
    question: { type: "string", required: true, description: "What to investigate." },
    role: { type: "string", default: "architect", description: "Investigating role." },
  },
  graph: {
    tasks: [
      {
        id: "investigate",
        role: "{{role}}",
        task: "Investigate (read-only, do not change code): {{question}}\n\nProduce a concise findings document with evidence (file:line references) and a recommendation.",
      },
    ],
  },
};
