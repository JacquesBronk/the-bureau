import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { RedisClient } from '../redis.js';
import type { TaskGraphManager } from '../task-graph.js';
import { ProcessMonitor } from '../process-monitor.js';

export function registerKillTask(
  server: McpServer,
  redis: RedisClient,
  graphManager: TaskGraphManager,
  processMonitor: ProcessMonitor,
): void {
  registerInstrumentedTool(server,
    'kill_task',
    {
      title: 'Kill Task',
      description: 'Kill a running task by taskId and graphId. Looks up the session, kills the process, and marks the task as failed.',
      inputSchema: z.object({
        graphId: z.string().describe('Graph ID'),
        taskId: z.string().describe('Task ID to kill'),
        reason: z.string().optional().describe('Why the task is being killed'),
      }),
    },
    async ({ graphId, taskId, reason }) => {
      const task = await graphManager.getTask(graphId, taskId);
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Task ${taskId} not found in graph ${graphId}` }], isError: true };
      }
      if (task.status !== 'running') {
        return { content: [{ type: 'text' as const, text: `Task ${taskId} is not running (status: ${task.status})` }], isError: true };
      }
      if (!task.sessionId) {
        return { content: [{ type: 'text' as const, text: `Task ${taskId} has no session ID` }], isError: true };
      }

      // Under k8s the worker runs as a Job and the PID is synthetic, so killing
      // the process won't stop the pod. Route through the engine kill seam first
      // so the worker Job (and its token Secret) are actually deleted (#184).
      await graphManager.killTaskWorker(task);

      const killed = await processMonitor.killProcess(task.sessionId);
      if (!killed) {
        // Try direct PID kill as fallback (harmless under k8s; relevant for local).
        const peerData = await redis.get(`peers:${task.sessionId}`);
        if (peerData) {
          const peer = JSON.parse(peerData);
          try { process.kill(peer.pid, 'SIGTERM'); } catch { /* already dead */ }
        }
      }

      await graphManager.onTaskFailed(graphId, taskId, task.sessionId, 1);

      const msg = reason ? `Killed: ${reason}` : 'Killed by orchestrator';
      return { content: [{ type: 'text' as const, text: `Task ${taskId} killed. ${msg}` }] };
    },
  );
}
