/**
 * Health check: `ok` only when the dependency round-trips; `degraded` (→ 503) when
 * the ping throws. Uptime/version are reported for the probe payload.
 */
import { describe, expect, it } from 'vitest';
import { createHealthCheck } from '../../../src/server/health.js';

describe('createHealthCheck', () => {
  it('reports ok when the database pings', async () => {
    const check = createHealthCheck({
      database: { ping: async () => undefined },
      version: '1.2.3',
      uptimeSeconds: () => 42,
    });

    const report = await check();

    expect(report).toMatchObject({
      status: 'ok',
      version: '1.2.3',
      uptimeSeconds: 42,
      checks: { database: 'ok' },
    });
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded when the database ping throws', async () => {
    const check = createHealthCheck({
      database: {
        ping: async () => {
          throw new Error('pool exhausted');
        },
      },
      version: '1.2.3',
    });

    const report = await check();

    expect(report.status).toBe('degraded');
    expect(report.checks.database).toBe('error');
  });
});
