/**
 * Per-graph integration branch: workers push a per-task branch, the engine merges each
 * into `bureau/<g8>/integration` on completion (src/spawn/remote-merge.ts), so integration
 * accumulates every completed task. A pod-mode task WITH deps must clone integration (its
 * predecessors' merged code) rather than the graph base ref (`main`), which lacks it. See #311.
 */
export function integrationBranchName(graphId: string): string {
  return `bureau/${graphId.slice(0, 8)}/integration`;
}

export function resolveHandoffBaseRef(params: {
  task: { id: string; dependsOn?: string[]; execMode?: boolean; gitBaseRef?: string };
  graphId: string;
  isK8s: boolean;
  hasGitDestination: boolean;
}): string | undefined {
  const { task, graphId, isK8s, hasGitDestination } = params;
  // Explicit base ref wins: criterion tasks pin integration (task-graph.ts:1676) and
  // merge-coordinator tasks pin the conflict branch (task-graph.ts:361).
  if (task.gitBaseRef) return task.gitBaseRef;
  // Handoff-from-integration is a pod-mode + git-destination concept only. Local/stdio
  // mode shares an object store and behaves differently; no destination => no integration branch.
  if (!isK8s || !hasGitDestination) return undefined;
  // Exec-mode pods run a command directly and never touch git.
  if (task.execMode) return undefined;
  // merge-coordinator tasks are handled by their explicit gitBaseRef above; belt-and-suspenders.
  if (task.id.startsWith("merge-")) return undefined;
  // Root / no-dep tasks clone the graph base ref (`main`); only dependents base off integration.
  if (!task.dependsOn || task.dependsOn.length === 0) return undefined;
  return integrationBranchName(graphId);
}
