export interface ServiceConfig {
  name: string;
  path: string;
  language: string;
  languageVersion?: string;
  toolchain?: string;
  install?: string;
  build?: string;
  test?: string;
  integrationTest?: string;
  lint?: string;
  testReport?: string;
}

export interface BuildConfig {
  version: 1;
  services: ServiceConfig[];
  /** Opt-in bounded auto-rework configuration (#317), graph-level (not per-service).
   *  Resolved by resolveAutoRework in resolve-graph-input.ts; declare_task_graph input
   *  overrides this wholesale. Raw/unnormalized here — normalizeAutoRework applies
   *  the default/cap/off semantics. */
  autoRework?: { maxAttempts?: number; fixRole?: string };
}

export interface ResolvedCommands {
  install: string;
  build: string;
  test: string;
  integrationTest: string;
  lint: string;
}
