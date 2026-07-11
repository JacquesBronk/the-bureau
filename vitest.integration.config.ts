import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the integration test suite.
 *
 * Differences from vitest.config.ts (unit tests):
 *  - globalSetup boots docker-compose before tests and tears down after.
 *  - Much longer timeouts — waiting on network services and Docker.
 *  - Single-fork, single-thread: OTel providers set global singletons, so
 *    concurrent fork isolation would break metric/trace assertions.
 *  - Does NOT include BUREAU_DISABLE_MEM_THROTTLE (integration tests run
 *    against real service infrastructure).
 */
export default defineConfig({
  test: {
    globalSetup: ['tests/telemetry/integration/setup.ts'],
    include: ['tests/telemetry/integration/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    // Single worker: OTel global providers are singletons; parallel forks
    // would race on setGlobalMeterProvider / setGlobalTracerProvider.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
