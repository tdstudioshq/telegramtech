/**
 * M7.1 repository coverage on real Postgres (migration 0002): creator identity +
 * session reads/writes, nullable-userId creators, email/creator uniqueness, and the
 * analytics aggregate reads.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, expectUniqueViolation, makeCreator, makeUser, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = connect();
});

afterAll(async () => {
  await ctx.db.close();
});

describe('creator identities + sessions', () => {
  it('creates a web creator with no Telegram user, its identity, and a session', async () => {
    const { repos } = ctx;
    const creator = await repos.creators.create({ displayName: 'Web Creator', status: 'active' });
    expect(creator.userId).toBeNull(); // nullable since M7.1

    const email = `ada-${randomUUID().slice(0, 8)}@example.com`;
    const identity = await repos.creatorIdentities.create({
      creatorId: creator.id,
      email,
      passwordHash: 'scrypt$16384$aa$bb',
    });
    expect((await repos.creatorIdentities.findByEmail(email))?.id).toBe(identity.id);

    const tokenHash = randomUUID();
    const session = await repos.sessions.create({
      identityId: identity.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await repos.sessions.findByTokenHash(tokenHash))?.id).toBe(session.id);
    await repos.sessions.deleteByTokenHash(tokenHash);
    expect(await repos.sessions.findByTokenHash(tokenHash)).toBeNull();
  });

  it('enforces unique email and one identity per creator', async () => {
    const { repos } = ctx;
    const c1 = await repos.creators.create({ displayName: 'C1', status: 'active' });
    const c2 = await repos.creators.create({ displayName: 'C2', status: 'active' });
    const email = `dup-${randomUUID().slice(0, 8)}@example.com`;
    await repos.creatorIdentities.create({ creatorId: c1.id, email, passwordHash: 'h' });

    await expectUniqueViolation(
      repos.creatorIdentities.create({ creatorId: c2.id, email, passwordHash: 'h' }),
    );
    await expectUniqueViolation(
      repos.creatorIdentities.create({
        creatorId: c1.id,
        email: `other-${randomUUID().slice(0, 8)}@example.com`,
        passwordHash: 'h',
      }),
    );
  });
});

describe('creators.update + analytics aggregates', () => {
  it('patches profile fields', async () => {
    const { repos } = ctx;
    const creator = await repos.creators.create({ displayName: 'Before', status: 'active' });
    const updated = await repos.creators.update(creator.id, { displayName: 'After', bio: 'hi' });
    expect(updated.displayName).toBe('After');
    expect(updated.bio).toBe('hi');
  });

  it('marks onboarding complete (M7.2 column)', async () => {
    const { repos } = ctx;
    const creator = await repos.creators.create({ displayName: 'Newbie', status: 'active' });
    expect(creator.onboardingCompletedAt).toBeNull();
    const updated = await repos.creators.markOnboarded(creator.id, new Date());
    expect(updated.onboardingCompletedAt).not.toBeNull();
  });

  it('aggregates completed sales + counts active subscribers', async () => {
    const { repos } = ctx;
    const user = await makeUser(repos);
    const { creator } = await makeCreator(repos);
    const plan = await repos.plans.create({
      creatorId: creator.id,
      name: `Plan-${randomUUID().slice(0, 6)}`,
      priceStars: 100,
      durationDays: 30,
      status: 'active',
    });
    const payment = await repos.payments.create({
      creatorId: creator.id,
      provider: 'mock',
      idempotencyKey: `agg-${randomUUID()}`,
      amountStars: 50,
      status: 'succeeded',
    });
    await repos.purchases.create({
      userId: user.id,
      creatorId: creator.id,
      planId: plan.id,
      paymentId: payment.id,
      amountStars: 50,
      status: 'completed',
    });
    await repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const sales = await repos.purchases.aggregateByCreator(creator.id);
    expect(sales).toEqual({ completedSales: 1, revenueStars: 50 });
    expect(await repos.subscriptions.countActiveByCreator(creator.id, new Date())).toBe(1);
    expect((await repos.plans.listByCreator(creator.id)).length).toBe(1);
  });
});
