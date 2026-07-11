export interface TemplateDefinition {
  id: string;
  name?: string;
  description?: string;
  whenToUse?: string;
  aliases?: string[];
  parameters: Record<string, {
    type?: string;
    required?: boolean;
    default?: any;
    description?: string;
  }>;
  graph: {
    acceptanceCriteria?: any;
    isolateParallel?: boolean;
    tasks: any[];
  };
}

export class TemplateEngine {
  static render(template: string, vars: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return vars[key] !== undefined ? String(vars[key]) : match;
    });
  }

  static expandTemplate(
    template: TemplateDefinition,
    params: Record<string, any>,
  ): { acceptanceCriteria?: any; isolateParallel?: boolean; tasks: any[] } {
    // Resolve parameter values (apply defaults, check required)
    const resolved: Record<string, any> = {};
    for (const [key, spec] of Object.entries(template.parameters)) {
      if (params[key] !== undefined) {
        resolved[key] = params[key];
      } else if (spec.default !== undefined) {
        resolved[key] = spec.default;
      } else if (spec.required) {
        throw new Error(`Required parameter "${key}" not provided`);
      }
    }

    for (const [key, value] of Object.entries(params)) {
      if (!(key in resolved)) resolved[key] = value;
    }

    // Expand forEach tasks and build an id-replacement map
    // idMap: originalId → [expandedId, ...] (for dep-rewiring)
    const idMap = new Map<string, string[]>();
    const expandedTasks: any[] = [];

    for (const task of template.graph.tasks) {
      if (task.forEach !== undefined) {
        const paramName: string = task.forEach;

        if (resolved[paramName] === undefined) {
          throw new Error(
            `forEach references unknown parameter "${paramName}" in task "${task.id}"`,
          );
        }

        const rawValue: string = String(resolved[paramName]);
        const items = rawValue
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        if (items.length === 0) {
          throw new Error(
            `forEach parameter "${paramName}" expanded to zero items — empty pipeline stage is a misconfiguration`,
          );
        }

        const cloneIds: string[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const cloneId = `${task.id}-${i}`;
          cloneIds.push(cloneId);

          // Substitute {{item}} + all other params in a deep-clone of this task
          const taskVarsWithItem = { ...resolved, item };
          const taskJson = JSON.stringify(task);
          const rendered = this.render(taskJson, taskVarsWithItem);
          const clone = JSON.parse(rendered);

          // Override id, strip forEach
          clone.id = cloneId;
          delete clone.forEach;

          expandedTasks.push(clone);
        }

        idMap.set(task.id, cloneIds);
      } else {
        // Regular task — serialize, substitute vars, parse back
        const taskJson = JSON.stringify(task);
        const rendered = this.render(taskJson, resolved);
        expandedTasks.push(JSON.parse(rendered));
      }
    }

    // Dep-rewiring: for each non-forEach task, replace any dependsOn/deps entry
    // that matches an expanded forEach id with the full list of clone ids.
    const depFields = ["dependsOn", "deps"] as const;
    for (const task of expandedTasks) {
      for (const field of depFields) {
        if (!Array.isArray(task[field])) continue;
        const rewired: string[] = [];
        for (const dep of task[field] as string[]) {
          const expansion = idMap.get(dep);
          if (expansion) {
            // Intentional cross-product fan-in: every forEach clone that depends on another forEach
            // group receives ALL clones of that group as deps (not just the same-index peer).
            rewired.push(...expansion);
          } else {
            rewired.push(dep);
          }
        }
        task[field] = rewired;
      }
    }

    // Rebuild graph result (render acceptanceCriteria / isolateParallel too)
    const { tasks: _tasks, ...graphRest } = template.graph;
    const restJson = JSON.stringify(graphRest);
    const restRendered = this.render(restJson, resolved);
    const parsedRest = JSON.parse(restRendered);

    return { ...parsedRest, tasks: expandedTasks };
  }
}
