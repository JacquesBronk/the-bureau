import type { RedisClient } from "../../redis.js";
import { parseLoadout, type ProfileName } from "../../mcp-profiles.js";
import type { VerifiedIdentity } from "./verifier.js";
import type { Capability } from "../capability.js";

/** Loadout for a worker-less (operator) connection.
 *  - internal (engine-signed) identity: trust the self-asserted loadout claim.
 *  - external IdP identity: use the issuer's engine-configured defaultLoadout; the
 *    token's self-asserted loadout is NOT trusted.
 *  EXTENSION POINT for role→loadout mapping: read roles from a configured claim path on
 *  `identity.claims`, pick the highest-privilege match, fall back to defaultLoadout. */
export function resolveOperatorLoadout(identity: VerifiedIdentity): ProfileName {
  if (identity.internal) return parseLoadout(identity.loadout);
  return identity.defaultLoadout ?? "minimal";
}

/** Resolve a connection's loadout from its task record (R4). The worker never
 *  supplies this; it is whatever the engine stamped at dispatch (graph-dispatch.ts).
 *  Missing node / missing-or-invalid loadout / Redis error → least privilege ("minimal"). */
export async function resolveLoadoutFromTask(
  redis: RedisClient,
  graphId: string | undefined,
  taskId: string | undefined,
): Promise<ProfileName> {
  if (!graphId || !taskId) return "minimal";
  try {
    const raw = await redis.get(`graph:${graphId}:tasks:${taskId}`);
    if (!raw) return "minimal";
    const node = JSON.parse(raw) as { loadout?: string };
    return parseLoadout(node.loadout);
  } catch {
    return "minimal";
  }
}

/** Read the resolved Capability from the task record. Returns undefined when the
 *  record is absent, the capability field is missing, parsing fails, or Redis errors. */
export async function resolveCapabilityFromTask(
  redis: RedisClient,
  graphId: string | undefined,
  taskId: string | undefined,
): Promise<Capability | undefined> {
  if (!graphId || !taskId) return undefined;
  try {
    const raw = await redis.get(`graph:${graphId}:tasks:${taskId}`);
    if (!raw) return undefined;
    const node = JSON.parse(raw) as { capability?: unknown };
    if (!node.capability || typeof node.capability !== "object") return undefined;
    return node.capability as Capability;
  } catch {
    return undefined;
  }
}

/** Read the worker's project from its task record, for MCP-registry ACL scoping.
 *  Mirrors resolveLoadoutFromTask; undefined on missing node/project or error. */
export async function resolveProjectFromTask(
  redis: RedisClient,
  graphId: string | undefined,
  taskId: string | undefined,
): Promise<string | undefined> {
  if (!graphId || !taskId) return undefined;
  try {
    const raw = await redis.get(`graph:${graphId}:tasks:${taskId}`);
    if (!raw) return undefined;
    const node = JSON.parse(raw) as { project?: string };
    return typeof node.project === "string" ? node.project : undefined;
  } catch {
    return undefined;
  }
}
