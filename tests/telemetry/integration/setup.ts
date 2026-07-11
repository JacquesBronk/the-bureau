/**
 * Vitest globalSetup for the integration test suite.
 *
 * Starts the docker-compose telemetry stack before tests run and tears it
 * down afterward. Idempotent: if the ports are already in use (e.g. from a
 * previous failed run or a manually started stack), it reuses them and skips
 * teardown.
 *
 * Exported env vars injected before tests:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  = http://127.0.0.1:4318
 *   BUREAU_OTEL_ENABLED          = true
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const COMPOSE_FILE = resolve(process.cwd(), 'docker-compose.telemetry.yml');
const PROJECT_NAME = 'bureau-telemetry-test';

/** Service health endpoints polled before the suite starts. */
const HEALTH_ENDPOINTS = [
  { name: 'otel-collector', url: 'http://127.0.0.1:13133/' },
  { name: 'jaeger',         url: 'http://127.0.0.1:16686/' },
  { name: 'prometheus',     url: 'http://127.0.0.1:9090/-/healthy' },
];

const POLL_INTERVAL_MS = 500;
const STARTUP_TIMEOUT_MS = 60_000;

function composeArgs(cmd: string[]): string[] {
  return ['-f', COMPOSE_FILE, '-p', PROJECT_NAME, ...cmd];
}

/**
 * Check whether the stack ports are already serving.
 * This is port-based, not project-name-based, so it works regardless of
 * how the stack was started.
 */
async function arePortsAlreadyBound(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:13133/', { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function pollUntilHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const remaining = new Set(HEALTH_ENDPOINTS.map((e) => e.name));

  while (remaining.size > 0 && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    for (const ep of HEALTH_ENDPOINTS) {
      if (!remaining.has(ep.name)) continue;
      try {
        const res = await fetch(ep.url, { signal: AbortSignal.timeout(2000) });
        if (res.ok || res.status < 500) {
          remaining.delete(ep.name);
        }
      } catch {
        // still not ready
      }
    }
  }

  if (remaining.size > 0) {
    throw new Error(
      `Telemetry stack services did not become healthy within ${timeoutMs}ms: ${[...remaining].join(', ')}`,
    );
  }
}

let stackWasAlreadyRunning = false;

export async function setup(): Promise<() => Promise<void>> {
  // Set env vars so tests (and the process under test) target the local stack.
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
  process.env.BUREAU_OTEL_ENABLED = 'true';
  process.env.OTEL_SERVICE_NAME = 'bureau-integration-test';

  // Detect by port: if the collector health endpoint responds, the stack is up.
  stackWasAlreadyRunning = await arePortsAlreadyBound();

  if (!stackWasAlreadyRunning) {
    console.log('[telemetry-setup] Starting docker-compose telemetry stack…');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', ['compose', ...composeArgs(['up', '-d'])], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`docker compose up exited with code ${code}`));
      });
      proc.on('error', reject);
    });
  } else {
    console.log('[telemetry-setup] Telemetry stack ports already bound, reusing.');
  }

  console.log('[telemetry-setup] Waiting for all services to report healthy…');
  await pollUntilHealthy(STARTUP_TIMEOUT_MS);
  console.log('[telemetry-setup] All services healthy. Starting integration suite.');

  return async () => {
    if (stackWasAlreadyRunning) {
      console.log('[telemetry-setup] Stack was pre-existing — skipping teardown.');
      return;
    }
    console.log('[telemetry-setup] Tearing down docker-compose telemetry stack…');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', ['compose', ...composeArgs(['down', '--volumes'])], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`docker compose down exited with code ${code}`));
      });
      proc.on('error', reject);
    });
    console.log('[telemetry-setup] Stack torn down.');
  };
}
