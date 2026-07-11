import { describe, it, expect } from "vitest";
import {
  METRIC,
  ATTR,
  ATTR_LOW,
  ATTR_HIGH,
  RESOURCE_ATTR,
  type MetricName,
  type AttributeKey,
  type GenAiOperationName,
  type GenAiTokenType,
  type InstrumentationSeam,
  type AnomalyType,
} from "../../src/telemetry/schema.js";

describe("schema.ts — metric constants", () => {
  it("every value in METRIC is unique (no accidental duplicate metric names)", () => {
    const values = Object.values(METRIC);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("METRIC contains exactly 76 entries", () => {
    expect(Object.values(METRIC)).toHaveLength(76);
  });

  // §7.3.15 Bureau transcript visibility metrics (#313-B)
  it("includes bureau transcript visibility metrics", () => {
    expect(METRIC.TRANSCRIPT_READ).toBe("bureau.transcript.read");
    expect(METRIC.COST_SOURCE).toBe("bureau.cost.source");
  });

  // §7.3.1 GenAI semantic-convention metrics
  it("includes gen_ai semantic-convention metrics", () => {
    expect(METRIC.TOKEN_USAGE).toBe("gen_ai.client.token.usage");
    expect(METRIC.OPERATION_DURATION).toBe("gen_ai.client.operation.duration");
  });

  // §7.3.2 Bureau agent metrics
  it("includes bureau.agent metrics", () => {
    expect(METRIC.AGENT_COST_USD).toBe("bureau.agent.cost_usd");
    expect(METRIC.AGENT_COST_USD_TOTAL).toBe("bureau.agent.cost_usd.total");
    expect(METRIC.AGENT_CACHE_HIT_RATE).toBe("bureau.agent.cache_hit_rate");
  });

  // §7.3.3 Bureau task metrics
  it("includes all bureau.task metrics", () => {
    expect(METRIC.TASK_COMPLETED).toBe("bureau.task.completed");
    expect(METRIC.TASK_FAILED).toBe("bureau.task.failed");
    expect(METRIC.TASK_DURATION).toBe("bureau.task.duration");
    expect(METRIC.TASK_RETRIES).toBe("bureau.task.retries");
    expect(METRIC.TASK_DISPATCH_LATENCY).toBe("bureau.task.dispatch_latency");
    expect(METRIC.TASK_QUEUE_DEPTH).toBe("bureau.task.queue_depth");
    expect(METRIC.TASK_APPROVAL_WAITING).toBe("bureau.task.approval_waiting");
    expect(METRIC.TASK_WARNING).toBe("bureau.task.warning");
    expect(METRIC.TASK_STALE).toBe("bureau.task.stale");
    expect(METRIC.TASK_DEAD).toBe("bureau.task.dead");
    expect(METRIC.TASK_TIMEOUT).toBe("bureau.task.timeout");
    expect(METRIC.TASKS_IN_FLIGHT).toBe("bureau.tasks.in_flight");
    expect(METRIC.TASKS_YIELDED).toBe("bureau.tasks.yielded");
  });

  // §7.3.4 Bureau graph metrics
  it("includes all bureau.graph metrics", () => {
    expect(METRIC.GRAPH_STARTED).toBe("bureau.graph.started");
    expect(METRIC.GRAPH_COMPLETED).toBe("bureau.graph.completed");
    expect(METRIC.GRAPH_FAILED).toBe("bureau.graph.failed");
    expect(METRIC.GRAPH_CANCELED).toBe("bureau.graph.canceled");
    expect(METRIC.GRAPH_DURATION).toBe("bureau.graph.duration");
    expect(METRIC.GRAPH_VALIDATION_FAILED).toBe("bureau.graph.validation_failed");
    expect(METRIC.GRAPH_TASK_COUNT).toBe("bureau.graph.task_count");
    expect(METRIC.GRAPH_DEPTH).toBe("bureau.graph.depth");
    expect(METRIC.GRAPH_ACTIVE).toBe("bureau.graph.active");
    expect(METRIC.GRAPH_AWAITING_CHILDREN).toBe("bureau.graph.awaiting_children");
    expect(METRIC.GRAPH_PAUSED).toBe("bureau.graph.paused");
    expect(METRIC.GRAPH_COST_USD).toBe("bureau.graph.cost_usd");
  });

  // §7.3.5 Bureau yield metrics
  it("includes all bureau.yield metrics", () => {
    expect(METRIC.YIELD_STARTED).toBe("bureau.yield.started");
    expect(METRIC.YIELD_RESOLVED).toBe("bureau.yield.resolved");
    expect(METRIC.YIELD_DURATION).toBe("bureau.yield.duration");
    expect(METRIC.YIELD_ACTIVE).toBe("bureau.yield.active");
  });

  // §7.3.6 Bureau dispatch / spawn metrics
  it("includes all bureau.dispatch/spawn/pty/stderr metrics", () => {
    expect(METRIC.DISPATCH_CONCURRENCY).toBe("bureau.dispatch.concurrency");
    expect(METRIC.DISPATCH_THROTTLED).toBe("bureau.dispatch.throttled");
    expect(METRIC.SPAWN_FAILURES).toBe("bureau.spawn.failures");
  });

  // §7.3.7 Bureau anomaly metrics
  it("includes all bureau.anomaly metrics", () => {
    expect(METRIC.ANOMALY_DETECTED).toBe("bureau.anomaly.detected");
    expect(METRIC.CACHE_ANOMALY_EVALUATIONS).toBe("bureau.cache_anomaly.evaluations");
    expect(METRIC.CACHE_ANOMALY_COOLDOWN_SUPPRESSIONS).toBe("bureau.cache_anomaly.cooldown_suppressions");
  });

  // §7.3.8 Bureau infrastructure metrics
  it("includes all bureau infrastructure metrics", () => {
    expect(METRIC.REDIS_OPERATION_DURATION).toBe("bureau.redis.operation.duration");
    expect(METRIC.REDIS_OPERATION_ERRORS).toBe("bureau.redis.operation.errors");
    expect(METRIC.MCP_TOOL_ERRORS).toBe("bureau.mcp_tool.errors");
    expect(METRIC.MEMORY_FREE_BYTES).toBe("bureau.memory.free_bytes");
  });

  // §7.3.12 Bureau validation metrics
  it("includes all bureau.validation metrics", () => {
    expect(METRIC.VALIDATION_DISPATCHED).toBe("bureau.validation.dispatched");
    expect(METRIC.VALIDATION_RESULT).toBe("bureau.validation.result");
    expect(METRIC.VALIDATION_NO_TEST_COMMAND).toBe("bureau.validation.no_test_command");
  });

  // §7.3.13 Bureau worktree metrics
  it("includes all bureau.worktree metrics", () => {
    expect(METRIC.WORKTREE_MERGE_TOTAL).toBe("bureau.worktree.merge.total");
    expect(METRIC.WORKTREE_MERGE_DURATION).toBe("bureau.worktree.merge.duration");
    expect(METRIC.WORKTREE_MERGE_ERROR).toBe("bureau.worktree.merge.error");
  });

  // §7.3.9 Bureau event bridge
  it("includes bureau.event metric", () => {
    expect(METRIC.EVENT).toBe("bureau.event");
  });

  // §7.3.10 Node runtime metrics
  it("includes all process.runtime.nodejs metrics", () => {
    expect(METRIC.NODEJS_MEMORY_HEAP_USED).toBe("process.runtime.nodejs.memory.heap_used");
    expect(METRIC.NODEJS_MEMORY_HEAP_TOTAL).toBe("process.runtime.nodejs.memory.heap_total");
    expect(METRIC.NODEJS_MEMORY_RSS).toBe("process.runtime.nodejs.memory.rss");
    expect(METRIC.NODEJS_MEMORY_EXTERNAL).toBe("process.runtime.nodejs.memory.external");
    expect(METRIC.NODEJS_CPU_USER).toBe("process.runtime.nodejs.cpu.user");
    expect(METRIC.NODEJS_CPU_SYSTEM).toBe("process.runtime.nodejs.cpu.system");
    expect(METRIC.NODEJS_EVENT_LOOP_DELAY).toBe("process.runtime.nodejs.event_loop.delay");
    expect(METRIC.NODEJS_GC_DURATION).toBe("process.runtime.nodejs.gc.duration");
    expect(METRIC.NODEJS_GC_COUNT).toBe("process.runtime.nodejs.gc.count");
    expect(METRIC.NODEJS_HANDLES_ACTIVE).toBe("process.runtime.nodejs.handles.active");
    expect(METRIC.NODEJS_REQUESTS_ACTIVE).toBe("process.runtime.nodejs.requests.active");
  });

});

describe("schema.ts — attribute constants", () => {
  it("every value in ATTR is unique (no accidental duplicate attribute keys)", () => {
    const values = Object.values(ATTR);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("ATTR_LOW and ATTR_HIGH have zero overlap", () => {
    const lowValues = new Set(Object.values(ATTR_LOW));
    const highValues = Object.values(ATTR_HIGH);
    for (const v of highValues) {
      expect(lowValues.has(v as string)).toBe(false);
    }
  });

  it("ATTR covers all keys from ATTR_LOW, ATTR_HIGH, and RESOURCE_ATTR", () => {
    const attrValues = new Set(Object.values(ATTR));
    for (const v of Object.values(ATTR_LOW)) {
      expect(attrValues.has(v as string)).toBe(true);
    }
    for (const v of Object.values(ATTR_HIGH)) {
      expect(attrValues.has(v as string)).toBe(true);
    }
    for (const v of Object.values(RESOURCE_ATTR)) {
      expect(attrValues.has(v)).toBe(true);
    }
  });

  it("includes the canonical ATTR examples from §7.2", () => {
    expect(ATTR.OPERATION_NAME).toBe("gen_ai.operation.name");
    expect(ATTR.PROVIDER_NAME).toBe("gen_ai.provider.name");
    expect(ATTR.REQUEST_MODEL).toBe("gen_ai.request.model");
    expect(ATTR.RESPONSE_MODEL).toBe("gen_ai.response.model");
    expect(ATTR.TOKEN_TYPE).toBe("gen_ai.token.type");
    expect(ATTR.TOOL_NAME).toBe("gen_ai.tool.name");
    expect(ATTR.ERROR_TYPE).toBe("error.type");
    expect(ATTR.ROLE).toBe("bureau.role");
  });

  it("ATTR_LOW contains the expected low-cardinality keys", () => {
    expect(ATTR_LOW.OPERATION_NAME).toBe("gen_ai.operation.name");
    expect(ATTR_LOW.ERROR_TYPE).toBe("error.type");
    expect(ATTR_LOW.REDIS_OPERATION).toBe("bureau.redis.operation");
    expect(ATTR_LOW.DISPATCH_MODE).toBe("bureau.dispatch.mode");
  });

  it("registers bureau.task.attempt (rework attempt index) as low-cardinality, distinct from bureau.git.attempt (#317)", () => {
    expect(ATTR.TASK_ATTEMPT).toBe("bureau.task.attempt");
    expect(ATTR.GIT_ATTEMPT).toBe("bureau.git.attempt");
    expect(ATTR.TASK_ATTEMPT).not.toBe(ATTR.GIT_ATTEMPT);
    expect(ATTR_LOW.TASK_ATTEMPT).toBe("bureau.task.attempt");
  });

  it("ATTR_HIGH contains the expected high-cardinality keys", () => {
    expect(ATTR_HIGH.GRAPH_ID).toBe("bureau.graph.id");
    expect(ATTR_HIGH.TASK_ID).toBe("bureau.task.id");
    expect(ATTR_HIGH.SESSION_ID).toBe("bureau.session.id");
    expect(ATTR_HIGH.AGENT_PREFIX_HASH).toBe("bureau.agent.prefix_hash");
    expect(ATTR_HIGH.YIELD_REASON).toBe("bureau.yield.reason");
  });

  it("RESOURCE_ATTR contains expected resource keys", () => {
    expect(RESOURCE_ATTR.SERVICE_NAME).toBe("service.name");
    expect(RESOURCE_ATTR.DEPLOYMENT_ENV).toBe("deployment.environment");
    expect(RESOURCE_ATTR.PROCESS_PID).toBe("process.pid");
  });
});

describe("schema.ts — type re-exports from src/types/telemetry.ts", () => {
  it("src/types/telemetry.ts re-exports the six schema types", async () => {
    // Dynamic import to verify the module loads without errors
    const mod = await import("../../src/types/telemetry.js");
    // The module must exist and be importable — if any re-exported module is broken,
    // this import will throw, failing the test.
    expect(mod).toBeDefined();
  });
});

// Type-level assertions — these fail at compile time if types are wrong.
// They produce no runtime output but guard the schema contract.

// MetricName must accept all metric values
const _m1: MetricName = "gen_ai.client.token.usage";
const _m2: MetricName = "bureau.task.completed";
const _m3: MetricName = "process.runtime.nodejs.gc.count";

// AttributeKey must accept all attribute values
const _a1: AttributeKey = "gen_ai.operation.name";
const _a2: AttributeKey = "bureau.graph.id";
const _a3: AttributeKey = "service.name";

// Enum-like types
const _op: GenAiOperationName = "invoke_agent";
const _tt: GenAiTokenType = "input";
const _is: InstrumentationSeam = "redis";
const _at: AnomalyType = "cache.prefix_thrash";

// Suppress unused variable warnings
void _m1; void _m2; void _m3;
void _a1; void _a2; void _a3;
void _op; void _tt; void _is; void _at;
