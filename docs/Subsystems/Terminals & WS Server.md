# Terminals & WS Server

> [!warning] Removed — this subsystem no longer exists
> The entire terminal / PTY / WebSocket-streaming subsystem was **deleted** as part of the move to k8s-only worker dispatch. A dead-code follow-up then excised the now-inert local-only spawn code that the terminal layer had depended on. None of the files this note used to describe still exist — `src/terminal-registry.ts`, `src/ws-server.ts`, `src/terminal-setup.ts`, `src/types/terminal.ts`, and the seven terminal tools (`attach_terminal`, `detach_terminal`, `send_input`, `resize_terminal`, `list_terminals`, `get_terminal_snapshot`, `get_recording`) were all removed. This note is retained for historical context only; everything below is past tense.

## Why it was removed
The terminal subsystem existed to stream and interact with the live PTY of a **locally-spawned** agent. The Bureau's spawn model moved to **k8s-only worker dispatch**: every worker is now launched as a Kubernetes Job (pod-per-task isolation), observed via logs and the HTTP-MCP seam rather than a live PTY. With local/host PTY spawning gone, the registry, the WebSocket proxy, and all seven terminal tools had no producer of `SpawnHandle`s to stream from, so they were deleted wholesale, dropping the `node-pty` and runtime `ws` dependencies. The removal also resolved two long-standing problems: parallel graphs failing on a local `git worktree add`, and `node-pty` being a hard dependency that broke type-only consumers' installs. The follow-up cleanup deleted the remaining inert local-only code (sandbox gate, SSH/cross-host dispatch, `SpawnHandle` PTY stubs) that the terminal layer had relied on.

For the current observation model, see the k8s spawn path documented in the Deployment & Infrastructure track (`k8s Spawn Strategy`) and the worker-spawn flow in [Spawn & PTY](Spawn%20%26%20PTY.md).

## What it used to be (historical)
The subsystem exposed the live terminal of each PTY-backed agent. A `TerminalRegistry` (formerly `src/terminal-registry.ts`) mapped a `sessionId` to its `SpawnHandle`, buffered recent output in a per-session ring buffer for late-joining clients, re-emitted the handle's `data`/`exit` events, and forwarded `write` (stdin) and `resize` back to the live PTY. A `TerminalWebSocketServer` (formerly `src/ws-server.ts`) ran on a Redis-coordinated auto-allocated port, authenticated WebSocket clients with a JWT, rate-limited input, registered its endpoint in Redis for discovery, and fanned the registry's output out to connected clients. Seven MCP tools (`attach_terminal`, `detach_terminal`, `send_input`, `resize_terminal`, `list_terminals`, `get_terminal_snapshot`, `get_recording`), registered by `setupTerminals` (formerly `src/terminal-setup.ts`), let operators and the dashboard observe and interact with agents.

The subsystem's lineage: it began as a tmux-based "PTY proxy for live shell view", later replaced tmux with node-pty and introduced `TerminalRegistry` — "the agent IS the PTY now" — and added Redis-coordinated WS port auto-allocation. Later fixes wired the registry into both spawn paths, delivered resize to the PTY, and decommissioned the dead `AsciicastWriter` in favor of raw JSONL logs. All of this was deleted by the k8s-only spawn migration.

> [!note] Historical diagrams removed
> Earlier versions of this note carried Mermaid sequence/flow diagrams of the live output-streaming and WebSocket-upgrade wiring. Those depicted code that no longer exists and have been removed to avoid implying current behavior.

## Related
- [Spawn & PTY](Spawn%20%26%20PTY.md) — the current worker-spawn subsystem (k8s Job dispatch); supersedes this one as the agent-observation seam.
- k8s Spawn Strategy — the k8s-only dispatch path that replaced local PTY spawning (Deployment & Infrastructure track).
- [MCP Server Core & Tool Surface](MCP%20Server%20Core%20%26%20Tool%20Surface.md) — formerly registered and started this subsystem in `main()`.
- [Redis & Connection Layer](Redis%20%26%20Connection%20Layer.md) — formerly held the WS endpoint registry and `send_input` audit stream.
