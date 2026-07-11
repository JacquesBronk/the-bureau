import type { TemplateDefinition } from "../template-engine.js";

export const migration: TemplateDefinition = {
  id: "migration",
  name: "Migration (disjoint parallel)",
  description: "Apply the same mechanical transformation across many disjoint files in parallel; each unit is self-contained and merges at the end.",
  whenToUse: "A repetitive, mechanical change spread over independent files (e.g. rename an API across modules). List the disjoint units in `units`; set maxConcurrency.",
  parameters: {
    change: { type: "string", required: true, description: "The transformation to apply to each unit." },
    units: { type: "string", required: true, description: "Comma-separated disjoint targets (files/modules) to transform in parallel." },
    validation: { type: "string", default: "unit", description: "Validation depth applied per unit." },
    role: { type: "string", default: "coder" },
  },
  graph: {
    tasks: [
      {
        id: "migrate",
        role: "{{role}}",
        task: "Apply this change to {{item}}: {{change}}\n\nSelf-contained: transform only this unit, keep tests passing, and self-review before finishing.",
        validation: "{{validation}}",
        forEach: "units",
      },
    ],
  },
};
