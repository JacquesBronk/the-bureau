import type { TaskNodeInput } from "./types/graph.js";

const LEVEL_PRIORITY: Record<string, number> = { self: 1, unit: 2, integration: 3 };

/** Validate the dependency graph: unknown-dep ids and cycles (Kahn's algorithm).
 *  Pure — depends only on inputs[].id and inputs[].dependsOn. Extracted from
 *  TaskGraphManager.validateDAG so the dry-run path runs the identical check. */
export function validateDAG(inputs: TaskNodeInput[]): void {
  const ids = new Set(inputs.map((i) => i.id));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const input of inputs) {
    inDegree.set(input.id, 0);
    adj.set(input.id, []);
  }
  for (const input of inputs) {
    if (input.dependsOn) {
      for (const dep of input.dependsOn) {
        if (!ids.has(dep)) throw new Error(`Task "${input.id}" depends on unknown task "${dep}"`);
        adj.get(dep)!.push(input.id);
        inDegree.set(input.id, (inDegree.get(input.id) || 0) + 1);
      }
    }
  }
  const queue = [...ids].filter((id) => inDegree.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adj.get(node) || []) {
      const deg = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }
  if (visited !== ids.size) {
    throw new Error(`Dependency cycle detected in task graph. ${ids.size - visited} tasks are in a cycle.`);
  }
}

/** Highest validation level declared across tasks (integration > unit > self), or undefined. */
export function maxValidationLevel(
  inputs: TaskNodeInput[],
): "self" | "unit" | "integration" | undefined {
  let max: "self" | "unit" | "integration" | undefined;
  for (const input of inputs) {
    if (!input.validation) continue;
    const p = LEVEL_PRIORITY[input.validation] ?? 0;
    if (max === undefined || p > (LEVEL_PRIORITY[max] ?? 0)) max = input.validation;
  }
  return max;
}

/** All declare-time input validations that are pure functions of the input:
 *  (1) DAG validity, (2) the #260 guard rejecting an 'agent' criterion mixed with a
 *  task-level unit/integration gate (the synthesized exec would be dropped by the
 *  dispatch split). Called by declareGraph AND the dry-run path — single source of truth. */
export function validateGraphInput(
  inputs: TaskNodeInput[],
  acceptanceCriteria?: Array<{ type: string; coverageIds?: string[] }>,
): void {
  validateDAG(inputs);
  const level = maxValidationLevel(inputs);
  if ((level === "unit" || level === "integration") && acceptanceCriteria?.some((c) => c.type === "agent")) {
    throw new Error(
      `acceptanceCriteria cannot mix an 'agent' criterion with a task-level validation:'${level}' gate — ` +
        `the validation gate is synthesized as an 'exec' criterion at completion and the agent/exec dispatch split would ` +
        `silently drop it. Use one or the other: an 'agent' review criterion, or the mechanical validation:'${level}' gate.`,
    );
  }

  // #306 requirement-coverage checks.
  const withCoverage = (acceptanceCriteria ?? []).filter((c) => c.coverageIds && c.coverageIds.length > 0);
  for (const c of withCoverage) {
    if (c.type !== "exec") {
      throw new Error(`coverageIds is only valid on an 'exec' criterion (found on type '${c.type}').`);
    }
    for (const id of c.coverageIds!) {
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        throw new Error(`invalid coverage id '${id}': ids must match ^[A-Za-z0-9._-]+$.`);
      }
    }
  }
  if (withCoverage.length > 1) {
    throw new Error(
      `at most one exec criterion per graph may carry coverageIds (each exec criterion runs its own pod + test suite).`,
    );
  }
}
