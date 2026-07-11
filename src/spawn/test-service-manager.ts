import { v4 as uuidv4 } from "uuid";
import type { K8sApi } from "./k8s-api.js";
import type { RedisClient } from "../redis.js";
import type { TestServiceType, TestServiceAllocation } from "../types/test-service.js";
import type { TaskEvent } from "../types/event.js";
import { logger } from "../logger.js";

export interface StartServiceParams {
  graphId: string;
  taskId: string;
  serviceType: TestServiceType;
  leaseTtlSeconds: number;
  image?: string;
}

const SERVICE_DEFAULTS: Record<TestServiceType, { port: number; image: string; resources: unknown; env: Array<{ name: string; value: string }> }> = {
  redis: {
    port: 6379,
    image: "redis:7",
    resources: {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { cpu: "500m", memory: "256Mi" },
    },
    env: [],
  },
  postgres: {
    port: 5432,
    image: "postgres:16",
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "512Mi" },
    },
    // The official postgres image (and pgvector/pgvector, same entrypoint) refuses to
    // boot without a superuser password. These must match buildConnectionString():
    // postgres://postgres:postgres@host:5432/postgres.
    env: [
      { name: "POSTGRES_PASSWORD", value: "postgres" },
      { name: "POSTGRES_USER", value: "postgres" },
      { name: "POSTGRES_DB", value: "postgres" },
    ],
  },
};

function buildConnectionString(type: TestServiceType, host: string, port: number): string {
  if (type === "redis") return `redis://${host}:${port}`;
  if (type === "postgres") return `postgres://postgres:postgres@${host}:${port}/postgres`;
  throw new Error(`Unknown service type: ${type}`);
}

function makeServiceId(type: TestServiceType): string {
  return `${type}-${uuidv4().slice(0, 8)}`;
}

function podName(serviceId: string): string {
  return `bureau-ts-${serviceId}`;
}

function serviceName(serviceId: string): string {
  return `bts-${serviceId}`;
}

export class TestServiceManager {
  private sweepInterval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly api: K8sApi,
    private readonly redis: RedisClient,
    private readonly namespace: string,
    private readonly emitEvent?: (event: TaskEvent) => Promise<void>,
  ) {}

  private async _emit(event: TaskEvent): Promise<void> {
    await this.emitEvent?.(event).catch(err => {
      logger.warn({ err: String(err), eventType: event.type }, "test service event emit failed");
    });
  }

  private async _deleteResources(alloc: { serviceId: string; graphId: string; taskId: string }): Promise<void> {
    await this.api.deletePod(this.namespace, podName(alloc.serviceId)).catch(e => {
      logger.warn({ serviceId: alloc.serviceId, err: String(e) }, "test service Pod delete failed (best effort)");
    });
    await this.api.deleteService(this.namespace, serviceName(alloc.serviceId)).catch(e => {
      logger.warn({ serviceId: alloc.serviceId, err: String(e) }, "test service Service delete failed (best effort)");
    });
    await this.redis.del(`bureau:ts:${alloc.serviceId}`);
    await this.redis.srem(`bureau:ts:graph:${alloc.graphId}`, alloc.serviceId);
    await this.redis.srem(`bureau:ts:task:${alloc.taskId}`, alloc.serviceId);
  }

  startSweep(intervalMs = 30_000): void {
    this.sweepInterval = setInterval(() => { void this.sweepExpiredLeases(); }, intervalMs);
    (this.sweepInterval as unknown as { unref?: () => void }).unref?.();
  }

  stopSweep(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = undefined;
    }
  }

  async startService(params: StartServiceParams): Promise<TestServiceAllocation> {
    const { graphId, taskId, serviceType, leaseTtlSeconds, image } = params;
    const defaults = SERVICE_DEFAULTS[serviceType];
    const resolvedImage = image ?? defaults.image;
    const serviceId = makeServiceId(serviceType);
    const svcName = serviceName(serviceId);
    const host = `${svcName}.${this.namespace}.svc.cluster.local`;
    const leaseExpiresAt = Date.now() + leaseTtlSeconds * 1000;

    const alloc: TestServiceAllocation = {
      serviceId,
      serviceType,
      graphId,
      taskId,
      host,
      port: defaults.port,
      connectionString: buildConnectionString(serviceType, host, defaults.port),
      leaseExpiresAt,
      status: "starting",
      image: resolvedImage,
    };

    // Create k8s Pod
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName(serviceId),
        namespace: this.namespace,
        labels: {
          app: "bureau-test-service",
          "bureau/ts-id": serviceId,
          "bureau/ts-type": serviceType,
          "bureau/graph": graphId.slice(0, 63).replace(/[^a-z0-9-]/g, "-"),
        },
      },
      spec: {
        restartPolicy: "Never",
        containers: [{
          name: "service",
          image: resolvedImage,
          resources: defaults.resources,
          ...(defaults.env.length > 0 && { env: defaults.env }),
        }],
      },
    };

    // Create k8s ClusterIP Service
    const svc = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: svcName, namespace: this.namespace },
      spec: {
        type: "ClusterIP",
        selector: { "bureau/ts-id": serviceId },
        ports: [{ port: defaults.port, targetPort: defaults.port }],
      },
    };

    await this.api.createPod(this.namespace, pod);
    await this.api.createService(this.namespace, svc);

    // Persist to Redis
    await this.redis.hset(`bureau:ts:${serviceId}`, {
      serviceId,
      serviceType,
      graphId,
      taskId,
      host,
      port: defaults.port.toString(),
      connectionString: alloc.connectionString,
      leaseExpiresAt: leaseExpiresAt.toString(),
      status: "starting",
      image: resolvedImage,
    });
    await this.redis.sadd(`bureau:ts:graph:${graphId}`, serviceId);
    await this.redis.sadd(`bureau:ts:task:${taskId}`, serviceId);

    logger.info({ serviceId, serviceType, graphId, taskId, namespace: this.namespace }, "test service started");

    await this._emit({
      type: "test_service_started",
      graphId,
      taskId,
      serviceId: alloc.serviceId,
      serviceType: alloc.serviceType,
      imageRef: alloc.image,
      timestamp: Date.now(),
    });

    return alloc;
  }

  async get(serviceId: string): Promise<TestServiceAllocation | null> {
    const data = await this.redis.hgetall(`bureau:ts:${serviceId}`);
    if (!data?.serviceId) return null;
    const alloc: TestServiceAllocation = {
      serviceId: data.serviceId,
      serviceType: data.serviceType as TestServiceType,
      graphId: data.graphId,
      taskId: data.taskId,
      host: data.host,
      port: Number(data.port),
      connectionString: data.connectionString,
      leaseExpiresAt: Number(data.leaseExpiresAt),
      status: data.status as TestServiceAllocation["status"],
      image: data.image,
    };
    // Lazily advance "starting" → "ready" once the Pod is Running
    if (alloc.status === "starting") {
      const phase = await this.api.readPodPhase(this.namespace, podName(alloc.serviceId));
      if (phase === "Running") {
        alloc.status = "ready";
        await this.redis.hset(`bureau:ts:${alloc.serviceId}`, { status: "ready" });
      }
    }
    return alloc;
  }

  async extendLease(serviceId: string, leaseTtlSeconds: number): Promise<number> {
    const data = await this.redis.hgetall(`bureau:ts:${serviceId}`);
    if (!data?.serviceId || data.status === "stopped" || data.status === "expired") return 0;
    // Never shorten: a smaller extend (e.g. the heartbeat's +60s, or a racing caller)
    // must not claw back a longer lease already granted (#233).
    const candidate = Date.now() + leaseTtlSeconds * 1000;
    const expiresAt = Math.max(Number(data.leaseExpiresAt) || 0, candidate);
    await this.redis.hset(`bureau:ts:${serviceId}`, { leaseExpiresAt: expiresAt.toString() });
    return expiresAt;
  }

  /** Renew every active lease for a graph (best-effort, never-shortening). Called by the
   *  engine health sweep for each supervised ACTIVE graph so a live worker's test service
   *  never expires under it — the lease becomes a dead-graph safety net, not a wall-clock
   *  timer the agent must remember to pet (#233). Returns the count renewed. */
  async extendLeasesForGraph(graphId: string, leaseTtlSeconds: number): Promise<number> {
    const services = await this.listForGraph(graphId);
    let extended = 0;
    for (const s of services) {
      if (s.status === "stopped" || s.status === "expired") continue;
      const r = await this.extendLease(s.serviceId, leaseTtlSeconds);
      if (r > 0) extended++;
    }
    return extended;
  }

  async stopService(serviceId: string): Promise<void> {
    const alloc = await this.get(serviceId);
    if (!alloc) return;

    await this.redis.hset(`bureau:ts:${serviceId}`, { status: "stopped" });
    await this._emit({
      type: "test_service_stopped",
      graphId: alloc.graphId,
      taskId: alloc.taskId,
      serviceId: alloc.serviceId,
      serviceType: alloc.serviceType,
      imageRef: alloc.image,
      timestamp: Date.now(),
    });

    await this._deleteResources(alloc);
    logger.info({ serviceId, graphId: alloc.graphId }, "test service stopped");
  }

  async stopAllForGraph(graphId: string): Promise<void> {
    const ids = await this.redis.smembers(`bureau:ts:graph:${graphId}`);
    await Promise.all(ids.map(id => this.stopService(id)));
    await this.redis.del(`bureau:ts:graph:${graphId}`);
  }

  async listForGraph(graphId: string): Promise<TestServiceAllocation[]> {
    const ids = await this.redis.smembers(`bureau:ts:graph:${graphId}`);
    const results = await Promise.all(ids.map(id => this.get(id)));
    return results.filter((a): a is TestServiceAllocation => a !== null);
  }

  async listForTask(taskId: string): Promise<TestServiceAllocation[]> {
    const ids = await this.redis.smembers(`bureau:ts:task:${taskId}`);
    const results = await Promise.all(ids.map(id => this.get(id)));
    return results.filter((a): a is TestServiceAllocation => a !== null);
  }

  async sweepExpiredLeases(): Promise<void> {
    const now = Date.now();
    const keys = await this.redis.keys("bureau:ts:*");
    // Only hash keys (not set keys which start with bureau:ts:graph: or bureau:ts:task:)
    const hashKeys = keys.filter(k => {
      const rest = k.slice("bureau:ts:".length);
      return !rest.startsWith("graph:") && !rest.startsWith("task:");
    });
    for (const key of hashKeys) {
      const data = await this.redis.hgetall(key);
      if (!data?.serviceId) continue;
      if (Number(data.leaseExpiresAt) < now) {
        const { serviceId, graphId, taskId, serviceType, image } = data;
        logger.info({ serviceId }, "test service lease expired — stopping");
        await this.redis.hset(key, { status: "expired" });
        await this._emit({
          type: "test_service_expired",
          graphId,
          taskId,
          serviceId,
          serviceType,
          imageRef: image,
          timestamp: now,
        });
        await this._deleteResources({ serviceId, graphId, taskId });
      }
    }
  }

  /** Emit an image_not_approved graph event. Call from the tool handler when the
   *  allowlist check rejects an image before startService is reached. */
  async emitImageNotApproved(graphId: string, taskId: string, serviceType: string, imageRef: string): Promise<void> {
    await this._emit({
      type: "image_not_approved",
      graphId,
      taskId,
      serviceType,
      imageRef,
      timestamp: Date.now(),
    });
  }
}
