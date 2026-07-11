import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createRedisClient } from "../src/redis.js";
import { PeerRegistry } from "../src/registry.js";
import { Messaging } from "../src/messaging.js";
import type { PeerInfo } from "../src/types.js";

describe("Integration: Registry + Messaging", () => {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const redis1 = createRedisClient(redisUrl);
  const redis2 = createRedisClient(redisUrl);

  const peer1Info: PeerInfo = {
    id: "integ-peer-1",
    role: "orchestrator",
    host: "test-host",
    cwd: "/tmp/test1",
    project: "integ-test",
    pid: 1,
    spawnedBy: null,
    phase: "starting",
    description: "",
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };

  const peer2Info: PeerInfo = {
    id: "integ-peer-2",
    role: "coder",
    host: "test-host",
    cwd: "/tmp/test2",
    project: "integ-test",
    pid: 2,
    spawnedBy: "integ-peer-1",
    phase: "starting",
    description: "",
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };

  let reg1: PeerRegistry;
  let reg2: PeerRegistry;
  let msg1: Messaging;
  let msg2: Messaging;

  beforeAll(async () => {
    // Clean up
    const keys = await redis1.keys("*integ-*");
    if (keys.length > 0) await redis1.del(...keys);

    reg1 = new PeerRegistry(redis1, peer1Info);
    reg2 = new PeerRegistry(redis2, peer2Info);
    msg1 = new Messaging(redis1, "integ-peer-1");
    msg2 = new Messaging(redis2, "integ-peer-2");

    await reg1.register();
    await reg2.register();
  });

  afterAll(async () => {
    await reg1.deregister();
    await reg2.deregister();
    const keys = await redis1.keys("*integ-*");
    if (keys.length > 0) await redis1.del(...keys);
    await redis1.quit();
    await redis2.quit();
  });

  it("both peers discover each other", async () => {
    const peers = await reg1.listPeers({ project: "integ-test" });
    expect(peers.length).toBe(2);
    const roles = peers.map((p) => p.role).sort();
    expect(roles).toEqual(["coder", "orchestrator"]);
  });

  it("orchestrator sends task to coder, coder receives it", async () => {
    await msg1.sendMessage("integ-peer-2", "integ-peer-1", "task", "Implement the login page");

    const messages = await msg2.checkMessages();
    expect(messages.length).toBe(1);
    expect(messages[0].from).toBe("integ-peer-1");
    expect(messages[0].type).toBe("task");
    expect(messages[0].body).toBe("Implement the login page");
  });

  it("coder responds to orchestrator", async () => {
    await msg2.sendMessage("integ-peer-1", "integ-peer-2", "message", "Done. Created src/login.ts with tests.");

    const messages = await msg1.checkMessages();
    expect(messages.length).toBe(1);
    expect(messages[0].from).toBe("integ-peer-2");
    expect(messages[0].body).toContain("Done");
  });

  it("broadcast reaches both peers via project channel", async () => {
    await msg1.broadcast("integ-test", "integ-peer-1", "Schema updated, re-pull models");

    const b1 = await msg1.checkBroadcasts("integ-test");
    const b2 = await msg2.checkBroadcasts("integ-test");
    expect(b1.length).toBe(1);
    expect(b2.length).toBe(1);
    expect(b1[0].body).toBe("Schema updated, re-pull models");
  });
});
