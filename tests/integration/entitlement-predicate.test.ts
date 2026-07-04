/**
 * The premium entitlement predicate (ADR-011): EXISTS active subscription for
 * (user, creator) with expires_at > now. Times are fixed dates, never sleeps.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { connect, makeCreator, makePlan, makeUser } from './helpers.js';

const ctx = connect();
afterAll(() => ctx.db.close());

const T0 = new Date('2026-07-01T00:00:00Z');
const BEFORE_EXPIRY = new Date('2026-07-15T00:00:00Z');
const AT_EXPIRY = new Date('2026-07-31T00:00:00Z');
const AFTER_EXPIRY = new Date('2026-08-15T00:00:00Z');

describe('SubscriptionRepository.hasActiveForUserAndCreator', () => {
  it('is true while an active subscription has not yet expired, false at/after expiry', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const plan = await makePlan(ctx.repos, creator.id);
    const user = await makeUser(ctx.repos);
    await ctx.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: T0,
      expiresAt: AT_EXPIRY,
    });

    const { subscriptions } = ctx.repos;
    expect(await subscriptions.hasActiveForUserAndCreator(user.id, creator.id, BEFORE_EXPIRY)).toBe(
      true,
    );
    // strict >: exactly at expires_at the subscription no longer entitles
    expect(await subscriptions.hasActiveForUserAndCreator(user.id, creator.id, AT_EXPIRY)).toBe(
      false,
    );
    expect(await subscriptions.hasActiveForUserAndCreator(user.id, creator.id, AFTER_EXPIRY)).toBe(
      false,
    );
  });

  it('ignores subscriptions whose status is not active, even with a future expires_at', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const plan = await makePlan(ctx.repos, creator.id);
    const user = await makeUser(ctx.repos);
    await ctx.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'expired', // status flip is what the sweep does — predicate must respect it
      startedAt: T0,
      expiresAt: AFTER_EXPIRY,
    });

    expect(
      await ctx.repos.subscriptions.hasActiveForUserAndCreator(user.id, creator.id, BEFORE_EXPIRY),
    ).toBe(false);
  });

  it('is scoped to the creator — a subscription to creator A grants nothing at creator B', async () => {
    const { creator: creatorA } = await makeCreator(ctx.repos);
    const { creator: creatorB } = await makeCreator(ctx.repos);
    const plan = await makePlan(ctx.repos, creatorA.id);
    const user = await makeUser(ctx.repos);
    await ctx.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creatorA.id,
      status: 'active',
      startedAt: T0,
      expiresAt: AT_EXPIRY,
    });

    const { subscriptions } = ctx.repos;
    expect(
      await subscriptions.hasActiveForUserAndCreator(user.id, creatorA.id, BEFORE_EXPIRY),
    ).toBe(true);
    expect(
      await subscriptions.hasActiveForUserAndCreator(user.id, creatorB.id, BEFORE_EXPIRY),
    ).toBe(false);
  });
});
