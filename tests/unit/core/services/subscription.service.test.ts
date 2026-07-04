import { describe, expect, it } from 'vitest';
import { PurchaseService } from '../../../../src/core/services/purchase.service.js';
import { SubscriptionService } from '../../../../src/core/services/subscription.service.js';
import { FakePaymentProvider } from '../../../fakes/fake-payment-provider.js';
import {
  createWorld,
  givenCreator,
  givenPlan,
  givenPublishedDrop,
  givenUser,
  type TestWorld,
} from '../../../fakes/world.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const setup = (world: TestWorld = createWorld()) => {
  const provider = new FakePaymentProvider();
  const purchases = new PurchaseService(world.uow, provider, world.access, world.audit, world.clock);
  const service = new SubscriptionService(world.uow, purchases, world.audit, world.clock);
  return { world, provider, purchases, service };
};

describe('SubscriptionService.subscribe', () => {
  it('activates: payment + purchase(plan) + active subscription expiring now + duration', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator, 30, 500);
    const user = await givenUser(world);
    const now = world.clock.now();

    const result = await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 's1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.renewed).toBe(false);
    expect(result.value.subscription.status).toBe('active');
    expect(result.value.subscription.expiresAt.getTime()).toBe(now.getTime() + 30 * DAY_MS);
    expect(result.value.purchase.planId).toBe(plan.id);
    expect(result.value.purchase.dropId).toBeNull();
    expect(result.value.payment.amountStars).toBe(500);

    expect(world.store.state.auditLogs.map((e) => e.action)).toEqual(
      expect.arrayContaining(['payment.succeeded', 'purchase.completed', 'subscription.activated']),
    );
    expect(world.uow.dispatchedEvents.map((e) => e.type)).toEqual([
      'PurchaseCompleted',
      'SubscriptionActivated',
    ]);
  });

  it('subscription unlocks premium content', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator);
    const drop = await givenPublishedDrop(world, creator, 'premium');
    const user = await givenUser(world);

    await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 's' });

    const decision = await world.access.canAccess(world.store.repos, user.id, drop.id);
    expect(decision).toMatchObject({ allowed: true, basis: 'subscription' });
  });

  it('renews: extends the active subscription from its current expiry (no second row)', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator, 30);
    const user = await givenUser(world);

    const first = await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 'a' });
    world.clock.advanceDays(10); // renew mid-term
    const second = await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 'b' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.renewed).toBe(true);
    expect(second.value.subscription.id).toBe(first.value.subscription.id);
    // extended from the ORIGINAL expiry, not from now — the remaining 20 days are kept
    expect(second.value.subscription.expiresAt.getTime()).toBe(
      first.value.subscription.expiresAt.getTime() + 30 * DAY_MS,
    );
    expect(world.store.state.subscriptions).toHaveLength(1);
    expect(world.store.state.auditLogs.map((e) => e.action)).toContain('subscription.renewed');
  });

  it('renewing an active-but-lapsed row extends from now (never shortchanges)', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator, 30);
    const user = await givenUser(world);

    await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 'a' });
    world.clock.advanceDays(45); // lapsed, sweep hasn't run
    const renewal = await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 'b' });

    expect(renewal.ok).toBe(true);
    if (!renewal.ok) return;
    expect(renewal.value.subscription.expiresAt.getTime()).toBe(
      world.clock.now().getTime() + 30 * DAY_MS,
    );
  });

  it('payment failure leaves no subscription and raises PaymentFailed', async () => {
    const { world, provider, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator);
    const user = await givenUser(world);
    provider.failNext('declined');

    const result = await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 's' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('payment_failed');
    expect(world.store.state.subscriptions).toHaveLength(0);
    expect(world.store.state.payments[0]?.status).toBe('failed');
    expect(world.uow.dispatchedEvents.map((e) => e.type)).toEqual(['PaymentFailed']);
  });

  it('replays return the original outcome without a second charge', async () => {
    const { world, provider, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator);
    const user = await givenUser(world);

    const first = await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 'dup' });
    const calls = provider.calls.length;
    const replay = await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 'dup' });

    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value.subscription.id).toBe(first.value.subscription.id);
    expect(provider.calls.length).toBe(calls);
    expect(world.store.state.payments).toHaveLength(1);
    expect(world.store.state.subscriptions).toHaveLength(1);
  });

  it('rejects retired or unknown plans', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const retired = await world.store.repos.plans.create({
      creatorId: creator.id,
      name: 'Old',
      priceStars: 100,
      durationDays: 30,
      status: 'retired',
    });
    const user = await givenUser(world);

    const result = await service.subscribe({ userId: user.id, planId: retired.id, idempotencyKey: 'k' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });
});

describe('SubscriptionService.expireLapsed — the sweep', () => {
  it('flips only lapsed actives, audits as job, raises SubscriptionExpired per row', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator, 30);
    const lapsedUser = await givenUser(world);
    const activeUser = await givenUser(world);
    await service.subscribe({ userId: lapsedUser.id, planId: plan.id, idempotencyKey: 'l' });
    world.clock.advanceDays(15);
    await service.subscribe({ userId: activeUser.id, planId: plan.id, idempotencyKey: 'a' });
    world.clock.advanceDays(20); // lapsedUser at day 35 (expired), activeUser at day 35 of 45
    world.uow.dispatchedEvents.length = 0;

    const expired = await service.expireLapsed(100, 'sweep-1');

    expect(expired).toBe(1);
    const subs = world.store.state.subscriptions;
    expect(subs.find((s) => s.userId === lapsedUser.id)?.status).toBe('expired');
    expect(subs.find((s) => s.userId === activeUser.id)?.status).toBe('active');

    const auditRow = world.store.state.auditLogs.find((e) => e.action === 'subscription.expired');
    expect(auditRow?.actorType).toBe('job');
    expect(auditRow?.correlationId).toBe('sweep-1');
    expect(world.uow.dispatchedEvents.map((e) => e.type)).toEqual(['SubscriptionExpired']);
  });

  it('expiration revokes premium access (live check goes false)', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator, 30);
    const drop = await givenPublishedDrop(world, creator, 'premium');
    const user = await givenUser(world);
    await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 's' });

    world.clock.advanceDays(31);
    await service.expireLapsed();

    const decision = await world.access.canAccess(world.store.repos, user.id, drop.id);
    expect(decision).toMatchObject({ allowed: false, reason: 'requires_subscription' });
  });

  it('is idempotent — a second sweep finds nothing', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator, 30);
    const user = await givenUser(world);
    await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 's' });
    world.clock.advanceDays(31);

    expect(await service.expireLapsed()).toBe(1);
    expect(await service.expireLapsed()).toBe(0);
    expect(
      world.store.state.auditLogs.filter((e) => e.action === 'subscription.expired'),
    ).toHaveLength(1);
  });

  it('re-subscribing after expiry creates a fresh active subscription', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const plan = await givenPlan(world, creator, 30);
    const user = await givenUser(world);
    const first = await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 'a' });
    world.clock.advanceDays(31);
    await service.expireLapsed();

    const second = await service.subscribe({ userId: user.id, planId: plan.id, idempotencyKey: 'b' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.renewed).toBe(false);
    expect(second.value.subscription.id).not.toBe(first.value.subscription.id);
    expect(world.store.state.subscriptions).toHaveLength(2);
  });
});
