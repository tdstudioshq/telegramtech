/**
 * JSON API adapter (M7.1) end-to-end over a real HttpServer + fetch: session auth,
 * profile, content (create/list/upload/publish), plans, analytics, and creator
 * isolation. Business logic lives in core services; this asserts the transport.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApiHandler } from '../../../../src/adapters/api/router.js';
import { AnalyticsService } from '../../../../src/core/services/analytics.service.js';
import { AuthService } from '../../../../src/core/services/auth.service.js';
import { CreatorService } from '../../../../src/core/services/creator.service.js';
import { DropService } from '../../../../src/core/services/drop.service.js';
import { OnboardingService } from '../../../../src/core/services/onboarding.service.js';
import { PurchaseService } from '../../../../src/core/services/purchase.service.js';
import { SubscriptionService } from '../../../../src/core/services/subscription.service.js';
import { createLogger } from '../../../../src/logging/logger.js';
import { HttpServer } from '../../../../src/server/http-server.js';
import { FakePasswordHasher, FakeSessionTokenService } from '../../../fakes/fake-auth.js';
import { FakeContentProvider } from '../../../fakes/fake-content.js';
import { FakePaymentProvider } from '../../../fakes/fake-payment-provider.js';
import { createWorld } from '../../../fakes/world.js';

const logger = createLogger({ level: 'silent', name: 'test' });

let server: HttpServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const start = async () => {
  const world = createWorld();
  const purchases = new PurchaseService(world.uow, new FakePaymentProvider(), world.access, world.audit, world.clock);
  const handler = createApiHandler({
    auth: new AuthService(world.uow, new FakePasswordHasher(), new FakeSessionTokenService(), world.clock, world.audit, 720),
    creators: new CreatorService(world.uow),
    drops: new DropService(world.uow, world.audit, world.clock),
    subscriptions: new SubscriptionService(world.uow, purchases, world.audit, world.clock),
    analytics: new AnalyticsService(world.uow, world.clock),
    onboarding: new OnboardingService(world.uow, world.clock),
    content: new FakeContentProvider(world.clock),
    logger,
  });
  server = new HttpServer(
    { port: 0, healthPath: '/health', api: { prefix: '/api', handler } },
    async () => ({ status: 'ok', version: 't', uptimeSeconds: 0, checks: { database: 'ok' }, latencyMs: 0 }),
    logger,
  );
  await server.start();
  return `http://127.0.0.1:${server.port}`;
};

interface Opts {
  token?: string;
  body?: unknown;
  raw?: Uint8Array;
  headers?: Record<string, string>;
}
const call = (base: string, method: string, path: string, opts: Opts = {}): Promise<Response> => {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  let body: string | Uint8Array | undefined;
  if (opts.raw) body = opts.raw;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return fetch(`${base}${path}`, { method, headers, body });
};

const register = async (base: string, email = 'ada@example.com') => {
  const res = await call(base, 'POST', '/api/auth/register', {
    body: { email, password: 'correct-horse', displayName: 'Ada', slug: email.split('@')[0] },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; creator: { id: string } };
};

describe('API auth + session', () => {
  it('register issues a session; protected routes need it', async () => {
    const base = await start();
    const { token } = await register(base);

    expect((await call(base, 'GET', '/api/profile')).status).toBe(401);
    const profile = await call(base, 'GET', '/api/profile', { token });
    expect(profile.status).toBe(200);

    const login = await call(base, 'POST', '/api/auth/login', {
      body: { email: 'ada@example.com', password: 'correct-horse' },
    });
    expect(login.status).toBe(200);
  });

  it('unknown routes 404, bad login 401', async () => {
    const base = await start();
    expect((await call(base, 'GET', '/api/nope', { token: 'x' })).status).toBe(401); // auth first
    const { token } = await register(base);
    expect((await call(base, 'GET', '/api/nope', { token })).status).toBe(404);
    const bad = await call(base, 'POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'wrong' } });
    expect(bad.status).toBe(401);
  });
});

describe('API content + plans + analytics', () => {
  it('creates/lists/uploads/publishes a drop and manages plans', async () => {
    const base = await start();
    const { token } = await register(base);

    const created = await call(base, 'POST', '/api/content/drops', {
      token,
      body: { title: 'My drop', accessType: 'free' },
    });
    expect(created.status).toBe(201);
    const drop = (await created.json()) as { id: string; status: string };
    expect(drop.status).toBe('draft');

    const list = await (await call(base, 'GET', '/api/content/drops', { token })).json();
    expect((list as unknown[]).length).toBe(1);

    // upload a media asset (raw bytes + headers), then publish
    const upload = await call(base, 'POST', `/api/content/drops/${drop.id}/assets`, {
      token,
      raw: new Uint8Array([1, 2, 3, 4]),
      headers: { 'x-asset-type': 'photo', 'content-type': 'image/png', 'x-file-name': 'a.png' },
    });
    expect(upload.status).toBe(201);

    const publish = await call(base, 'POST', `/api/content/drops/${drop.id}/publish`, { token });
    expect(publish.status).toBe(200);
    expect(((await publish.json()) as { status: string }).status).toBe('published');

    const plan = await call(base, 'POST', '/api/plans', {
      token,
      body: { name: 'Gold', priceStars: 500, durationDays: 30 },
    });
    expect(plan.status).toBe(201);
    const plans = await (await call(base, 'GET', '/api/plans', { token })).json();
    expect((plans as unknown[]).length).toBe(1);

    const summary = (await (await call(base, 'GET', '/api/analytics/summary', { token })).json()) as {
      publishedDrops: number;
      activePlans: number;
    };
    expect(summary.publishedDrops).toBe(1);
    expect(summary.activePlans).toBe(1);
  });

  it('tracks onboarding progress and completes it', async () => {
    const base = await start();
    const { token } = await register(base); // register sets a slug → profile step done

    const s1 = (await (await call(base, 'GET', '/api/onboarding', { token })).json()) as {
      steps: { profile: boolean; plan: boolean; content: boolean };
      nextStep: string | null;
      completed: boolean;
    };
    expect(s1.steps.profile).toBe(true);
    expect(s1.steps.plan).toBe(false);
    expect(s1.nextStep).toBe('plan');
    expect(s1.completed).toBe(false);

    await call(base, 'POST', '/api/plans', { token, body: { name: 'Gold', priceStars: 500, durationDays: 30 } });
    await call(base, 'POST', '/api/content/drops', { token, body: { title: 'D', accessType: 'free' } });

    const s2 = (await (await call(base, 'GET', '/api/onboarding', { token })).json()) as {
      steps: { profile: boolean; plan: boolean; content: boolean };
      nextStep: string | null;
    };
    expect(s2.steps.plan).toBe(true);
    expect(s2.steps.content).toBe(true);
    expect(s2.nextStep).toBeNull();

    const done = await call(base, 'POST', '/api/onboarding/complete', { token });
    expect(done.status).toBe(200);
    const s3 = (await (await call(base, 'GET', '/api/onboarding', { token })).json()) as {
      completed: boolean;
    };
    expect(s3.completed).toBe(true);
  });

  it('isolates creators — one cannot see another’s drops', async () => {
    const base = await start();
    const a = await register(base, 'alpha@example.com');
    const b = await register(base, 'beta@example.com');

    await call(base, 'POST', '/api/content/drops', {
      token: a.token,
      body: { title: 'A drop', accessType: 'free' },
    });

    const bDrops = await (await call(base, 'GET', '/api/content/drops', { token: b.token })).json();
    expect((bDrops as unknown[]).length).toBe(0); // B sees none of A's drops

    // B cannot upload into A's drop
    const aDrops = (await (await call(base, 'GET', '/api/content/drops', { token: a.token })).json()) as {
      id: string;
    }[];
    const steal = await call(base, 'POST', `/api/content/drops/${aDrops[0]?.id}/assets`, {
      token: b.token,
      raw: new Uint8Array([9]),
      headers: { 'x-asset-type': 'photo', 'content-type': 'image/png' },
    });
    expect(steal.status).toBe(404);
  });
});
