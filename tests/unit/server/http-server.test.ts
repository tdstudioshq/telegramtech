/**
 * HttpServer: real server on an ephemeral port. Health maps ok→200 / degraded→503 /
 * throw→503; non-GET on health is 405; unknown paths 404; the webhook route delegates
 * to the mounted handler. Uses global fetch against 127.0.0.1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/logging/logger.js';
import type { HealthCheck, HealthReport } from '../../../src/server/health.js';
import { HttpServer, type WebhookRoute } from '../../../src/server/http-server.js';

const logger = createLogger({ level: 'silent', name: 'test' });

const okReport = (): HealthReport => ({
  status: 'ok',
  version: 'test',
  uptimeSeconds: 1,
  checks: { database: 'ok' },
  latencyMs: 0,
});

let server: HttpServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const start = async (health: HealthCheck, webhook?: WebhookRoute): Promise<string> => {
  server = new HttpServer({ port: 0, healthPath: '/health', webhook }, health, logger);
  await server.start();
  return `http://127.0.0.1:${server.port}`;
};

describe('HttpServer health route', () => {
  it('returns 200 + the report when healthy', async () => {
    const base = await start(async () => okReport());
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', version: 'test' });
  });

  it('returns 503 when degraded', async () => {
    const base = await start(async () => ({ ...okReport(), status: 'degraded' }));
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
  });

  it('returns 503 when the health check throws', async () => {
    const base = await start(async () => {
      throw new Error('boom');
    });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'degraded', error: 'healthcheck_failed' });
  });

  it('rejects non-GET methods with 405', async () => {
    const base = await start(async () => okReport());
    const res = await fetch(`${base}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('HttpServer routing', () => {
  it('404s unknown paths', async () => {
    const base = await start(async () => okReport());
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it('delegates the webhook path to the mounted handler', async () => {
    let hit = false;
    const webhook: WebhookRoute = {
      path: '/tg/hook',
      handler: (_req, res) => {
        hit = true;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('WH');
      },
    };
    const base = await start(async () => okReport(), webhook);

    const res = await fetch(`${base}/tg/hook`, { method: 'POST', body: '{}' });

    expect(hit).toBe(true);
    expect(await res.text()).toBe('WH');
  });

  it('binds an ephemeral port when configured with port 0', async () => {
    await start(async () => okReport());
    expect(server?.port).toBeGreaterThan(0);
  });
});
