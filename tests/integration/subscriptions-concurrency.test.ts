/**
 * Regression (M7.3.1): concurrent distinct-plan subscribes for one (user, creator)
 * must never double-charge. Before the per-creator unique index they both succeeded
 * (the old index was per-plan); now the DB rejects the loser and the service maps the
 * violation to a graceful conflict. Runs against real Postgres transactions.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DrizzleUnitOfWork } from '../../src/adapters/persistence/db/unit-of-work.js';
import { MockPaymentProvider } from '../../src/adapters/payments/mock-payment.provider.js';
import { EventDispatcher } from '../../src/core/events/dispatcher.js';
import type { Clock } from '../../src/core/ports/clock.port.js';
import { AccessService } from '../../src/core/services/access.service.js';
import { AuditService } from '../../src/core/services/audit.service.js';
import { PurchaseService } from '../../src/core/services/purchase.service.js';
import { SubscriptionService } from '../../src/core/services/subscription.service.js';
import { createLogger } from '../../src/logging/logger.js';
import { connect, makeCreator, makePlan, makeUser } from './helpers.js';

const ctx = connect();
afterAll(() => ctx.db.close());

const clock: Clock = { now: () => new Date() };
const dispatcher = new EventDispatcher(createLogger({ level: 'silent', name: 'test' }));
const uow = new DrizzleUnitOfWork(ctx.db.db, dispatcher);
const audit = new AuditService();
const access = new AccessService(uow, clock);
const purchases = new PurchaseService(
  uow,
  new MockPaymentProvider({ delayMs: 0, failureRate: 0 }),
  access,
  audit,
  clock,
);
const subscriptions = new SubscriptionService(uow, purchases, audit, clock);

describe('concurrent subscription attempts (one active per creator)', () => {
  it('two concurrent distinct-plan subscribes → exactly one wins, one conflict, one charge', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const plan1 = await makePlan(ctx.repos, creator.id);
    const plan2 = await makePlan(ctx.repos, creator.id);
    const user = await makeUser(ctx.repos);

    const [r1, r2] = await Promise.all([
      subscriptions.subscribe({
        userId: user.id,
        planId: plan1.id,
        idempotencyKey: `k1-${user.id}`,
      }),
      subscriptions.subscribe({
        userId: user.id,
        planId: plan2.id,
        idempotencyKey: `k2-${user.id}`,
      }),
    ]);

    const winners = [r1, r2].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const loser = [r1, r2].find((r) => !r.ok);
    expect(loser && !loser.ok && loser.error.code).toBe('conflict');

    // exactly one active subscription survives for this (user, creator)
    const active = await ctx.repos.subscriptions.findActiveForUserAndCreator(user.id, creator.id);
    expect(active).not.toBeNull();

    // and exactly one purchase completed — the loser's charge was rolled back, not double-billed
    const agg = await ctx.repos.purchases.aggregateByCreator(creator.id);
    expect(agg.completedSales).toBe(1);
  });
});
