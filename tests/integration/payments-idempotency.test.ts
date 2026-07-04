/** DB constraint: unique idempotency_key absorbs double-taps (DATABASE.md §8). */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { connect, expectUniqueViolation, makeCreator } from './helpers.js';

const ctx = connect();
afterAll(() => ctx.db.close());

describe('payments idempotency uniqueness', () => {
  it('rejects a second payment with the same idempotency_key', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const idempotencyKey = `idem-${randomUUID()}`;

    await ctx.repos.payments.create({
      creatorId: creator.id,
      provider: 'mock',
      idempotencyKey,
      amountStars: 50,
      status: 'pending',
    });

    await expectUniqueViolation(
      ctx.repos.payments.create({
        creatorId: creator.id,
        provider: 'mock',
        idempotencyKey,
        amountStars: 50,
        status: 'pending',
      }),
    );
  });

  it('findByIdempotencyKey returns the existing payment (fast-path lookup)', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const idempotencyKey = `idem-${randomUUID()}`;
    const created = await ctx.repos.payments.create({
      creatorId: creator.id,
      provider: 'mock',
      idempotencyKey,
      amountStars: 75,
      status: 'succeeded',
    });

    const found = await ctx.repos.payments.findByIdempotencyKey(idempotencyKey);
    expect(found?.id).toBe(created.id);
    expect(found?.currency).toBe('XTR');
  });
});
