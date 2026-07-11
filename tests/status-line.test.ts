import { describe, it, expect, vi } from "vitest";
import { StatusLine } from "../src/status-line.js";

function makeRegistry(selfId: string, allPeers: object[]) {
  return {
    getSelf: vi.fn().mockReturnValue(allPeers.find((p: any) => p.id === selfId)),
    listPeers: vi.fn().mockResolvedValue(allPeers),
  };
}

describe("StatusLine", () => {
  it("writes status with peer summary when other peers are connected", async () => {
    const self = { id: "me", role: "coder", host: "box1" };
    const peer = { id: "other", role: "reviewer", host: "box2" };
    const registry = makeRegistry("me", [self, peer]);
    const writeStatus = vi.fn();

    await new StatusLine(registry as any, writeStatus).update();

    expect(writeStatus).toHaveBeenCalledOnce();
    const written = writeStatus.mock.calls[0][0] as string;
    expect(written).toContain("coder");
    expect(written).toContain("1 peers");
    expect(written).toContain("reviewer(box2)");
  });

  it("writes no-peers message when this session is the only one", async () => {
    const self = { id: "me", role: "coder", host: "box1" };
    const registry = makeRegistry("me", [self]);
    const writeStatus = vi.fn();

    await new StatusLine(registry as any, writeStatus).update();

    expect(writeStatus).toHaveBeenCalledOnce();
    expect(writeStatus.mock.calls[0][0]).toContain("no peers connected");
  });

  it("does not call writeStatus again when the status string is unchanged", async () => {
    const self = { id: "me", role: "coder", host: "box1" };
    const registry = makeRegistry("me", [self]);
    const writeStatus = vi.fn();
    const sl = new StatusLine(registry as any, writeStatus);

    await sl.update();
    await sl.update();

    expect(writeStatus).toHaveBeenCalledOnce();
  });

  it("calls writeStatus again when status changes between updates", async () => {
    const self = { id: "me", role: "coder", host: "box1" };
    const writeStatus = vi.fn();
    const registry = {
      getSelf: vi.fn().mockReturnValue(self),
      listPeers: vi.fn()
        .mockResolvedValueOnce([self])
        .mockResolvedValueOnce([self, { id: "peer-2", role: "tester", host: "box2" }]),
    };
    const sl = new StatusLine(registry as any, writeStatus);

    await sl.update(); // alone
    await sl.update(); // now has a peer

    expect(writeStatus).toHaveBeenCalledTimes(2);
  });

  it("startPolling returns a clearable interval", () => {
    const registry = makeRegistry("me", [{ id: "me", role: "coder", host: "box1" }]);
    const writeStatus = vi.fn();
    const sl = new StatusLine(registry as any, writeStatus);

    const handle = sl.startPolling(60_000);
    expect(handle).toBeDefined();
    clearInterval(handle);
  });
});
