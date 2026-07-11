import type { TemplateDefinition } from "../template-engine.js";

export const parallelTasks: TemplateDefinition = {
  id: "parallel-tasks",
  name: "Parallel Disjoint Tasks",
  description: "Fan out independent, disjoint-file tasks in parallel; each is self-contained and merges at the end. Graph-level validation runs on the merged result.",
  whenToUse: "Multiple changes that touch DIFFERENT files and don't depend on each other's code. Set maxConcurrency. Do NOT use for code-coupled work.",
  aliases: ["parallel-features"],
  parameters: {
    items: { type: "string", required: true, description: "Comma-separated list of disjoint tasks to run in parallel." },
    role: { type: "string", default: "coder", description: "Agent role for each task." },
    validation: { type: "string", default: "unit", description: "Validation depth applied to each task: self | unit | integration." },
  },
  graph: {
    tasks: [
      {
        id: "task",
        role: "{{role}}",
        task: "Complete this self-contained unit of work (impl + tests + self-review): {{item}}",
        validation: "{{validation}}",
        forEach: "items",
      },
    ],
  },
};
