/**
 * Unit of work: multi-repo transaction atomicity + events strictly after commit
 * (ADR-009/ADR-010) — the audit row lands in the same transaction as the mutation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../../src/core/events/dispatcher.js';
import { DrizzleUnitOfWork } from '../../src/adapters/persistence/db/unit-of-work.js';
import { connect, makeCreator, makeUser } from './helpers.js';

const ctx = connect();
afterAll(() => ctx.db.close());

const silentLogger = { error: () => undefined };

describe('DrizzleUnitOfWork', () => {
  it('commits payment + audit atomically and dispatches events only after commit', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const dispatcher = new EventDispatcher(silentLogger);
    const seenDuringTx: string[] = [];
    const seenAfterCommit: string[] = [];
    dispatcher.register('PaymentFailed', 'probe', (event) => {
      seenAfterCommit.push(event.paymentId);
    });

    const uow = new DrizzleUnitOfWork(ctx.db.db, dispatcher);
    const idempotencyKey = `idem-${randomUUID()}`;

    const paymentId = await uow.run(async (repos, events) => {
      const payment = await repos.payments.create({
        creatorId: creator.id,
        provider: 'mock',
        idempotencyKey,
        amountStars: 50,
        status: 'failed',
      });
      await repos.audit.append({
        creatorId: creator.id,
        action: 'payment.failed',
        entityType: 'payment',
        entityId: payment.id,
        actorType: 'system',
        context: { reason: 'mock failure' },
      });
      events.raise({
        type: 'PaymentFailed',
        paymentId: payment.id,
        purchaseId: 'not-yet-created',
        userId: 'seed-user',
        creatorId: creator.id,
        amountStars: 50,
        reason: 'mock failure',
        occurredAt: new Date(),
      });
      seenDuringTx.push(...seenAfterCommit); // snapshot: nothing must have dispatched yet
      return payment.id;
    });

    expect(seenDuringTx).toEqual([]);
    expect(seenAfterCommit).toEqual([paymentId]);
    const audit = await ctx.repos.audit.findByEntity('payment', paymentId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('payment.failed');
  });

  it('rolls back every row and never dispatches when the transaction throws', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const user = await makeUser(ctx.repos);
    const dispatcher = new EventDispatcher(silentLogger);
    let dispatched = 0;
    dispatcher.register('PaymentFailed', 'probe', () => {
      dispatched += 1;
    });

    const uow = new DrizzleUnitOfWork(ctx.db.db, dispatcher);
    const idempotencyKey = `idem-${randomUUID()}`;

    await expect(
      uow.run(async (repos, events) => {
        const payment = await repos.payments.create({
          creatorId: creator.id,
          provider: 'mock',
          idempotencyKey,
          amountStars: 50,
          status: 'pending',
        });
        events.raise({
          type: 'PaymentFailed',
          paymentId: payment.id,
          purchaseId: 'x',
          userId: user.id,
          creatorId: creator.id,
          amountStars: 50,
          reason: 'boom',
          occurredAt: new Date(),
        });
        throw new Error('simulated mid-transaction failure');
      }),
    ).rejects.toThrow('simulated mid-transaction failure');

    expect(dispatched).toBe(0);
    expect(await ctx.repos.payments.findByIdempotencyKey(idempotencyKey)).toBeNull();
  });
});
