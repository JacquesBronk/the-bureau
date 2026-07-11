export interface TaskEvent {
  type: "task_ready" | "task_started" | "task_completed" | "task_failed"
      | "task_approval_required" | "task_canceled"
      | "task_progress" | "task_stale" | "task_dead" | "task_timeout" | "task_added"
      | "task_rework_exhausted" | "file_conflict_warning" | "task_warning" | "task_retried"
      | "task_yielded" | "yield_deadlock" | "yield_auto_resolved"
      | "graph_declared" | "graph_started"
      | "graph_completed" | "graph_failed" | "graph_canceled" | "graph_paused"
      | "graph_validating" | "graph_validated" | "graph_validation_failed"
      | "criterion_passed" | "criterion_failed" | "criterion_skipped" | "criterion_fix_started"
      | "graph_awaiting_children"
      | "graphs_merged"
      | "merge_conflict"
      | "child_graph_completed"
      | "worktree_merging"
      | "worktree_merged"
      | "worktree_merge_failed"
      | "merge_queue_waiting"
      | "graph_stalled"
      | "test_service_started"
      | "test_service_stopped"
      | "test_service_expired"
      | "image_not_approved";
  graphId: string;
  /** The id of the task this event relates to. May be a synthetic sentinel (e.g. `"__integration__"`) for graph-scoped merge events that have no real task row. */
  taskId?: string;
  sessionId?: string;
  timestamp: number;
  detail?: string;
  /** Set when this event was bubbled up from a child graph */
  childGraphId?: string;
  /** Populated on graph_declared so downstream consumers (e.g. dashboard) can index without a round-trip */
  project?: string;
  parentGraphId?: string;
  taskCount?: number;
  /** Populated on test_service_* events */
  serviceId?: string;
  serviceType?: string;
  /** Populated on image_not_approved */
  imageRef?: string;
  /** Populated on task_failed: the real process exit code from the agent. */
  exitCode?: number;
  /** Populated on task_failed: low-cardinality classified failure reason (safe as OTel error.type label). */
  failureReason?: string;
}

/**
 * A TaskEvent enriched at read time with its Redis stream coordinates.
 * `streamId` is assigned by Redis at XADD (`*`) and read back on consume — a read-side
 * enrichment, never an emitted field. Format "<ms>-<seq>": cursor + dedup key + gap detector.
 * `project` is the source stream, needed when tailing multiple projects at once.
 */
export interface ObserverEvent extends TaskEvent {
  streamId: string;
  project: string;
}
