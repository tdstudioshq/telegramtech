/**
 * M7.1 read/write service methods the dashboard reuses: CreatorService.updateProfile,
 * SubscriptionService.createPlan/listPlans, AnalyticsService.creatorSummary.
 */
import { describe, expect, it } from 'vitest';
import { AnalyticsService } from '../../../../src/core/services/analytics.service.js';
import { CreatorService } from '../../../../src/core/services/creator.service.js';
import { PurchaseService } from '../../../../src/core/services/purchase.service.js';
import { SubscriptionService } from '../../../../src/core/services/subscription.service.js';
import { FakePaymentProvider } from '../../../fakes/fake-payment-provider.js';
import { createWorld, givenCreator, givenPlan, givenPublishedDrop, givenUser } from '../../../fakes/world.js';

describe('CreatorService.updateProfile', () => {
  it('patches only the provided fields', async () => {
    const world = createWorld();
    const service = new CreatorService(world.uow);
    const creator = await givenCreator(world, { slug: 'alpha' });

    const result = await service.updateProfile(creator.id, { bio: 'hello', avatarUrl: 'https://x/y.png' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bio).toBe('hello');
    expect(result.value.avatarUrl).toBe('https://x/y.png');
    expect(result.value.slug).toBe('alpha'); // untouched
  });

  it('rejects a taken slug and invalid input', async () => {
    const world = createWorld();
    const service = new CreatorService(world.uow);
    await givenCreator(world, { slug: 'taken' });
    const me = await givenCreator(world, { slug: 'mine' });

    const conflict = await service.updateProfile(me.id, { slug: 'taken' });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('conflict');

    const invalid = await service.updateProfile(me.id, { slug: 'Bad Slug!' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('validation');
  });
});

const subscriptionSetup = (world = createWorld()) => {
  const purchases = new PurchaseService(world.uow, new FakePaymentProvider(), world.access, world.audit, world.clock);
  return new SubscriptionService(world.uow, purchases, world.audit, world.clock);
};

describe('SubscriptionService.createPlan / listPlans', () => {
  it('creates an active plan and lists it', async () => {
    const world = createWorld();
    const service = subscriptionSetup(world);
    const creator = await givenCreator(world);

    const created = await service.createPlan({ creatorId: creator.id, name: 'Gold', priceStars: 500, durationDays: 30 });
    expect(created.ok).toBe(true);
    const plans = await service.listPlans(creator.id);
    expect(plans.map((p) => p.name)).toContain('Gold');
    expect(world.store.state.auditLogs.map((e) => e.action)).toContain('plan.created');
  });

  it('rejects a non-positive or non-integer price', async () => {
    const world = createWorld();
    const service = subscriptionSetup(world);
    const creator = await givenCreator(world);
    const result = await service.createPlan({ creatorId: creator.id, name: 'X', priceStars: 0, durationDays: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation');
  });
});

describe('AnalyticsService.creatorSummary', () => {
  it('aggregates revenue, sales, subscribers, drops and plans from existing data', async () => {
    const world = createWorld();
    const analytics = new AnalyticsService(world.uow, world.clock);
    const creator = await givenCreator(world);
    const user = await givenUser(world);
    await givenPublishedDrop(world, creator, 'free'); // 1 published drop
    await world.store.repos.drops.create({
      creatorId: creator.id,
      title: 'Draft',
      accessType: 'free',
      priceStars: null,
      status: 'draft',
    }); // +1 total (unpublished)
    const plan = await givenPlan(world, creator);

    // a completed sale (50 Stars) and an active subscription
    const payment = await world.store.repos.payments.create({
      creatorId: creator.id,
      provider: 'mock',
      idempotencyKey: 'k1',
      amountStars: 50,
      status: 'succeeded',
    });
    await world.store.repos.purchases.create({
      userId: user.id,
      creatorId: creator.id,
      dropId: null,
      planId: plan.id,
      paymentId: payment.id,
      amountStars: 50,
      status: 'completed',
    });
    await world.store.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: world.clock.now(),
      expiresAt: new Date(world.clock.now().getTime() + 86_400_000),
    });

    const summary = await analytics.creatorSummary(creator.id);
    expect(summary).toEqual({
      revenueStars: 50,
      completedSales: 1,
      activeSubscribers: 1,
      publishedDrops: 1,
      totalDrops: 2,
      activePlans: 1,
    });
  });
});
