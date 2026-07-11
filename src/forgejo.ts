import type pino from "pino";
import type { AnalysisFinding } from "./self-improvement/types.js";

/**
 * File a Forgejo issue for a self-improvement finding.
 * Requires FORGEJO_URL and FORGEJO_TOKEN env vars; logs and skips if not set.
 */
export async function fileForgejoIssue(
  finding: AnalysisFinding,
  label: string,
  log: pino.Logger,
): Promise<void> {
  const forgejoUrl = process.env.FORGEJO_URL;
  const forgejoToken = process.env.FORGEJO_TOKEN;
  const owner = process.env.FORGEJO_OWNER ?? "claude";
  const repo = process.env.FORGEJO_REPO ?? "the-bureau";

  if (!forgejoUrl || !forgejoToken) {
    log.warn({ findingId: finding.id, label }, "FORGEJO_URL or FORGEJO_TOKEN not set — skipping issue filing");
    return;
  }

  try {
    // Resolve label ID by name (create if absent)
    const labelId = await resolveForgejoLabel(forgejoUrl, forgejoToken, owner, repo, label);

    const body = [
      finding.description,
      "",
      `**Evidence:** ${finding.evidence}`,
      `**Suggested action:** ${finding.suggestedAction}`,
      `**Impact:** ${finding.estimatedImpact}`,
      ...(finding.affectedFiles?.length ? [`**Affected files:** ${finding.affectedFiles.join(", ")}`] : []),
    ].join("\n");

    const issuePayload: Record<string, unknown> = { title: finding.title, body };
    if (labelId !== null) issuePayload.labels = [labelId];

    const res = await fetch(`${forgejoUrl}/api/v1/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `token ${forgejoToken}` },
      body: JSON.stringify(issuePayload),
    });

    if (!res.ok) {
      log.warn({ findingId: finding.id, label, status: res.status }, "Forgejo issue filing failed");
    } else {
      const issued = await res.json() as { number?: number };
      log.info({ findingId: finding.id, label, issueNumber: issued.number }, "Forgejo issue filed");
    }
  } catch (err: any) {
    log.warn({ findingId: finding.id, label, err: String(err) }, "Forgejo issue filing error");
  }
}

/** Resolve a Forgejo label ID by name, creating it if absent. */
export async function resolveForgejoLabel(
  forgejoUrl: string, token: string, owner: string, repo: string, name: string,
): Promise<number | null> {
  try {
    const listRes = await fetch(`${forgejoUrl}/api/v1/repos/${owner}/${repo}/labels`, {
      headers: { "Authorization": `token ${token}` },
    });
    if (!listRes.ok) return null;
    const labels = await listRes.json() as Array<{ id: number; name: string }>;
    const existing = labels.find((l) => l.name === name);
    if (existing) return existing.id;

    // Create label if not found
    const createRes = await fetch(`${forgejoUrl}/api/v1/repos/${owner}/${repo}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `token ${token}` },
      body: JSON.stringify({ name, color: "#0075ca" }),
    });
    if (!createRes.ok) return null;
    const created = await createRes.json() as { id: number };
    return created.id;
  } catch {
    return null;
  }
}

/**
 * Open an export-back PR on Forgejo for a dynamically created agent file.
 * Returns the PR URL on success, null if Forgejo env is not configured or on error.
 * Creates a branch, pushes the file, then opens the PR.
 */
export async function openForgejoPR(opts: {
  agentId: string;
  relPath: string;   // e.g. "agents/dynamic/my-analyst.md"
  content: string;   // full file content (frontmatter + body)
}): Promise<string | null> {
  const forgejoUrl = process.env.FORGEJO_URL;
  const forgejoToken = process.env.FORGEJO_TOKEN;
  const owner = process.env.FORGEJO_OWNER ?? "claude";
  const repo = process.env.FORGEJO_REPO ?? "the-bureau";

  if (!forgejoUrl || !forgejoToken) return null;

  const branch = `agents/dynamic/${opts.agentId}`;
  const headers = { "Content-Type": "application/json", "Authorization": `token ${forgejoToken}` };

  try {
    // 1. Confirm the default branch exists
    const branchRes = await fetch(`${forgejoUrl}/api/v1/repos/${owner}/${repo}/branches/master`, { headers });
    if (!branchRes.ok) return null;
    // branch exists — no need to extract the SHA

    // 2. Create branch
    const createBrRes = await fetch(`${forgejoUrl}/api/v1/repos/${owner}/${repo}/branches`, {
      method: "POST",
      headers,
      body: JSON.stringify({ new_branch_name: branch, old_branch_name: "master" }),
    });
    // 409 = already exists — continue anyway
    if (!createBrRes.ok && createBrRes.status !== 409) return null;

    // 3. Create or update file on the branch
    const encoded = Buffer.from(opts.content, "utf-8").toString("base64");
    const fileRes = await fetch(`${forgejoUrl}/api/v1/repos/${owner}/${repo}/contents/${opts.relPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: `feat(agents): add dynamic agent ${opts.agentId}`,
        content: encoded,
        branch,
      }),
    });
    if (!fileRes.ok) return null;

    // 4. Open PR
    const prRes = await fetch(`${forgejoUrl}/api/v1/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `feat(agents): add dynamic agent ${opts.agentId}`,
        body: [
          `Automated export-back PR for in-flight agent \`${opts.agentId}\`.`,
          "",
          `This PR adds \`${opts.relPath}\` to the curated agent corpus so it`,
          "survives a PVC reset and is available to all future deployments.",
        ].join("\n"),
        head: branch,
        base: "master",
      }),
    });
    if (!prRes.ok) return null;
    const prData = await prRes.json() as { html_url?: string };
    return prData.html_url ?? null;
  } catch {
    return null;
  }
}
