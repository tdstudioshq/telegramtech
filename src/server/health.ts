/**
 * Health check (M6). A structural `Pingable` keeps this composition module free of
 * any persistence import — app.ts passes the database's `ping`. The check reports
 * `ok` only when the dependency round-trips; the HTTP server maps `degraded` to 503
 * so Railway's health probe restarts an instance that has lost its database.
 */
export type HealthState = 'ok' | 'degraded';

export interface HealthReport {
  readonly status: HealthState;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly checks: { readonly database: 'ok' | 'error' };
  readonly latencyMs: number;
}

export type HealthCheck = () => Promise<HealthReport>;

export interface Pingable {
  ping(): Promise<void>;
}

export interface HealthCheckDeps {
  readonly database: Pingable;
  readonly version: string;
  /** Injectable for tests; defaults to process uptime in whole seconds. */
  readonly uptimeSeconds?: () => number;
}

export const createHealthCheck = (deps: HealthCheckDeps): HealthCheck => {
  const uptime = deps.uptimeSeconds ?? (() => Math.round(process.uptime()));
  return async () => {
    const startedAtMs = Date.now();
    let database: 'ok' | 'error' = 'ok';
    try {
      await deps.database.ping();
    } catch {
      database = 'error';
    }
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      version: deps.version,
      uptimeSeconds: uptime(),
      checks: { database },
      latencyMs: Date.now() - startedAtMs,
    };
  };
};
