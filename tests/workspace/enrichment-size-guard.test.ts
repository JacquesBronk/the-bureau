import { describe, it, expect } from "vitest";
import { formatConflictNote, formatWorkspaceSummary } from "../../src/workspace/enrichment.js";
import type { WorkspaceConflict, WorkspaceIntent } from "../../src/types/workspace.js";

const KB = 1024;
const bigDesc = "x".repeat(10 * KB);

const baseIntent = (): WorkspaceIntent => ({
  taskId: "task-b",
  graphId: "g1",
  files: ["src/some-file.ts"],
  description: bigDesc,
  role: "implementer",
  sessionId: "s1",
  updatedAt: Date.now(),
  phase: "implementing",
  lastDiscoveryId: "0-0",
});

describe("enrichment size guard (Redis-free)", () => {
  it("formatConflictNote output stays under 2KB given a ~10KB description", () => {
    const conflict: WorkspaceConflict = {
      taskA: "task-a",
      taskB: "task-b",
      files: ["src/some-file.ts"],
      severity: "high",
      detectedAt: Date.now(),
    };
    const note = formatConflictNote(conflict, new Map([["task-b", baseIntent()]]));
    expect(note.length).toBeLessThan(2 * KB);
  });

  it("formatWorkspaceSummary output stays under 2KB given a ~10KB description", () => {
    const summary = formatWorkspaceSummary([baseIntent()]);
    expect(summary.length).toBeLessThan(2 * KB);
  });
});
