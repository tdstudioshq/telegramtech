/**
 * Job-factory tests: each job forwards to core and propagates the run's
 * correlation id, contains no business logic, and — for cleanup — closes the loop
 * to the notification handler to prove no duplicate notifications on rerun.
 */
import { describe, expect, it } from 'vitest';
import { NotificationEngine } from '../../../src/core/engines/notification.engine.js';
import { paymentFailedNotification } from '../../../src/core/events/handlers/notification.handler.js';
import { PurchaseService } from '../../../src/core/services/purchase.service.js';
import { SubscriptionService } from '../../../src/core/services/subscription.service.js';
import { createAnalyticsJob } from '../../../src/jobs/analytics.job.js';
import { createCleanupJob } from '../../../src/jobs/cleanup.job.js';
import { createNotificationJob } from '../../../src/jobs/notification.job.js';
import { createSubscriptionExpirationJob } from '../../../src/jobs/subscription-expiration.job.js';
import type { JobContext } from '../../../src/jobs/scheduler.js';
import { createLogger } from '../../../src/logging/logger.js';
import { FakeNotifier } from '../../fakes/fake-notifier.js';
import { FakePaymentProvider } from '../../fakes/fake-payment-provider.js';
import {
  createWorld,
  givenCreator,
  givenPlan,
  givenUser,
  type TestWorld,
} from '../../fakes/world.js';

const ctx = (correlationId = 'job-corr'): JobContext => ({
  correlationId,
  logger: createLogger({ level: 'silent', name: 'test' }),
});

const cfg = { intervalMs: 0, lockTtlSeconds: 30 };

const withPurchases = (world: TestWorld) =>
  new PurchaseService(world.uow, new FakePaymentProvider(), world.access, world.audit, world.clock);

describe('subscription-expiration job', () => {
  it('expires lapsed subscriptions and propagates the correlation id to audit', async () => {
    const world = createWorld();
    const purchases = withPurchases(world);
    const subscriptions = new SubscriptionService(world.uow, purchases, world.audit, world.clock);
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator, 30);
    const user = await givenUser(world);
    await subscriptions.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 'a' });
    world.clock.advanceDays(31);

    const job = createSubscriptionExpirationJob(subscriptions, { ...cfg, batchSize: 100 });
    const stats = await job.run(ctx('sweep-7'));

    expect(job.name).toBe('subscription-expiration');
    expect(stats).toMatchObject({ processed: 1, expired: 1 });
    const expiredRow = world.store.state.auditLogs.find((e) => e.action === 'subscription.expired');
    expect(expiredRow?.actorType).toBe('job');
    expect(expiredRow?.correlationId).toBe('sweep-7');
  });
});

describe('notification job', () => {
  it('drains queued intents through the notifier', async () => {
    const world = createWorld();
    const notifier = new FakeNotifier();
    const engine = new NotificationEngine(world.uow, notifier);
    const user = await givenUser(world);
    engine.enqueue({ userId: user.id, notification: { kind: 'payment_failed', text: 'hi' } });

    const job = createNotificationJob(engine, cfg);
    const stats = await job.run(ctx());

    expect(job.name).toBe('notification');
    expect(stats).toMatchObject({ processed: 1, sent: 1 });
    expect(notifier.sent).toHaveLength(1);
  });

  it('never double-sends across reruns (empty queue on the second drain)', async () => {
    const world = createWorld();
    const notifier = new FakeNotifier();
    const engine = new NotificationEngine(world.uow, notifier);
    const user = await givenUser(world);
    engine.enqueue({ userId: user.id, notification: { kind: 'payment_failed', text: 'hi' } });

    const job = createNotificationJob(engine, cfg);
    await job.run(ctx());
    const second = await job.run(ctx());

    expect(second).toMatchObject({ processed: 0 });
    expect(notifier.sent).toHaveLength(1);
  });
});

describe('cleanup job', () => {
  const seedStalePending = async (world: TestWorld, purchases: PurchaseService) => {
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator);
    const user = await givenUser(world);
    await world.uow.run(async (repos) =>
      purchases.beginAttempt(repos, {
        userId: user.id,
        creatorId: creator.id,
        dropId: null,
        planId: plan.id, // purchases target exactly one of drop/plan (XOR)
        amountStars: 50,
        idempotencyKey: `stale-${user.id}`,
      }),
    );
    return { creator, user };
  };

  it('fails stale pending pairs and forwards the correlation id', async () => {
    const world = createWorld();
    const purchases = withPurchases(world);
    await seedStalePending(world, purchases);
    world.clock.advanceMs(20 * 60_000); // past the 15-minute TTL

    const job = createCleanupJob(purchases, { ...cfg, stalePendingMinutes: 15, batchSize: 100 });
    const stats = await job.run(ctx('cleanup-3'));

    expect(job.name).toBe('cleanup');
    expect(stats).toMatchObject({ processed: 1, stalePendingFailed: 1 });
    expect(world.store.state.payments[0]?.status).toBe('failed');
    const auditRow = world.store.state.auditLogs.find((e) => e.action === 'payment.failed');
    expect(auditRow?.actorType).toBe('job');
    expect(auditRow?.correlationId).toBe('cleanup-3');
  });

  it('produces exactly one notification even when run twice (no duplicates)', async () => {
    const world = createWorld();
    const notifier = new FakeNotifier();
    const engine = new NotificationEngine(world.uow, notifier);
    world.dispatcher.register('PaymentFailed', 'notify', paymentFailedNotification(engine));
    const purchases = withPurchases(world);
    await seedStalePending(world, purchases);
    world.clock.advanceMs(20 * 60_000);

    const job = createCleanupJob(purchases, { ...cfg, stalePendingMinutes: 15, batchSize: 100 });
    await job.run(ctx());
    await job.run(ctx()); // rerun — already failed, nothing new

    const drain = createNotificationJob(engine, cfg);
    await drain.run(ctx());

    expect(notifier.sent).toHaveLength(1);
    expect(world.uow.dispatchedEvents.filter((e) => e.type === 'PaymentFailed')).toHaveLength(1);
  });
});

describe('analytics job', () => {
  it('is a registered no-op with no interval', async () => {
    const job = createAnalyticsJob();
    expect(job.name).toBe('analytics');
    expect(job.intervalMs).toBe(0);
    await expect(job.run(ctx())).resolves.toEqual({ processed: 0 });
  });
});
