export interface StartupDiagnosticsParams {
  version: string;
  profile: string;
  toolCount: number;
  redisStatus: string;
  sessionId: string;
  role: string;
  graphId: string | undefined;
  taskId: string | undefined;
  enrichmentEnabled: boolean;
  graphContext: boolean;
}

export interface StartupDiagnostics extends StartupDiagnosticsParams {
  nodeVersion: string;
  platform: string;
}

/**
 * Build a structured startup diagnostics object from the given params.
 * Adds platform info (Node version, OS) automatically from the process environment.
 * Extracted as a pure-ish function so it can be unit-tested without importing mcp-server.ts.
 */
export function buildStartupDiagnostics(params: StartupDiagnosticsParams): StartupDiagnostics {
  return {
    ...params,
    nodeVersion: process.version,
    platform: process.platform,
  };
}
