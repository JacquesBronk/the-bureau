import { getActiveProfile, parseLoadout, type ProfileName } from "../mcp-profiles.js";
import type { VerifiedIdentity } from "./auth/verifier.js";
import type { Capability } from "./capability.js";

/** The connecting agent's own identity + graph context. Replaces the module-global
 *  session identity (sessionId/TASK_ID/GRAPH_ID/SESSION_PROJECT) and workspaceConfig.
 *  D3 will add `loadout`/`tenant`; D4 supplies one of these per HTTP connection. */
export interface ConnectionContext {
  sessionId: string;
  taskId?: string;
  graphId?: string;
  parentGraphId?: string;
  project?: string;
  role?: string;
  /** Which tools this connection may call (D3). Required: every context has a
   *  loadout so the authorization interceptor never sees an undefined privilege. */
  loadout: ProfileName;
  /** Resolved Capability from the task record (Phase 2). When set, drives both
   *  registration-time gating (buildSurface) and call-time enforcement in the
   *  authorization interceptor, superseding the ProfileName-based check. */
  capability?: Capability;
  /** Multi-tenant seam (ADR-010/R12); carried from day one even single-operator. */
  tenant?: string;
}

/** Resolves the context for one tool call. `extra` is the MCP SDK's RequestHandlerExtra
 *  (carries `sessionId` in HTTP mode; undefined in stdio). Stdio ignores it. */
export type ContextResolver = (extra?: { sessionId?: string }) => ConnectionContext;

/** Build the single context from process env (stdio / one-agent-per-process mode).
 *  `sessionId` is passed in because the caller applies the uuid fallback.
 *
 *  NOTE: this reads `role` as a bare `SESSION_ROLE || undefined`. It does NOT apply
 *  the `"orchestrator"` default that `mcp-server.ts` puts on its `sessionRole` const.
 *  mcp-server therefore seeds its `connectionCtx` by hand from that const rather than
 *  calling this; a D4 transport that needs the orchestrator default must apply it
 *  itself before/after calling `createEnvContext`. */
export function createEnvContext(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionContext {
  return {
    sessionId,
    taskId: env.TASK_ID || undefined,
    graphId: env.GRAPH_ID || undefined,
    project: env.SESSION_PROJECT || undefined,
    role: env.SESSION_ROLE || undefined,
    loadout: getActiveProfile(env),
    tenant: env.BUREAU_TENANT || undefined,
    // parentGraphId is resolved asynchronously and patched onto this object later
    // (see mcp-server main()); the static resolver returns this same mutable object,
    // so a late `ctx.parentGraphId = ...` is visible to every subsequent call.
  };
}

/** Stdio resolver: one context, returned for every call regardless of `extra`. */
export function createStaticResolver(ctx: ConnectionContext): ContextResolver {
  return () => ctx;
}

/** HTTP resolver: look the context up per call by the SDK-supplied `extra.sessionId`
 *  (the transport session id used as the map key). Throws if absent — a missing
 *  context means a request slipped through without an initialized session, which must
 *  fail loudly rather than silently borrow another agent's identity. */
export function createMapResolver(
  map: Map<string, ConnectionContext>,
): ContextResolver {
  return (extra) => {
    const key = extra?.sessionId;
    const ctx = key !== undefined ? map.get(key) : undefined;
    if (!ctx) {
      throw new Error(`no ConnectionContext for session ${key ?? "<none>"}`);
    }
    return ctx;
  };
}

type HeaderBag = Record<string, string | string[] | undefined>;
function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0] || undefined;
  return v || undefined;
}

/** Build a ConnectionContext from the worker's MCP `initialize` request headers
 *  (dev/fail-open identity per ADR-012 O1; token claims replace this at ADR-008).
 *  `fallbackSessionId` is the transport-generated session id, used as the logical
 *  sessionId when the worker presents no x-bureau-session-id header. */
export function createHeaderContext(
  headers: HeaderBag,
  fallbackSessionId: string,
): ConnectionContext {
  return {
    sessionId: firstHeader(headers["x-bureau-session-id"]) || fallbackSessionId,
    taskId: firstHeader(headers["x-bureau-task-id"]),
    graphId: firstHeader(headers["x-bureau-graph-id"]),
    project: firstHeader(headers["x-bureau-project"]),
    role: firstHeader(headers["x-bureau-role"]),
    loadout: parseLoadout(firstHeader(headers["x-bureau-loadout"])),
    tenant: firstHeader(headers["x-bureau-tenant"]),
  };
}

/** Build a ConnectionContext from a verified token identity + the engine-resolved
 *  loadout (oidc mode). Loadout comes from the task record, never the token (R4).
 *  `capability` is optional (Phase 2): when supplied it carries the resolved tool
 *  surface for this task and supersedes the ProfileName-based check downstream. */
export function createTokenContext(
  identity: VerifiedIdentity,
  loadout: ProfileName,
  fallbackSessionId: string,
  capability?: Capability,
): ConnectionContext {
  return {
    sessionId: identity.sessionId || fallbackSessionId,
    taskId: identity.taskId,
    graphId: identity.graphId,
    project: undefined,
    role: undefined,
    loadout,
    capability,
    tenant: identity.tenant ?? "default",
  };
}
