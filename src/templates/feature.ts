import type { TemplateDefinition } from "../template-engine.js";

export const feature: TemplateDefinition = {
  id: "feature",
  name: "Feature",
  description: "Implement a feature end-to-end in one self-contained task: code, tests, self-review; mechanical validation gate.",
  whenToUse: "A new feature one agent can own. Supply buildConfig (or a committed .bureau/config.json) to arm the validation gate.",
  aliases: ["standard-feature"],
  parameters: {
    task: { type: "string", required: true, description: "What to build." },
    role: { type: "string", default: "coder", description: "Implementation role." },
    validation: { type: "string", default: "unit", description: "Validation depth: self | unit | integration." },
    service: { type: "string", default: "", description: "buildConfig service to resolve commands from (optional)." },
  },
  graph: {
    tasks: [
      {
        id: "impl",
        role: "{{role}}",
        task: "Implement: {{task}}\n\nSelf-contained: write the implementation AND its tests, run them green, and self-review the diff for correctness and scope before finishing.",
        validation: "{{validation}}",
        service: "{{service}}",
      },
    ],
  },
};
