#!/usr/bin/env node
/**
 * Mock agent fixture for E2E tests.
 * Simulates an agent based on MOCK_BEHAVIOR env var.
 *
 * Behaviors:
 *   success    - write file, git commit, set handoff, exit 0
 *   no-commit  - write file but don't commit, exit 0
 *   no-handoff - write file, git commit, skip handoff, exit 0
 *   crash      - exit 1 immediately
 */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const TASK_ID = process.env.TASK_ID || "unknown-task";
const GRAPH_ID = process.env.GRAPH_ID || "unknown-graph";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const SESSION_ID = process.env.SESSION_ID || "mock-session";
const CWD = process.env.CWD || process.cwd();
const MOCK_BEHAVIOR = process.env.MOCK_BEHAVIOR || "success";

async function run() {
  if (MOCK_BEHAVIOR === "crash") {
    process.exit(1);
  }

  // Write a marker file
  const outFile = join(CWD, `task-${TASK_ID}.txt`);
  writeFileSync(outFile, `Task ${TASK_ID} completed by mock agent\n`);

  if (MOCK_BEHAVIOR === "no-commit") {
    // File written, no commit
    process.exit(0);
  }

  // Git commit
  try {
    execSync(`git add task-${TASK_ID}.txt`, { cwd: CWD, stdio: "pipe" });
    execSync(`git commit -m "feat: mock agent completes ${TASK_ID}"`, {
      cwd: CWD,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Mock Agent",
        GIT_AUTHOR_EMAIL: "mock@test.local",
        GIT_COMMITTER_NAME: "Mock Agent",
        GIT_COMMITTER_EMAIL: "mock@test.local",
      },
    });
  } catch {
    // Git might fail if nothing to commit — continue
  }

  if (MOCK_BEHAVIOR === "no-handoff") {
    process.exit(0);
  }

  // Set handoff in Redis
  const { Redis } = await import("ioredis");
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    const handoff = {
      taskId: TASK_ID,
      graphId: GRAPH_ID,
      filesChanged: [{ path: `task-${TASK_ID}.txt`, action: "added", summary: "Mock task output file" }],
      gitStats: { additions: 1, deletions: 0, filesChanged: 1 },
      summary: `Mock agent completed task ${TASK_ID}`,
      decisions: [],
      warnings: [],
      commits: [{ sha: "mockabc", message: `feat: mock agent completes ${TASK_ID}` }],
    };
    await redis.set(
      `handoff:${GRAPH_ID}:${TASK_ID}`,
      JSON.stringify(handoff),
      "EX",
      86400,
    );
  } finally {
    await redis.quit();
  }

  process.exit(0);
}

run().catch((err) => {
  console.error("mock-agent error:", err);
  process.exit(1);
});
