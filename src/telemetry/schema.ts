/**
 * schema.ts — type contract for the entire telemetry surface.
 *
 * Pure types + const maps. Zero runtime dependencies.
 * See docs/superpowers/specs/2026-04-11-telemetry-architecture-design.md §7.
 */

// ── Branded cardinality types (§7.8) ─────────────────────────────────────────

/** Safe to use as metric labels. Enforced by metric-emission functions. */
type LowCardinalityAttr = string & { __brand: "LowCardinality" };

/** Span attributes only — NOT safe as metric labels. */
type HighCardinalityAttr = string & { __brand: "HighCardinality" };

// ── String-literal unions (§7.1) ─────────────────────────────────────────────

/** Union of all 79 metric names (§7.3). */
export type MetricName =
  // §7.3.1 GenAI semantic-convention metrics
  | "gen_ai.client.token.usage"
  | "gen_ai.client.operation.duration"
  // §7.3.2 Bureau agent
  | "bureau.agent.cost_usd"
  | "bureau.agent.cost_usd.total"
  | "bureau.agent.cache_hit_rate"
  // §7.3.15 Bureau transcript visibility (#313-B)
  | "bureau.transcript.read"
  | "bureau.cost.source"
  // §7.3.3 Bureau task
  | "bureau.task.completed"
  | "bureau.task.failed"
  | "bureau.task.duration"
  | "bureau.task.retries"
  | "bureau.task.dispatch_latency"
  | "bureau.task.queue_depth"
  | "bureau.task.approval_waiting"
  | "bureau.task.warning"
  | "bureau.task.stale"
  | "bureau.task.dead"
  | "bureau.task.timeout"
  | "bureau.tasks.in_flight"
  | "bureau.tasks.yielded"
  // §7.3.4 Bureau graph
  | "bureau.graph.started"
  | "bureau.graph.completed"
  | "bureau.graph.failed"
  | "bureau.graph.canceled"
  | "bureau.graph.duration"
  | "bureau.graph.validation_failed"
  | "bureau.graph.task_count"
  | "bureau.graph.depth"
  | "bureau.graph.active"
  | "bureau.graph.awaiting_children"
  | "bureau.graph.paused"
  | "bureau.graph.cost_usd"
  // §7.3.12 Bureau criterion
  | "bureau.criterion.total"
  | "bureau.criterion.duration"
  | "bureau.criterion.retries"
  | "bureau.criterion.fixes"
  | "bureau.plugin.total"
  | "bureau.plugin.duration"
  | "bureau.validation_graph.total"
  | "bureau.validation_graph.duration"
  | "bureau.validation.dispatched"
  | "bureau.validation.result"
  | "bureau.validation.no_test_command"
  // §7.3.11 Bureau lock + rework
  | "bureau.lock.contention"
  | "bureau.rework.iterations"
  | "bureau.rework.exhausted"
  // §7.3.5 Bureau yield
  | "bureau.yield.started"
  | "bureau.yield.resolved"
  | "bureau.yield.duration"
  | "bureau.yield.active"
  // §7.3.6 Bureau dispatch / spawn
  | "bureau.dispatch.concurrency"
  | "bureau.dispatch.throttled"
  | "bureau.spawn.failures"
  // §7.3.7 Bureau anomaly
  | "bureau.anomaly.detected"
  | "bureau.cache_anomaly.evaluations"
  | "bureau.cache_anomaly.cooldown_suppressions"
  // §7.3.8 Bureau infrastructure
  | "bureau.redis.operation.duration"
  | "bureau.redis.operation.errors"
  | "bureau.mcp_tool.errors"
  | "bureau.memory.free_bytes"
  // §7.3.13 Bureau worktree
  | "bureau.worktree.merge.total"
  | "bureau.worktree.merge.duration"
  | "bureau.worktree.merge.error"
  // §7.3.14 Bureau git
  | "bureau.git.op"
  // §7.3.9 Bureau event bridge
  | "bureau.event"
  // §7.3.10 Node runtime (OTel semantic convention)
  | "process.runtime.nodejs.memory.heap_used"
  | "process.runtime.nodejs.memory.heap_total"
  | "process.runtime.nodejs.memory.rss"
  | "process.runtime.nodejs.memory.external"
  | "process.runtime.nodejs.cpu.user"
  | "process.runtime.nodejs.cpu.system"
  | "process.runtime.nodejs.event_loop.delay"
  | "process.runtime.nodejs.gc.duration"
  | "process.runtime.nodejs.gc.count"
  | "process.runtime.nodejs.handles.active"
  | "process.runtime.nodejs.requests.active";

/** Union of all attribute keys across all three cardinality buckets (§7.4). */
export type AttributeKey =
  // Low-cardinality
  | "gen_ai.operation.name"
  | "gen_ai.provider.name"
  | "gen_ai.request.model"
  | "gen_ai.response.model"
  | "gen_ai.token.type"
  | "gen_ai.tool.name"
  | "error.type"
  // OTel stable code-provenance attributes (span-only) — link spans to source symbols (#219)
  | "code.function.name"
  | "bureau.role"
  | "bureau.project"
  | "bureau.event.type"
  | "bureau.anomaly.type"
  | "bureau.anomaly.severity"
  | "bureau.yield.reason_category"
  | "bureau.yield.resolution"
  | "bureau.task.exit_code"
  | "bureau.redis.operation"
  | "bureau.redis.key_prefix"
  | "bureau.redis.batch_size"
  | "detector.type"
  | "db.system"
  | "db.operation"
  | "bureau.graph.has_parent"
  | "bureau.criterion.name"
  | "bureau.criterion.type"
  | "bureau.criterion.status"
  | "bureau.criterion.plugin"
  | "bureau.fix.role"
  | "bureau.validation.level"
  | "bureau.validation.result"
  | "bureau.validation.failed_criteria"
  | "bureau.worktree.merge.status"
  | "bureau.git.operation"
  | "bureau.git.ok"
  | "bureau.git.repo"
  | "bureau.git.attempt"
  | "bureau.git.transient"
  | "bureau.error.category"
  | "reason"
  | "bureau.toolchain"
  | "bureau.dispatch.mode"
  | "bureau.task.attempt"
  // §7.3.15 Bureau transcript visibility labels (#313-B)
  | "consumer"
  | "result"
  | "source"
  // §7.3.16 Bureau per-turn/per-tool child spans (#355) — span-only, reconstructed
  // post-hoc from the worker transcript; tool.name is a bounded set like gen_ai.tool.name
  | "bureau.tool.name"
  | "bureau.tool.source"
  // High-cardinality
  | "bureau.parent.graph.id"
  | "bureau.graph.id"
  | "bureau.task.id"
  | "bureau.session.id"
  | "bureau.agent.prefix_hash"
  | "bureau.yield.reason"
  | "bureau.worker.image"
  // §7.3.16 unbounded per-run counters — never metric labels
  | "bureau.turn.index"
  | "bureau.tool.call_index"
  // Resource attributes
  | "service.name"
  | "service.version"
  | "service.version.commit"
  | "service.instance.id"
  | "deployment.environment"
  | "host.name"
  | "process.pid"
  | "process.runtime.name"
  | "process.runtime.version"
  | "k8s.pod.name";

export type GenAiOperationName = "invoke_agent" | "execute_tool" | "create_agent";

export type GenAiTokenType = "input" | "output";

export type InstrumentationSeam = "redis" | "mcp_tool" | "pty" | "runtime";

export type AnomalyType =
  | "cache.prefix_thrash"
  | "cache.uncached_agent"
  | "cache.prefix_instability"
  | "cache.ttl_expired_thrash"
  | "cost.runaway_agent"
  | "cache.breakpoint_exhaustion"
  | "lifecycle.missing_handoff"
  | "lifecycle.missing_status"
  | "dispatch.zombie_task";

// ── Runtime constants (§7.2) ──────────────────────────────────────────────────

/**
 * All 79 metric names, keyed by SCREAMING_SNAKE_CASE constant.
 * Typed as Record<string, MetricName> so a typo in any value fails compilation.
 */
export const METRIC: Record<string, MetricName> = {
  // §7.3.1 GenAI semantic-convention metrics
  TOKEN_USAGE:                          "gen_ai.client.token.usage",
  OPERATION_DURATION:                   "gen_ai.client.operation.duration",
  // §7.3.2 Bureau agent
  AGENT_COST_USD:                       "bureau.agent.cost_usd",
  AGENT_COST_USD_TOTAL:                 "bureau.agent.cost_usd.total",
  AGENT_CACHE_HIT_RATE:                 "bureau.agent.cache_hit_rate",
  // §7.3.15 Bureau transcript visibility (#313-B)
  TRANSCRIPT_READ:                      "bureau.transcript.read",
  COST_SOURCE:                          "bureau.cost.source",
  // §7.3.3 Bureau task
  TASK_COMPLETED:                       "bureau.task.completed",
  TASK_FAILED:                          "bureau.task.failed",
  TASK_DURATION:                        "bureau.task.duration",
  TASK_RETRIES:                         "bureau.task.retries",
  TASK_DISPATCH_LATENCY:                "bureau.task.dispatch_latency",
  TASK_QUEUE_DEPTH:                     "bureau.task.queue_depth",
  TASK_APPROVAL_WAITING:                "bureau.task.approval_waiting",
  TASK_WARNING:                         "bureau.task.warning",
  TASK_STALE:                           "bureau.task.stale",
  TASK_DEAD:                            "bureau.task.dead",
  TASK_TIMEOUT:                         "bureau.task.timeout",
  TASKS_IN_FLIGHT:                      "bureau.tasks.in_flight",
  TASKS_YIELDED:                        "bureau.tasks.yielded",
  // §7.3.4 Bureau graph
  GRAPH_STARTED:                        "bureau.graph.started",
  GRAPH_COMPLETED:                      "bureau.graph.completed",
  GRAPH_FAILED:                         "bureau.graph.failed",
  GRAPH_CANCELED:                       "bureau.graph.canceled",
  GRAPH_DURATION:                       "bureau.graph.duration",
  GRAPH_VALIDATION_FAILED:              "bureau.graph.validation_failed",
  GRAPH_TASK_COUNT:                     "bureau.graph.task_count",
  GRAPH_DEPTH:                          "bureau.graph.depth",
  GRAPH_ACTIVE:                         "bureau.graph.active",
  GRAPH_AWAITING_CHILDREN:              "bureau.graph.awaiting_children",
  GRAPH_PAUSED:                         "bureau.graph.paused",
  GRAPH_COST_USD:                       "bureau.graph.cost_usd",
  // §7.3.12 Bureau criterion
  CRITERION_TOTAL:                      "bureau.criterion.total",
  CRITERION_DURATION:                   "bureau.criterion.duration",
  CRITERION_RETRIES:                    "bureau.criterion.retries",
  CRITERION_FIXES:                      "bureau.criterion.fixes",
  PLUGIN_TOTAL:                         "bureau.plugin.total",
  PLUGIN_DURATION:                      "bureau.plugin.duration",
  VALIDATION_GRAPH_TOTAL:               "bureau.validation_graph.total",
  VALIDATION_GRAPH_DURATION:            "bureau.validation_graph.duration",
  VALIDATION_DISPATCHED:                "bureau.validation.dispatched",
  VALIDATION_RESULT:                    "bureau.validation.result",
  VALIDATION_NO_TEST_COMMAND:           "bureau.validation.no_test_command",
  // §7.3.11 Bureau lock + rework
  LOCK_CONTENTION:                      "bureau.lock.contention",
  REWORK_ITERATIONS:                    "bureau.rework.iterations",
  REWORK_EXHAUSTED:                     "bureau.rework.exhausted",
  // §7.3.5 Bureau yield
  YIELD_STARTED:                        "bureau.yield.started",
  YIELD_RESOLVED:                       "bureau.yield.resolved",
  YIELD_DURATION:                       "bureau.yield.duration",
  YIELD_ACTIVE:                         "bureau.yield.active",
  // §7.3.6 Bureau dispatch / spawn
  DISPATCH_CONCURRENCY:                 "bureau.dispatch.concurrency",
  DISPATCH_THROTTLED:                   "bureau.dispatch.throttled",
  SPAWN_FAILURES:                       "bureau.spawn.failures",
  // §7.3.7 Bureau anomaly
  ANOMALY_DETECTED:                     "bureau.anomaly.detected",
  CACHE_ANOMALY_EVALUATIONS:            "bureau.cache_anomaly.evaluations",
  CACHE_ANOMALY_COOLDOWN_SUPPRESSIONS:  "bureau.cache_anomaly.cooldown_suppressions",
  // §7.3.8 Bureau infrastructure
  REDIS_OPERATION_DURATION:             "bureau.redis.operation.duration",
  REDIS_OPERATION_ERRORS:               "bureau.redis.operation.errors",
  MCP_TOOL_ERRORS:                      "bureau.mcp_tool.errors",
  MEMORY_FREE_BYTES:                    "bureau.memory.free_bytes",
  // §7.3.13 Bureau worktree
  WORKTREE_MERGE_TOTAL:                 "bureau.worktree.merge.total",
  WORKTREE_MERGE_DURATION:              "bureau.worktree.merge.duration",
  WORKTREE_MERGE_ERROR:                 "bureau.worktree.merge.error",
  // §7.3.14 Bureau git
  GIT_OP:                               "bureau.git.op",
  // §7.3.9 Bureau event bridge
  EVENT:                                "bureau.event",
  // §7.3.10 Node runtime
  NODEJS_MEMORY_HEAP_USED:              "process.runtime.nodejs.memory.heap_used",
  NODEJS_MEMORY_HEAP_TOTAL:             "process.runtime.nodejs.memory.heap_total",
  NODEJS_MEMORY_RSS:                    "process.runtime.nodejs.memory.rss",
  NODEJS_MEMORY_EXTERNAL:               "process.runtime.nodejs.memory.external",
  NODEJS_CPU_USER:                      "process.runtime.nodejs.cpu.user",
  NODEJS_CPU_SYSTEM:                    "process.runtime.nodejs.cpu.system",
  NODEJS_EVENT_LOOP_DELAY:              "process.runtime.nodejs.event_loop.delay",
  NODEJS_GC_DURATION:                   "process.runtime.nodejs.gc.duration",
  NODEJS_GC_COUNT:                      "process.runtime.nodejs.gc.count",
  NODEJS_HANDLES_ACTIVE:                "process.runtime.nodejs.handles.active",
  NODEJS_REQUESTS_ACTIVE:               "process.runtime.nodejs.requests.active",
} as const;

/**
 * All attribute keys (all three buckets), keyed by SCREAMING_SNAKE_CASE.
 * Typed as Record<string, AttributeKey> so a typo in any value fails compilation.
 */
export const ATTR: Record<string, AttributeKey> = {
  // Low-cardinality
  OPERATION_NAME:         "gen_ai.operation.name",
  PROVIDER_NAME:          "gen_ai.provider.name",
  REQUEST_MODEL:          "gen_ai.request.model",
  RESPONSE_MODEL:         "gen_ai.response.model",
  TOKEN_TYPE:             "gen_ai.token.type",
  TOOL_NAME:              "gen_ai.tool.name",
  ERROR_TYPE:             "error.type",
  CODE_FUNCTION_NAME:     "code.function.name",
  ROLE:                   "bureau.role",
  PROJECT:                "bureau.project",
  EVENT_TYPE:             "bureau.event.type",
  ANOMALY_TYPE:           "bureau.anomaly.type",
  ANOMALY_SEVERITY:       "bureau.anomaly.severity",
  YIELD_REASON_CATEGORY:  "bureau.yield.reason_category",
  YIELD_RESOLUTION:       "bureau.yield.resolution",
  TASK_EXIT_CODE:         "bureau.task.exit_code",
  REDIS_OPERATION:        "bureau.redis.operation",
  REDIS_KEY_PREFIX:       "bureau.redis.key_prefix",
  REDIS_BATCH_SIZE:       "bureau.redis.batch_size",
  DETECTOR_TYPE:          "detector.type",
  DB_SYSTEM:              "db.system",
  DB_OPERATION:           "db.operation",
  GRAPH_HAS_PARENT:       "bureau.graph.has_parent",
  CRITERION_NAME:         "bureau.criterion.name",
  CRITERION_TYPE:         "bureau.criterion.type",
  CRITERION_STATUS:       "bureau.criterion.status",
  CRITERION_PLUGIN:       "bureau.criterion.plugin",
  FIX_ROLE:               "bureau.fix.role",
  VALIDATION_LEVEL:       "bureau.validation.level",
  VALIDATION_RESULT:      "bureau.validation.result",
  VALIDATION_FAILED_CRITERIA: "bureau.validation.failed_criteria",
  WORKTREE_MERGE_STATUS:  "bureau.worktree.merge.status",
  GIT_OPERATION:          "bureau.git.operation",
  GIT_OK:                 "bureau.git.ok",
  GIT_REPO:               "bureau.git.repo",
  GIT_ATTEMPT:            "bureau.git.attempt",
  GIT_TRANSIENT:          "bureau.git.transient",
  ERROR_CATEGORY:         "bureau.error.category",
  REASON:                 "reason",
  TOOLCHAIN:              "bureau.toolchain",
  DISPATCH_MODE:          "bureau.dispatch.mode",
  // Bounded auto-rework loop (#317) attempt index — DISTINCT from GIT_ATTEMPT above:
  // GIT_ATTEMPT counts git-push retries within a single git operation; TASK_ATTEMPT
  // counts rework-loop iterations (0-3) for a fix agent's invoke_agent span, so
  // per-attempt cost is attributable.
  TASK_ATTEMPT:           "bureau.task.attempt",
  // §7.3.15 Bureau transcript visibility labels (#313-B)
  TRANSCRIPT_CONSUMER:    "consumer",
  TRANSCRIPT_RESULT:      "result",
  COST_SOURCE:            "source",
  // §7.3.16 Bureau per-turn/per-tool child spans (#355)
  BUREAU_TOOL_NAME:       "bureau.tool.name",
  TOOL_SOURCE:            "bureau.tool.source",
  // High-cardinality
  PARENT_GRAPH_ID:        "bureau.parent.graph.id",
  GRAPH_ID:               "bureau.graph.id",
  TASK_ID:                "bureau.task.id",
  SESSION_ID:             "bureau.session.id",
  AGENT_PREFIX_HASH:      "bureau.agent.prefix_hash",
  YIELD_REASON:           "bureau.yield.reason",
  WORKER_IMAGE:           "bureau.worker.image",
  TURN_INDEX:             "bureau.turn.index",
  TOOL_CALL_INDEX:        "bureau.tool.call_index",
  // Resource attributes
  SERVICE_NAME:           "service.name",
  SERVICE_VERSION:        "service.version",
  SERVICE_VERSION_COMMIT: "service.version.commit",
  SERVICE_INSTANCE_ID:    "service.instance.id",
  DEPLOYMENT_ENV:         "deployment.environment",
  HOST_NAME:              "host.name",
  PROCESS_PID:            "process.pid",
  RUNTIME_NAME:           "process.runtime.name",
  RUNTIME_VERSION:        "process.runtime.version",
  K8S_POD_NAME:           "k8s.pod.name",
} as const;

/**
 * Low-cardinality attribute keys — safe as metric labels (§7.8).
 * Metric-emission functions accept Record<LowCardinalityAttr, string | number | boolean>.
 */
export const ATTR_LOW: Record<string, LowCardinalityAttr> = {
  OPERATION_NAME:         "gen_ai.operation.name"       as LowCardinalityAttr,
  PROVIDER_NAME:          "gen_ai.provider.name"        as LowCardinalityAttr,
  REQUEST_MODEL:          "gen_ai.request.model"        as LowCardinalityAttr,
  RESPONSE_MODEL:         "gen_ai.response.model"       as LowCardinalityAttr,
  TOKEN_TYPE:             "gen_ai.token.type"           as LowCardinalityAttr,
  TOOL_NAME:              "gen_ai.tool.name"            as LowCardinalityAttr,
  ERROR_TYPE:             "error.type"                  as LowCardinalityAttr,
  ROLE:                   "bureau.role"                 as LowCardinalityAttr,
  PROJECT:                "bureau.project"              as LowCardinalityAttr,
  EVENT_TYPE:             "bureau.event.type"           as LowCardinalityAttr,
  ANOMALY_TYPE:           "bureau.anomaly.type"         as LowCardinalityAttr,
  ANOMALY_SEVERITY:       "bureau.anomaly.severity"     as LowCardinalityAttr,
  YIELD_REASON_CATEGORY:  "bureau.yield.reason_category" as LowCardinalityAttr,
  YIELD_RESOLUTION:       "bureau.yield.resolution"     as LowCardinalityAttr,
  TASK_EXIT_CODE:         "bureau.task.exit_code"       as LowCardinalityAttr,
  REDIS_OPERATION:        "bureau.redis.operation"      as LowCardinalityAttr,
  REDIS_KEY_PREFIX:       "bureau.redis.key_prefix"     as LowCardinalityAttr,
  REDIS_BATCH_SIZE:       "bureau.redis.batch_size"     as LowCardinalityAttr,
  DETECTOR_TYPE:          "detector.type"               as LowCardinalityAttr,
  DB_SYSTEM:              "db.system"                   as LowCardinalityAttr,
  DB_OPERATION:           "db.operation"                as LowCardinalityAttr,
  GRAPH_HAS_PARENT:       "bureau.graph.has_parent"     as LowCardinalityAttr,
  CRITERION_NAME:         "bureau.criterion.name"       as LowCardinalityAttr,
  CRITERION_TYPE:         "bureau.criterion.type"       as LowCardinalityAttr,
  CRITERION_STATUS:       "bureau.criterion.status"     as LowCardinalityAttr,
  CRITERION_PLUGIN:       "bureau.criterion.plugin"     as LowCardinalityAttr,
  FIX_ROLE:               "bureau.fix.role"             as LowCardinalityAttr,
  VALIDATION_LEVEL:       "bureau.validation.level"     as LowCardinalityAttr,
  VALIDATION_RESULT:      "bureau.validation.result"    as LowCardinalityAttr,
  VALIDATION_FAILED_CRITERIA: "bureau.validation.failed_criteria" as LowCardinalityAttr, // bounded bucket: "0"|"1"|"2-5"|"6+" — never the raw count or graph.id (§7.8)
  WORKTREE_MERGE_STATUS:  "bureau.worktree.merge.status" as LowCardinalityAttr,
  GIT_OPERATION:          "bureau.git.operation"         as LowCardinalityAttr,
  GIT_OK:                 "bureau.git.ok"                as LowCardinalityAttr,
  GIT_REPO:               "bureau.git.repo"              as LowCardinalityAttr, // assumes bureau's bounded worktree name space — not safe for arbitrary repo URLs
  GIT_ATTEMPT:            "bureau.git.attempt"           as LowCardinalityAttr, // 0-indexed attempt number; bounded 0-2 cardinality
  GIT_TRANSIENT:          "bureau.git.transient"         as LowCardinalityAttr, // "true" when op failed due to transient provider error
  ERROR_CATEGORY:         "bureau.error.category"        as LowCardinalityAttr, // bounded enum: "git" | "merge" | "agent" | "dispatch"
  REASON:                 "reason"                      as LowCardinalityAttr,
  TOOLCHAIN:              "bureau.toolchain"             as LowCardinalityAttr,
  DISPATCH_MODE:          "bureau.dispatch.mode"         as LowCardinalityAttr,
  TASK_ATTEMPT:           "bureau.task.attempt"          as LowCardinalityAttr, // rework-loop attempt index; bounded 0-3 cardinality — distinct from GIT_ATTEMPT
  // §7.3.15 transcript visibility (#313-B) — bounded consumer/result/source enums
  TRANSCRIPT_CONSUMER:    "consumer"                     as LowCardinalityAttr,
  TRANSCRIPT_RESULT:      "result"                       as LowCardinalityAttr,
  COST_SOURCE:            "source"                       as LowCardinalityAttr,
  // §7.3.16 per-turn/per-tool child spans (#355) — bounded tool-name set, single-value source
  BUREAU_TOOL_NAME:       "bureau.tool.name"             as LowCardinalityAttr,
  TOOL_SOURCE:            "bureau.tool.source"           as LowCardinalityAttr,
} as const;

/**
 * High-cardinality attribute keys — span attributes only, NOT metric labels (§7.8).
 * Metric-emission functions reject these at compile time.
 */
export const ATTR_HIGH: Record<string, HighCardinalityAttr> = {
  PARENT_GRAPH_ID:   "bureau.parent.graph.id"   as HighCardinalityAttr,
  GRAPH_ID:          "bureau.graph.id"          as HighCardinalityAttr,
  TASK_ID:           "bureau.task.id"           as HighCardinalityAttr,
  SESSION_ID:        "bureau.session.id"        as HighCardinalityAttr,
  AGENT_PREFIX_HASH: "bureau.agent.prefix_hash" as HighCardinalityAttr,
  YIELD_REASON:      "bureau.yield.reason"      as HighCardinalityAttr,
  WORKER_IMAGE:      "bureau.worker.image"      as HighCardinalityAttr,
  // §7.3.16 per-turn/per-tool child spans (#355) — unbounded per-run counters
  TURN_INDEX:        "bureau.turn.index"        as HighCardinalityAttr,
  TOOL_CALL_INDEX:   "bureau.tool.call_index"   as HighCardinalityAttr,
} as const;

/**
 * Resource attributes — set once at init, not subject to cardinality discipline (§7.4).
 */
export const RESOURCE_ATTR: Record<string, string> = {
  SERVICE_NAME:        "service.name",
  SERVICE_VERSION:     "service.version",
  SERVICE_VERSION_COMMIT: "service.version.commit",
  SERVICE_INSTANCE_ID: "service.instance.id",
  DEPLOYMENT_ENV:      "deployment.environment",
  HOST_NAME:           "host.name",
  PROCESS_PID:         "process.pid",
  RUNTIME_NAME:        "process.runtime.name",
  RUNTIME_VERSION:     "process.runtime.version",
  K8S_POD_NAME:        "k8s.pod.name",
} as const;
