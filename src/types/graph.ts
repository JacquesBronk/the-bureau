import type { TaskStatus } from "../state-machine.js";
import type { ReviewLoopConfig } from "./task.js";
import type { TaskEvent } from "./event.js";
import type { ValidationFailure } from "./workspace.js";

export type GraphStatus =
  | "active" | "completed" | "failed" | "canceled"
  | "validating" | "validation_failed" | "validated" | "merged"
  | "reworking";

/**
 * Validation-depth ordering shared by the declare-time aggregation
 * (TaskGraphManager.declareGraph) and the dry-run gate-no-install lint —
 * a single source so the lint can never drift from the engine's own
 * "unit-or-higher" semantics. Missing/self-only levels rank below unit.
 */
export const VALIDATION_LEVEL_PRIORITY: Record<string, number> = { self: 1, unit: 2, integration: 3 };

export interface CriterionDef {
  name: string;
  type: 'command' | 'script' | 'assertion' | 'agent' | 'exec';
  check: string;
  inputs?: Record<string, string>;
  onFail: 'fail' | 'retry' | 'fix';
  fixRole?: string;
  maxRetries?: number;
  /** Expected EARS SHALL ids (e.g. ["E-01","E-03"]) whose passing tagged tests must exist.
   *  Valid only on an 'exec' criterion; at most one exec criterion per graph may carry it. */
  coverageIds?: string[];
}

export interface CriterionResult {
  name: string;
  type: CriterionDef['type'];
  status: 'passed' | 'failed' | 'skipped' | 'error';
  evidence: string;
  diagnostic?: string;
  durationMs: number;
  exitCode?: number;
  attempt: number;
}

export interface TaskGraph {
  id: string;
  project: string;
  cwd: string;
  status: GraphStatus;
  createdAt: number;
  completedAt?: number;
  maxConcurrency?: number;
  acceptanceCriteria?: CriterionDef[];
  parentGraphId?: string;
  childGraphIds?: string[];
  mergedIntoGraphId?: string;
  /** Named git destination (registry entry) this graph targets. Absent → the
   *  registry default, preserving single-repo behavior. */
  destination?: string;
  /** Graph-level default toolchain (registry profile name). Per-task `toolchain`
   *  overrides it; absent → engine default ("node"). */
  defaultToolchain?: string;
  /** Aggregate validation level — max of all tasks' individual levels (integration > unit > self). */
  validationLevel?: 'self' | 'unit' | 'integration';
  /** Toolchain the mechanical validation pod runs on — so a Python graph's unit gate boots the
   *  python image (uv/pytest), not the default node image. Aggregated from the first unit-or-higher
   *  task that declares one, falling back at use-site to the graph's defaultToolchain. */
  validationToolchain?: string;
  /** Aggregated install command from the first unit-or-higher task that has an install command set.
   *  Prepended to the test/integration command in the mechanical validation pod so a fresh clone
   *  is buildable before the suite runs (a Python package is not importable without `pip install`).
   *  Empty/absent → the validation check is exactly the test command (the Node path, unchanged). */
  validationInstallCmd?: string;
  /** Aggregated test command from the first unit-or-higher task that has a test command set. */
  validationTestCmd?: string;
  /** Aggregated integration-test command from the first integration-level task that has integrationTest set. */
  validationIntegrationTestCmd?: string;
  /** Ephemeral test service types to lease engine-side for integration-level validation (e.g. ['redis', 'postgres']). */
  testServices?: string[];
  /** Per-graph retro self-improvement override. true = force review; false = suppress; undefined = use config/thresholds. */
  selfImprove?: boolean;
  /** Bounded auto-rework loop (#317) state for the current attempt, present only while
   *  status is "reworking" (or was, on the most recent round). validationChildIds tracks
   *  the re-validation children spawned for this attempt so completion routing can find them.
   *  `failure` carries the Phase-2 ValidationFailure of THIS round (the round's failure
   *  context) — the durable, per-round carrier the reconciler seeds into the fix agent's
   *  prompt and replays as the terminal failure when the loop gives up (6b decision). */
  currentRound?: {
    attempt: number;
    startHead: string;
    /** Integration HEAD captured ONCE at the FIRST round's entry and carried forward
     *  UNCHANGED across every subsequent round (round 1: baselineHead === startHead).
     *  The fix-integrity guard diffs `baselineHead..HEAD` so damage a NON-greening round
     *  committed (e.g. a deleted failing test) stays visible to a later round's guard,
     *  even though `startHead` advances per round. "" = unknown (best-effort, like
     *  startHead). The empty-fix HEAD guard deliberately still uses per-round `startHead`. */
    baselineHead?: string;
    enteredAt: number;
    validationChildIds: string[];
    failure?: ValidationFailure;
    /** #322 — integration-branch HEAD SHA captured at the moment THIS round's
     *  re-validation was DISPATCHED (never the live HEAD at check/promote time).
     *  The fix-integrity guard diffs `baselineHead..revalidationHead` instead of
     *  the live HEAD, and the validated-resolution promote refuses terminally if
     *  the live HEAD no longer matches this SHA — closing the window where a
     *  writer with direct push access to the integration branch could move it
     *  between re-validation and promote (TOCTOU). "" = unknown (best-effort,
     *  like startHead/baselineHead) — never blocks a legitimate promote on
     *  missing data. */
    revalidationHead?: string;
  };
  /** #325 — integration-branch HEAD SHA captured at the moment the FIRST-PASS
   *  (non-rework) validation gate dispatches its FIRST validation child (the
   *  agent-criteria child graph, or the exec-criteria children via
   *  `dispatchExecValidationChildren`) — the `currentRound.revalidationHead`
   *  counterpart for the initial gate, since `currentRound` only exists once a
   *  graph has entered rework. The validated→promote resolution refuses
   *  terminally (`validation_pin_mismatch`) if the live integration HEAD no
   *  longer matches this SHA at promote time, closing the same TOCTOU window
   *  #322 closed for re-validation, now for the first-pass gate too.
   *
   *  Absent (undefined) = no validation child was ever dispatched for this
   *  graph — either it has no validation gate at all (inline-only criteria, or
   *  no acceptanceCriteria), or no pin-capture capability was wired (no
   *  remote-merge hooks), or it's a pre-#325 in-flight graph. All three
   *  legacy-unpinned cases fail OPEN (no refusal) — this field is simply never
   *  consulted for them. "" (present but empty) = a capture attempt ran (hooks
   *  were wired) and failed even after one retry — fails CLOSED, never
   *  silently un-pin. Never touched or consulted once a graph enters
   *  `reworking` — `currentRound.revalidationHead` governs the promote guard
   *  from that point on. */
  validationDispatchHead?: string;
  /** True on a child graph spawned to apply a rework fix — distinguishes it from the
   *  original graph and from ordinary validation/analyzer children. */
  isReworkFixChild?: boolean;
  /** Auto-rework round-index marker (M1 scan key): set ONLY on a fix-CHILD graph (and
   *  its single fix task) to the round it applies to, so the reconciler can locate the
   *  fix child for attempt N by marker. NEVER set on the parent graph — the parent's
   *  consumed-attempt count lives in the ReworkManager budget list, not here. */
  attempt?: number;
  /** Human-readable reason the most recent validation/rework attempt failed. */
  failureReason?: string;
  /** Opt-in bounded auto-rework configuration (#317). Absent = feature off for this graph. */
  autoRework?: { maxAttempts: number; fixRole?: string };
}

export interface TaskNode {
  id: string;
  graphId: string;
  role: string;
  task: string;
  cwd: string;
  project: string;
  branch?: string;
  dependsOn: string[];
  requireApproval: boolean;
  status: TaskStatus;
  sessionId?: string;
  pid?: number;
  exitCode?: number;
  retries: number;
  maxRetries: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  timeoutMs?: number;
  warnAfterMs?: number;
  interrogateAfterMs?: number;
  staleAfterMs?: number;
  reviewLoop?: ReviewLoopConfig;
  autoAdded?: boolean;
  /** Per-task model override. Overrides the role's default model at spawn time. */
  model?: string;
  /** Engine-assigned loadout (D3/D4). Persisted at dispatch so a connecting
   *  worker's privilege is read from the task record, never self-asserted (R4). */
  loadout?: import("../mcp-profiles.js").ProfileName;
  /** Engine-resolved tool capability (config-driven tooling). Persisted at dispatch
   *  so Phase 2 can register the MCP surface per-connection. */
  capability?: import("../runtime/capability.js").Capability;
  /** Pod-mode (k8s): the worker pushed this branch; engine integrates it remotely. */
  podMode?: boolean;
  /** Per-task git base ref override (used by merge-coordinator tasks → conflict branch). */
  gitBaseRef?: string;
  /** Per-task git branch override (used by merge-coordinator tasks). */
  gitBranch?: string;
  /** Per-task toolchain (registry profile name) → selects the worker image. */
  toolchain?: string;
  /** When true the pod runs BUREAU_EXEC_CMD directly (no Claude). Set by the engine for
   *  exec-type acceptance criteria so the validation pod is token-free. */
  execMode?: boolean;
  /** Bind this task to a bureau.buildconfig.json service (name or path). */
  service?: string;
  /** Override the resolved install command (emitted as BUREAU_INSTALL_CMD). */
  install?: string;
  /** Override the resolved build command (emitted as BUREAU_BUILD_CMD). */
  build?: string;
  /** Override the resolved test command (emitted as BUREAU_TEST_CMD). */
  test?: string;
  /** Override the resolved integration-test command (emitted as BUREAU_INTEGRATION_TEST_CMD). */
  integrationTest?: string;
  /** Override the resolved lint command (emitted as BUREAU_LINT_CMD). */
  lint?: string;
  /** Validation depth for this task. Aggregated to graph-level gate (max across tasks). */
  validation?: 'self' | 'unit' | 'integration';
  /** Durable path of this task's captured transcript on the session PVC (k8s capture). */
  sessionLogPath?: string;
  /** Branch pushed by the k8s worker entrypoint finalize trap; used by E1 retry-resume. */
  checkpointBranch?: string;
  /** Human-readable reason this task's execution/validation failed (#317 auto-rework). */
  failureReason?: string;
  /** Bounded auto-rework loop (#317) attempt index (0-3) this task represents — set by
   *  the rework dispatcher. Carried onto the fix agent's invoke_agent span as
   *  bureau.task.attempt so per-attempt cost is attributable. Absent = not a rework attempt. */
  attempt?: number;
}

export interface TaskNodeInput {
  id: string;
  role: string;
  task: string;
  cwd?: string;
  branch?: string;
  dependsOn?: string[];
  requireApproval?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  warnAfterMs?: number;
  interrogateAfterMs?: number;
  staleAfterMs?: number;
  reviewLoop?: ReviewLoopConfig;
  autoAdded?: boolean;
  acceptanceCriteria?: CriterionDef[];
  /** Per-task model override. Overrides the role's default model at spawn time. */
  model?: string;
  /** Pod-mode (k8s): the worker pushed this branch; engine integrates it remotely. */
  podMode?: boolean;
  /** Per-task git base ref override (used by merge-coordinator tasks → conflict branch). */
  gitBaseRef?: string;
  /** Per-task git branch override (used by merge-coordinator tasks). */
  gitBranch?: string;
  /** Per-task toolchain (registry profile name) → selects the worker image. */
  toolchain?: string;
  /** When true the pod runs BUREAU_EXEC_CMD directly (no Claude). Engine-internal; set for
   *  exec-type acceptance criteria so the validation pod is token-free. */
  execMode?: boolean;
  /** Bind this task to a bureau.buildconfig.json service (name or path). */
  service?: string;
  /** Override the resolved install command. */
  install?: string;
  /** Override the resolved build command. */
  build?: string;
  /** Override the resolved test command. */
  test?: string;
  /** Override the resolved integration-test command. */
  integrationTest?: string;
  /** Override the resolved lint command. */
  lint?: string;
  /** Validation depth for this task. Aggregated to graph-level gate (max across tasks). Default: self. */
  validation?: 'self' | 'unit' | 'integration';
  /** Ephemeral test service types required for integration testing (e.g. ['redis', 'postgres']). */
  testServices?: string[];
  /** Opt-in bounded auto-rework configuration (#317), set at graph declaration. */
  autoRework?: { maxAttempts: number; fixRole?: string };
  /** Bounded auto-rework loop (#317) attempt index this task represents — persisted onto
   *  the TaskNode so graph-dispatch tags the fix agent's invoke_agent span with
   *  bureau.task.attempt. Set by the rework fix-child dispatch (Task 6b). */
  attempt?: number;
}

// TaskGraphCallbacks is defined here (references TaskNode and TaskEvent from sibling modules)
export interface TaskGraphCallbacks {
  onDispatch: (graphId: string, task: TaskNode) => Promise<void>;
  onEvent: (event: TaskEvent) => Promise<void>;
  /** Best-effort teardown of a task's running worker (#184). Under k8s pod-mode
   *  this deletes the worker Job so a canceled/killed task stops holding cluster
   *  resources (and can no longer push its branch). Wired in mcp-server.ts to the
   *  spawner; kept as a callback so TaskGraphManager need not import the spawner
   *  (avoids an import cycle). Implementations MUST never throw. */
  killWorker?: (sessionId: string, task: TaskNode) => Promise<void> | void;
  /** Best-effort workspace cleanup on graph teardown (#235). Clears WorkspaceLedger
   *  and DiscoveryStore keys for the graph. Wired in mcp-server.ts; kept as a
   *  callback so TaskGraphManager need not import those stores directly. */
  cleanupWorkspace?: (graphId: string) => Promise<void>;
  /** Retrieve a task's handoff for footprint capture (#235). Returns the handoff
   *  context (including filesChanged) or null if not yet set. */
  getHandoff?: (graphId: string, taskId: string) => Promise<{ filesChanged?: { path: string }[] } | null>;
  /** Read the log tail of a failed validation child's pod, for the failure detail (#306).
   *  k8s-only (wired at the composition root); absent locally. MUST never throw — the
   *  caller treats a throw/undefined as "no detail". */
  readValidationPodLog?: (childGraphId: string) => Promise<string | undefined>;
}
