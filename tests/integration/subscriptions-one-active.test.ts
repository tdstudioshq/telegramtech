/** DB constraint: partial unique (user_id, creator_id) WHERE status='active' (DATABASE.md §6, M7.3.1). */
import { afterAll, describe, expect, it } from 'vitest';
import { connect, expectUniqueViolation, makeCreator, makePlan, makeUser } from './helpers.js';

const ctx = connect();
afterAll(() => ctx.db.close());

const DAY = 24 * 60 * 60 * 1000;

describe('one active subscription per (user, creator)', () => {
  it('rejects a second ACTIVE subscription for the same user and plan', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const plan = await makePlan(ctx.repos, creator.id);
    const user = await makeUser(ctx.repos);
    const now = new Date();

    await ctx.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: now,
      expiresAt: new Date(now.getTime() + 30 * DAY),
    });

    await expectUniqueViolation(
      ctx.repos.subscriptions.create({
        userId: user.id,
        planId: plan.id,
        creatorId: creator.id,
        status: 'active',
        startedAt: now,
        expiresAt: new Date(now.getTime() + 60 * DAY),
      }),
    );
  });

  it('rejects a second ACTIVE subscription for the same creator but a DIFFERENT plan', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const plan1 = await makePlan(ctx.repos, creator.id);
    const plan2 = await makePlan(ctx.repos, creator.id);
    const user = await makeUser(ctx.repos);
    const now = new Date();

    await ctx.repos.subscriptions.create({
      userId: user.id,
      planId: plan1.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: now,
      expiresAt: new Date(now.getTime() + 30 * DAY),
    });

    // Previously allowed (index was per-plan) — now rejected: entitlement is per-creator.
    await expectUniqueViolation(
      ctx.repos.subscriptions.create({
        userId: user.id,
        planId: plan2.id,
        creatorId: creator.id,
        status: 'active',
        startedAt: now,
        expiresAt: new Date(now.getTime() + 60 * DAY),
      }),
    );
  });

  it('allows a new active subscription after the previous one is expired (re-subscribe)', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const plan = await makePlan(ctx.repos, creator.id);
    const user = await makeUser(ctx.repos);
    const now = new Date();

    await ctx.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'expired',
      startedAt: new Date(now.getTime() - 60 * DAY),
      expiresAt: new Date(now.getTime() - 30 * DAY),
    });

    await expect(
      ctx.repos.subscriptions.create({
        userId: user.id,
        planId: plan.id,
        creatorId: creator.id,
        status: 'active',
        startedAt: now,
        expiresAt: new Date(now.getTime() + 30 * DAY),
      }),
    ).resolves.toMatchObject({ status: 'active' });
  });
});
