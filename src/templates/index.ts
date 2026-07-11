import type { TemplateDefinition } from "../template-engine.js";
import { singleTask } from "./single-task.js";
import { parallelTasks } from "./parallel-tasks.js";
import { investigation } from "./investigation.js";
import { designProposal } from "./design-proposal.js";
import { feature } from "./feature.js";
import { bugFix } from "./bug-fix.js";
import { refactor } from "./refactor.js";
import { addTests } from "./add-tests.js";
import { audit } from "./audit.js";
import { docs } from "./docs.js";
import { dependencyUpgrade } from "./dependency-upgrade.js";
import { migration } from "./migration.js";
import { deadCodeRemoval } from "./dead-code-removal.js";
import { integrationFeature } from "./integration-feature.js";
import { targetedTask } from "./targeted-task.js";

/** Every template, id-keyed order. New templates: add the import + this array entry. */
export const TEMPLATE_LIST: TemplateDefinition[] = [
  singleTask,
  parallelTasks,
  investigation,
  designProposal,
  feature,
  bugFix,
  refactor,
  addTests,
  audit,
  docs,
  dependencyUpgrade,
  migration,
  deadCodeRemoval,
  integrationFeature,
  targetedTask,
];

/** Lookup by id OR alias. Aliases let a renamed template keep its old id working. */
export const TEMPLATE_REGISTRY: Record<string, TemplateDefinition> = (() => {
  const reg: Record<string, TemplateDefinition> = {};
  for (const t of TEMPLATE_LIST) {
    if (reg[t.id]) throw new Error(`duplicate template id/alias: ${t.id}`);
    reg[t.id] = t;
    for (const a of t.aliases ?? []) {
      if (reg[a]) throw new Error(`duplicate template id/alias: ${a}`);
      reg[a] = t;
    }
  }
  return reg;
})();
