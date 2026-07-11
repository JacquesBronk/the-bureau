import type { PeerInfo } from "./types.js";
import type { PeerRegistry } from "./registry.js";

export class StatusLine {
  private currentStatus = "";

  constructor(
    private registry: PeerRegistry,
    private writeStatus: (status: string) => void,
  ) {}

  async update(): Promise<void> {
    const self = this.registry.getSelf();
    const peers = await this.registry.listPeers();
    const otherPeers = peers.filter((p) => p.id !== self.id);

    const peerSummary = otherPeers
      .map((p) => `${p.role}(${p.host})`)
      .join(", ");

    const status = otherPeers.length > 0
      ? `${self.role} | ${otherPeers.length} peers: ${peerSummary}`
      : `${self.role} | no peers connected`;

    if (status !== this.currentStatus) {
      this.currentStatus = status;
      this.writeStatus(status);
    }
  }

  startPolling(intervalMs = 10_000): ReturnType<typeof setInterval> {
    return setInterval(() => this.update(), intervalMs);
  }
}
