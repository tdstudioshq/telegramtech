/**
 * M3 repository-method coverage against real Postgres: the mutation methods the
 * core services rely on (mark*, renew, listLapsed, publish, setBlocked) and
 * their guard semantics.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, makeCreator, makePlan, makeUser, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = connect();
});

afterAll(async () => {
  await ctx.db.close();
});

describe('payment/purchase state transitions', () => {
  it('markSucceeded records charge id + payload; markCompleted flips the purchase', async () => {
    const { repos } = ctx;
    const user = await makeUser(repos);
    const { creator } = await makeCreator(repos);
    const drop = await repos.drops.create({
      creatorId: creator.id,
      title: 'M3 target drop',
      accessType: 'pay_per_unlock',
      priceStars: 50,
      status: 'published',
      publishedAt: new Date(),
    });
    const payment = await repos.payments.create({
      creatorId: creator.id,
      provider: 'mock',
      idempotencyKey: `m3-ok-${user.id}`,
      amountStars: 50,
      status: 'pending',
    });
    const purchase = await repos.purchases.create({
      userId: user.id,
      creatorId: creator.id,
      dropId: drop.id, // purchases target exactly one of drop/plan (XOR CHECK)
      paymentId: payment.id,
      amountStars: 50,
      status: 'pending',
    });

    const succeeded = await repos.payments.markSucceeded(payment.id, 'ch_1', { ok: true });
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.providerChargeId).toBe('ch_1');
    expect(succeeded.rawPayload).toEqual({ ok: true });

    const completed = await repos.purchases.markCompleted(purchase.id);
    expect(completed.status).toBe('completed');

    expect((await repos.purchases.findByPaymentId(payment.id))?.id).toBe(purchase.id);
  });

  it('markFailed flips both rows and keeps the failure payload', async () => {
    const { repos } = ctx;
    const user = await makeUser(repos);
    const { creator } = await makeCreator(repos);
    const plan = await makePlan(repos, creator.id);
    const payment = await repos.payments.create({
      creatorId: creator.id,
      provider: 'mock',
      idempotencyKey: `m3-fail-${user.id}`,
      amountStars: 50,
      status: 'pending',
    });
    const purchase = await repos.purchases.create({
      userId: user.id,
      creatorId: creator.id,
      planId: plan.id, // XOR CHECK: plan-targeted this time
      paymentId: payment.id,
      amountStars: 50,
      status: 'pending',
    });

    expect((await repos.payments.markFailed(payment.id, { reason: 'declined' })).status).toBe(
      'failed',
    );
    expect((await repos.purchases.markFailed(purchase.id)).status).toBe('failed');
  });
});

describe('subscription lifecycle methods', () => {
  it('findActive → renew extends expiry; listLapsed + markExpired drive the sweep', async () => {
    const { repos } = ctx;
    const user = await makeUser(repos);
    const { creator } = await makeCreator(repos);
    const plan = await makePlan(repos, creator.id);
    const now = new Date();
    const sub = await repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: now,
      expiresAt: new Date(now.getTime() - 1000), // already lapsed
    });

    const found = await repos.subscriptions.findActiveForUserAndCreator(user.id, creator.id);
    expect(found?.id).toBe(sub.id);

    const lapsed = await repos.subscriptions.listLapsed(now, 100);
    expect(lapsed.map((s) => s.id)).toContain(sub.id);

    const newExpiry = new Date(now.getTime() + 3_600_000);
    const renewed = await repos.subscriptions.renew(sub.id, newExpiry);
    expect(renewed.expiresAt.getTime()).toBe(newExpiry.getTime());
    expect(renewed.status).toBe('active');

    expect(await repos.subscriptions.markExpired(sub.id)).toBe(true);
    // idempotent: the second flip is a no-op (status guard)
    expect(await repos.subscriptions.markExpired(sub.id)).toBe(false);
    expect(
      await repos.subscriptions.findActiveForUserAndCreator(user.id, creator.id),
    ).toBeNull();
  });

  it('renew refuses non-active rows (guard is part of the WHERE)', async () => {
    const { repos } = ctx;
    const user = await makeUser(repos);
    const { creator } = await makeCreator(repos);
    const plan = await makePlan(repos, creator.id);
    const now = new Date();
    const sub = await repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: now,
      expiresAt: now,
    });
    await repos.subscriptions.markExpired(sub.id);

    await expect(repos.subscriptions.renew(sub.id, new Date())).rejects.toThrow();
  });
});

describe('drops.publish and users.setBlocked', () => {
  it('publish stamps status + published_at', async () => {
    const { repos } = ctx;
    const { creator } = await makeCreator(repos);
    const draft = await repos.drops.create({
      creatorId: creator.id,
      title: 'M3 publish test',
      accessType: 'free',
      status: 'draft',
    });

    const at = new Date('2026-07-04T12:00:00Z');
    const published = await repos.drops.publish(draft.id, at);

    expect(published.status).toBe('published');
    expect(published.publishedAt?.getTime()).toBe(at.getTime());
  });

  it('setBlocked round-trips', async () => {
    const { repos } = ctx;
    const user = await makeUser(repos);

    await repos.users.setBlocked(user.id, true);
    expect((await repos.users.findById(user.id))?.isBlocked).toBe(true);

    await repos.users.setBlocked(user.id, false);
    expect((await repos.users.findById(user.id))?.isBlocked).toBe(false);
  });
});
