import type { TemplateDefinition } from "../template-engine.js";

export const docs: TemplateDefinition = {
  id: "docs",
  name: "Documentation",
  description: "Documentation-only change in one self-contained task. No validation gate by default.",
  whenToUse: "Write or update docs. No build/test gate; the change is prose.",
  parameters: {
    target: { type: "string", required: true, description: "What to document." },
    role: { type: "string", default: "docs-writer", description: "Writing role." },
  },
  graph: {
    tasks: [
      {
        id: "docs",
        role: "{{role}}",
        task: "Write/update documentation for: {{target}}\n\nSelf-contained: produce accurate, well-structured docs and self-review for correctness before finishing.",
      },
    ],
  },
};
