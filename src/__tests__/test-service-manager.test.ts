import { describe, it, expect, beforeEach, vi } from "vitest";
import { TestServiceManager } from "../spawn/test-service-manager.js";
import type { K8sApi } from "../spawn/k8s-api.js";
import type { RedisClient } from "../redis.js";
import type { TaskEvent } from "../types/event.js";

function makeMockApi(): K8sApi & { _pods: string[]; _services: string[]; _podManifests: any[] } {
  const _pods: string[] = [];
  const _services: string[] = [];
  const _podManifests: any[] = [];
  return {
    _pods,
    _services,
    _podManifests,
    createJob: vi.fn(),
    readJobStatus: vi.fn(),
    deleteJob: vi.fn(),
    createSecret: vi.fn(),
    deleteSecret: vi.fn(),
    createPod: vi.fn(async (_ns: string, manifest: any) => { _pods.push(manifest.metadata.name); _podManifests.push(manifest); }),
    readPodPhase: vi.fn(async () => "Running"),
    deletePod: vi.fn(async (_ns: string, name: string) => { const i = _pods.indexOf(name); if (i >= 0) _pods.splice(i, 1); }),
    createService: vi.fn(async (_ns: string, manifest: any) => { _services.push(manifest.metadata.name); }),
    deleteService: vi.fn(async (_ns: string, name: string) => { const i = _services.indexOf(name); if (i >= 0) _services.splice(i, 1); }),
  } as unknown as K8sApi & { _pods: string[]; _services: string[]; _podManifests: any[] };
}

function makeMockRedis(): RedisClient {
  const store = new Map<string, any>();
  const sets = new Map<string, Set<string>>();
  return {
    hset: vi.fn(async (key: string, data: Record<string, string>) => {
      store.set(key, { ...(store.get(key) ?? {}), ...data });
      return Object.keys(data).length;
    }),
    hgetall: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => { keys.forEach(k => { store.delete(k); sets.delete(k); }); return keys.length; }),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      members.forEach(m => sets.get(key)!.add(m));
      return members.length;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const s = sets.get(key);
      if (!s) return 0;
      members.forEach(m => s.delete(m));
      return members.length;
    }),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    keys: vi.fn(async (pattern: string) => {
      const prefix = pattern.replace("*", "");
      return [...store.keys()].filter(k => k.startsWith(prefix));
    }),
  } as unknown as RedisClient;
}

describe("TestServiceManager", () => {
  let api: ReturnType<typeof makeMockApi>;
  let redis: ReturnType<typeof makeMockRedis>;
  let emittedEvents: TaskEvent[];
  let emitEvent: (event: TaskEvent) => Promise<void>;
  let manager: TestServiceManager;

  beforeEach(() => {
    api = makeMockApi();
    redis = makeMockRedis();
    emittedEvents = [];
    emitEvent = vi.fn(async (e: TaskEvent) => { emittedEvents.push(e); });
    manager = new TestServiceManager(api, redis, "bureau", emitEvent);
  });

  it("startService creates a Pod and a Service and returns an allocation with status starting", async () => {
    const alloc = await manager.startService({
      graphId: "graph-1",
      taskId: "task-1",
      serviceType: "redis",
      leaseTtlSeconds: 60,
    });

    expect(alloc.serviceType).toBe("redis");
    expect(alloc.port).toBe(6379);
    expect(alloc.connectionString).toContain("redis://");
    expect(alloc.status).toBe("starting");
    expect(api.createPod).toHaveBeenCalledOnce();
    expect(api.createService).toHaveBeenCalledOnce();
    expect(alloc.leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  it("startService returns postgres connection string for postgres type", async () => {
    const alloc = await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "postgres",
      leaseTtlSeconds: 60,
    });
    expect(alloc.port).toBe(5432);
    expect(alloc.connectionString).toContain("postgres://");
  });

  it("postgres pod is given auth env matching the hardcoded connection string", async () => {
    // The official postgres image refuses to start without POSTGRES_PASSWORD (or
    // POSTGRES_HOST_AUTH_METHOD=trust), and the connection string is
    // postgres://postgres:postgres@host:5432/postgres — so the pod's superuser
    // credentials and default db must match user=postgres / password=postgres / db=postgres.
    const alloc = await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "postgres",
      leaseTtlSeconds: 60,
    });

    const manifest = api._podManifests.find(m => m.metadata.name.includes(alloc.serviceId));
    expect(manifest).toBeDefined();
    const env: Array<{ name: string; value: string }> = manifest.spec.containers[0].env ?? [];
    const envMap = Object.fromEntries(env.map(e => [e.name, e.value]));
    expect(envMap.POSTGRES_PASSWORD).toBe("postgres");
    expect(envMap.POSTGRES_USER).toBe("postgres");
    expect(envMap.POSTGRES_DB).toBe("postgres");
  });

  it("redis pod is created without postgres auth env", async () => {
    const alloc = await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "redis",
      leaseTtlSeconds: 60,
    });
    const manifest = api._podManifests.find(m => m.metadata.name.includes(alloc.serviceId));
    const env: Array<{ name: string; value: string }> = manifest.spec.containers[0].env ?? [];
    expect(env.find(e => e.name === "POSTGRES_PASSWORD")).toBeUndefined();
  });

  it("startService emits test_service_started event", async () => {
    const alloc = await manager.startService({
      graphId: "graph-1",
      taskId: "task-1",
      serviceType: "redis",
      leaseTtlSeconds: 60,
    });

    const started = emittedEvents.find(e => e.type === "test_service_started");
    expect(started).toBeDefined();
    expect(started?.graphId).toBe("graph-1");
    expect(started?.taskId).toBe("task-1");
    expect(started?.serviceId).toBe(alloc.serviceId);
    expect(started?.serviceType).toBe("redis");
    expect(started?.imageRef).toBe("redis:7");
  });

  it("get transitions status from starting to ready when pod is Running", async () => {
    vi.mocked(api.readPodPhase).mockResolvedValue("Running");
    const alloc = await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "redis",
      leaseTtlSeconds: 60,
    });

    const fetched = await manager.get(alloc.serviceId);
    expect(fetched?.status).toBe("ready");
    // Status persisted to Redis
    expect(redis.hset).toHaveBeenCalledWith(
      `bureau:ts:${alloc.serviceId}`,
      { status: "ready" },
    );
  });

  it("get keeps status starting when pod is not yet Running", async () => {
    vi.mocked(api.readPodPhase).mockResolvedValue("Pending");
    const alloc = await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "redis",
      leaseTtlSeconds: 60,
    });

    const fetched = await manager.get(alloc.serviceId);
    expect(fetched?.status).toBe("starting");
  });

  it("extendLease updates leaseExpiresAt", async () => {
    const alloc = await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "redis",
      leaseTtlSeconds: 60,
    });
    // Pod is not Running so status stays "starting" — extendLease should still work
    vi.mocked(api.readPodPhase).mockResolvedValue("Pending");
    const newExpiry = await manager.extendLease(alloc.serviceId, 120);
    expect(newExpiry).toBeGreaterThan(alloc.leaseExpiresAt);
  });

  it("extendLease never shortens an already-longer lease (#233)", async () => {
    const alloc = await manager.startService({
      graphId: "g", taskId: "t", serviceType: "redis", leaseTtlSeconds: 60,
    });
    const long = await manager.extendLease(alloc.serviceId, 1800); // ~30 min out
    const short = await manager.extendLease(alloc.serviceId, 30);  // would shorten — must be ignored
    expect(short).toBe(long);
    expect((await manager.get(alloc.serviceId))!.leaseExpiresAt).toBe(long);
  });

  it("extendLeasesForGraph renews every active service in the graph (#233)", async () => {
    const a = await manager.startService({ graphId: "g1", taskId: "t1", serviceType: "redis", leaseTtlSeconds: 60 });
    const b = await manager.startService({ graphId: "g1", taskId: "t2", serviceType: "postgres", leaseTtlSeconds: 60 });
    await manager.startService({ graphId: "g2", taskId: "t3", serviceType: "redis", leaseTtlSeconds: 60 });
    const beforeA = (await manager.get(a.serviceId))!.leaseExpiresAt;
    const beforeB = (await manager.get(b.serviceId))!.leaseExpiresAt;
    const count = await manager.extendLeasesForGraph("g1", 1800);
    expect(count).toBe(2);
    expect((await manager.get(a.serviceId))!.leaseExpiresAt).toBeGreaterThan(beforeA);
    expect((await manager.get(b.serviceId))!.leaseExpiresAt).toBeGreaterThan(beforeB);
  });

  it("extendLease returns 0 for stopped service", async () => {
    const alloc = await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "redis",
      leaseTtlSeconds: 60,
    });
    await manager.stopService(alloc.serviceId);
    // After stop the hash is deleted, so extendLease should return 0
    const result = await manager.extendLease(alloc.serviceId, 120);
    expect(result).toBe(0);
  });

  it("stopService persists stopped status before deletion and emits test_service_stopped", async () => {
    vi.mocked(api.readPodPhase).mockResolvedValue("Pending");
    const alloc = await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "redis",
      leaseTtlSeconds: 60,
    });

    await manager.stopService(alloc.serviceId);

    // "stopped" status must be written to Redis (hset called with status "stopped")
    const hsetMock = vi.mocked(redis.hset);
    const stoppedCall = hsetMock.mock.calls.find(
      (args: any[]) => args[1] && typeof args[1] === "object" && (args[1] as Record<string, string>).status === "stopped",
    );
    expect(stoppedCall).toBeDefined();

    // k8s resources deleted
    expect(api.deletePod).toHaveBeenCalledOnce();
    expect(api.deleteService).toHaveBeenCalledOnce();

    // Event emitted
    const stopped = emittedEvents.find(e => e.type === "test_service_stopped");
    expect(stopped).toBeDefined();
    expect(stopped?.graphId).toBe("g");
    expect(stopped?.serviceId).toBe(alloc.serviceId);
    expect(stopped?.serviceType).toBe("redis");
    expect(stopped?.imageRef).toBe("redis:7");
  });

  it("stopAllForGraph stops all services in that graph", async () => {
    vi.mocked(api.readPodPhase).mockResolvedValue("Pending");
    await manager.startService({ graphId: "g1", taskId: "t1", serviceType: "redis", leaseTtlSeconds: 60 });
    await manager.startService({ graphId: "g1", taskId: "t2", serviceType: "postgres", leaseTtlSeconds: 60 });
    await manager.startService({ graphId: "g2", taskId: "t3", serviceType: "redis", leaseTtlSeconds: 60 });
    await manager.stopAllForGraph("g1");
    expect(api.deletePod).toHaveBeenCalledTimes(2);
    expect(api.deleteService).toHaveBeenCalledTimes(2);
  });

  it("listForGraph returns allocations for the graph", async () => {
    await manager.startService({ graphId: "g1", taskId: "t1", serviceType: "redis", leaseTtlSeconds: 60 });
    const list = await manager.listForGraph("g1");
    expect(list).toHaveLength(1);
    expect(list[0].graphId).toBe("g1");
  });

  it("listForTask returns allocations for the task", async () => {
    await manager.startService({ graphId: "g1", taskId: "my-task", serviceType: "redis", leaseTtlSeconds: 60 });
    const list = await manager.listForTask("my-task");
    expect(list).toHaveLength(1);
    expect(list[0].taskId).toBe("my-task");
  });

  it("sweepExpiredLeases sets status to expired, emits test_service_expired, and cleans up", async () => {
    vi.mocked(api.readPodPhase).mockResolvedValue("Pending");
    const alloc = await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "redis",
      leaseTtlSeconds: -1, // already expired
    });

    await manager.sweepExpiredLeases();

    // Expired event emitted
    const expired = emittedEvents.find(e => e.type === "test_service_expired");
    expect(expired).toBeDefined();
    expect(expired?.graphId).toBe("g");
    expect(expired?.serviceId).toBe(alloc.serviceId);
    expect(expired?.serviceType).toBe("redis");
    expect(expired?.imageRef).toBe("redis:7");

    // k8s resources deleted
    expect(api.deletePod).toHaveBeenCalledOnce();
    expect(api.deleteService).toHaveBeenCalledOnce();

    // Service no longer in Redis
    const afterSweep = await manager.get(alloc.serviceId);
    expect(afterSweep).toBeNull();
  });

  it("sweepExpiredLeases does not emit stopped for expired services", async () => {
    vi.mocked(api.readPodPhase).mockResolvedValue("Pending");
    await manager.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "redis",
      leaseTtlSeconds: -1,
    });

    await manager.sweepExpiredLeases();

    expect(emittedEvents.some(e => e.type === "test_service_stopped")).toBe(false);
    expect(emittedEvents.some(e => e.type === "test_service_expired")).toBe(true);
  });

  it("emitImageNotApproved emits image_not_approved event", async () => {
    await manager.emitImageNotApproved("graph-1", "task-1", "redis", "redis:untrusted");

    const event = emittedEvents.find(e => e.type === "image_not_approved");
    expect(event).toBeDefined();
    expect(event?.graphId).toBe("graph-1");
    expect(event?.taskId).toBe("task-1");
    expect(event?.serviceType).toBe("redis");
    expect(event?.imageRef).toBe("redis:untrusted");
  });

  it("works without emitEvent wired (no-op emission)", async () => {
    const managerNoEmit = new TestServiceManager(api, redis, "bureau");
    await expect(managerNoEmit.startService({
      graphId: "g",
      taskId: "t",
      serviceType: "redis",
      leaseTtlSeconds: 60,
    })).resolves.toBeDefined();
  });
});
