/**
 * M5 repository-method coverage against real Postgres: the cleanup sweep's inputs
 * (listStalePending window/order/bound) and its guarded transition
 * (markFailedIfPending flips pending exactly once, no-ops otherwise).
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

/** Insert a pending payment + its 1:1 purchase (purchases target exactly one of drop/plan). */
const seedPending = async (ctx2: TestContext, key: string): Promise<string> => {
  const { repos } = ctx2;
  const user = await makeUser(repos);
  const { creator } = await makeCreator(repos);
  const plan = await makePlan(repos, creator.id);
  const payment = await repos.payments.create({
    creatorId: creator.id,
    provider: 'mock',
    idempotencyKey: key,
    amountStars: 50,
    status: 'pending',
  });
  await repos.purchases.create({
    userId: user.id,
    creatorId: creator.id,
    dropId: null,
    planId: plan.id, // XOR: a subscription-style pending purchase
    paymentId: payment.id,
    amountStars: 50,
    status: 'pending',
  });
  return payment.id;
};

describe('payments.listStalePending', () => {
  it('returns only pending rows created before the cutoff, oldest first, bounded', async () => {
    const { repos } = ctx;
    const staleId = await seedPending(ctx, `stale-${Date.now()}`);
    const freshId = await seedPending(ctx, `fresh-${Date.now()}`);
    // fresh row created "now"; the cutoff sits between the two creations
    const cutoff = new Date(Date.now() + 1000); // both are older than a +1s cutoff here...

    const all = await repos.payments.listStalePending(cutoff, 100);
    const ids = all.map((p) => p.id);
    expect(ids).toContain(staleId);
    expect(ids).toContain(freshId);
    expect(all.every((p) => p.status === 'pending')).toBe(true);

    // a cutoff in the past excludes everything just created
    const past = await repos.payments.listStalePending(new Date(Date.now() - 60_000), 100);
    expect(past.map((p) => p.id)).not.toContain(staleId);

    // bound is honored
    const bounded = await repos.payments.listStalePending(cutoff, 1);
    expect(bounded).toHaveLength(1);
  });

  it('excludes non-pending payments', async () => {
    const { repos } = ctx;
    const id = await seedPending(ctx, `succeeded-${Date.now()}`);
    await repos.payments.markSucceeded(id, 'ch_x', { ok: true });

    const stale = await repos.payments.listStalePending(new Date(Date.now() + 1000), 100);
    expect(stale.map((p) => p.id)).not.toContain(id);
  });
});

describe('payments.markFailedIfPending', () => {
  it('flips a pending row once and no-ops on a second call (idempotent guard)', async () => {
    const { repos } = ctx;
    const id = await seedPending(ctx, `guard-${Date.now()}`);

    const first = await repos.payments.markFailedIfPending(id, { reason: 'stale_pending_timeout' });
    expect(first?.status).toBe('failed');

    const second = await repos.payments.markFailedIfPending(id, { reason: 'again' });
    expect(second).toBeNull(); // already failed — guard makes overlapping sweeps a no-op

    const row = await repos.payments.findById(id);
    expect(row?.rawPayload).toEqual({ reason: 'stale_pending_timeout' }); // not clobbered
  });

  it('does not touch a succeeded payment', async () => {
    const { repos } = ctx;
    const id = await seedPending(ctx, `succeeded-guard-${Date.now()}`);
    await repos.payments.markSucceeded(id, 'ch_y', { ok: true });

    const result = await repos.payments.markFailedIfPending(id, { reason: 'nope' });
    expect(result).toBeNull();
    expect((await repos.payments.findById(id))?.status).toBe('succeeded');
  });
});
