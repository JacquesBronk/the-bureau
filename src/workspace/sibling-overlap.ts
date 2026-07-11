import type { TaskNodeInput } from "../types/graph.js";
import { footprintOverlap } from "./graph-registry.js";
import { parseFileRefsFromDescription } from "./ledger.js";

export interface SiblingOverlap {
  a: string; // task id — lexically-smaller of the pair (for stable dedupe)
  b: string; // task id — lexically-larger of the pair
  exact: string[]; // exact-match overlapping files
  dir: string[]; // same-directory (non-exact) neighbour files
}

/** Builds, for every task id, the set of ids it transitively depends on (its ancestors). */
function buildAncestorSets(tasks: TaskNodeInput[]): Map<string, Set<string>> {
  const byId = new Map<string, TaskNodeInput>();
  for (const t of tasks) byId.set(t.id, t);

  const ancestorsOf = (id: string): Set<string> => {
    const ancestors = new Set<string>();
    const visited = new Set<string>([id]);
    const stack = [...(byId.get(id)?.dependsOn ?? [])];
    while (stack.length > 0) {
      const dep = stack.pop()!;
      if (visited.has(dep)) continue;
      visited.add(dep);
      const depTask = byId.get(dep);
      if (!depTask) continue; // unknown dependsOn target — ignore
      ancestors.add(dep);
      for (const next of depTask.dependsOn ?? []) {
        if (!visited.has(next)) stack.push(next);
      }
    }
    return ancestors;
  };

  const result = new Map<string, Set<string>>();
  for (const t of tasks) result.set(t.id, ancestorsOf(t.id));
  return result;
}

const filesOf = (t: TaskNodeInput): string[] => [...new Set(parseFileRefsFromDescription(t.task ?? ""))];

/** Pairs of parallel-sibling tasks (neither transitively depends on the other) whose file
 *  footprints (parseFileRefsFromDescription over task.task) overlap on exact files and/or dirs. */
export function findSiblingFileOverlaps(tasks: TaskNodeInput[]): SiblingOverlap[] {
  const ancestors = buildAncestorSets(tasks);
  const seen = new Set<string>();
  const overlaps: SiblingOverlap[] = [];

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const t1 = tasks[i];
      const t2 = tasks[j];
      if (t1.id === t2.id) continue;

      const t1Ancestors = ancestors.get(t1.id) ?? new Set<string>();
      const t2Ancestors = ancestors.get(t2.id) ?? new Set<string>();
      if (t1Ancestors.has(t2.id) || t2Ancestors.has(t1.id)) continue; // sequenced, not parallel

      const [a, b] = t1.id <= t2.id ? [t1, t2] : [t2, t1];
      const pairKey = `${a.id}|${b.id}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const { exact, dir } = footprintOverlap(filesOf(a), filesOf(b));
      if (exact.length + dir.length === 0) continue;

      overlaps.push({ a: a.id, b: b.id, exact, dir });
    }
  }

  return overlaps;
}

/** Advisory, human-readable warning block. Returns "" when overlaps is empty. */
export function formatSiblingOverlapWarning(overlaps: SiblingOverlap[]): string {
  if (overlaps.length === 0) return "";
  const lines = overlaps.map((o) => {
    if (o.exact.length > 0 && o.dir.length > 0) {
      return (
        `  - "${o.a}" and "${o.b}" both edit the same file(s): ${o.exact.join(", ")}` +
        ` — and also touch different files in the same directory: ${o.dir.join(", ")}`
      );
    }
    if (o.exact.length > 0) {
      return `  - "${o.a}" and "${o.b}" both edit the same file(s): ${o.exact.join(", ")}`;
    }
    return (
      `  - "${o.a}" and "${o.b}" edit different files in the same directory: ${o.dir.join(", ")}`
    );
  });
  const hasExact = overlaps.some((o) => o.exact.length > 0);
  const hasDirOnly = overlaps.some((o) => o.exact.length === 0 && o.dir.length > 0);
  let body: string;
  if (hasExact && hasDirOnly) {
    body =
      `  Parallel tasks are not ordered relative to each other — concurrent edits to the same\n` +
      `  file can conflict or clobber each other, and edits to different files in the same\n` +
      `  directory are a weaker signal worth double-checking.`;
  } else if (hasExact) {
    body =
      `  Parallel tasks are not ordered relative to each other — concurrent edits to the same\n` +
      `  file(s) can conflict or clobber each other.`;
  } else {
    body =
      `  Parallel tasks are not ordered relative to each other — editing different files in the\n` +
      `  same directory doesn't clobber, but is a proximity signal worth double-checking.`;
  }
  return (
    `⚠️ Sibling file-overlap warning: parallel tasks appear to edit overlapping files.\n` +
    `${lines.join("\n")}\n` +
    `${body} Consider: add a dependsOn edge to sequence\n` +
    `  them, or merge the overlapping tasks into one.`
  );
}
