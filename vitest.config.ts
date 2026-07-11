import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Clear mock call counts/instances between tests (not implementations — use resetMocks for that).
    clearMocks: true,
    // Integration tests require Docker and are run separately via test:integration.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/telemetry/integration/**',
    ],
    testTimeout: 15000,
    hookTimeout: 30000,
    // Force REDIS_URL onto a dedicated logical DB (default 15) in every worker so the
    // suite's flush/teardown can never wipe the engine's live DB (db 0). See the file.
    setupFiles: ['./tests/redis-isolation.setup.ts'],
    env: {
      // Disable the 2GB-free memory throttle in dispatchReadyTasks so tests
      // don't flake on memory-constrained CI runners.
      BUREAU_DISABLE_MEM_THROTTLE: '1',
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'dist/**',
        'tests/**',
        // Pure type files — no executable lines, excluded to keep coverage signal honest
        'src/types/**',
        // Composition roots — wiring only; belong to e2e/live, not unit coverage
        'src/cli.ts',
        'src/mcp-server.ts',
      ],
      thresholds: {
        branches: 80,
        functions: 85,
        lines: 78,
      },
    },
  },
});
