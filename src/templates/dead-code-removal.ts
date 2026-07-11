import type { TemplateDefinition } from "../template-engine.js";

export const deadCodeRemoval: TemplateDefinition = {
  id: "dead-code-removal",
  name: "Dead Code Removal",
  description: "Remove unused code in one self-contained task; mechanical validation gate guards against removing something live.",
  whenToUse: "Delete confirmed-dead code. Supply buildConfig to arm the validation gate — a green suite is the safety net.",
  parameters: {
    target: { type: "string", required: true, description: "What dead code to remove (be specific)." },
    validation: { type: "string", default: "unit", description: "Validation depth: self | unit | integration." },
    service: { type: "string", default: "", description: "buildConfig service to resolve commands from (optional)." },
  },
  graph: {
    tasks: [
      {
        id: "cleanup",
        role: "refactorer",
        task: "Remove dead code: {{target}}\n\nSelf-contained: confirm each removal is truly unused, delete it, run the suite green, and self-review before finishing.",
        validation: "{{validation}}",
        service: "{{service}}",
      },
    ],
  },
};
