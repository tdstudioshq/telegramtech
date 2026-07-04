/**
 * PurchaseService.failStalePending — the stale-pending cleanup sweep (M5).
 * Covers: fails only stale pending pairs, audits as `job`, raises PaymentFailed;
 * leaves fresh/resolved rows alone; idempotent reruns (one event, no duplicate
 * notification); correlation propagation; and transactional rollback with
 * after-commit event semantics (a mid-sweep throw commits nothing and emits nothing).
 */
import { describe, expect, it } from 'vitest';
import { PurchaseService } from '../../../../src/core/services/purchase.service.js';
import { FakePaymentProvider } from '../../../fakes/fake-payment-provider.js';
import {
  createWorld,
  givenCreator,
  givenPlan,
  givenUser,
  type TestWorld,
} from '../../../fakes/world.js';

const TTL_MIN = 15;

const setup = (world: TestWorld = createWorld()) => {
  const provider = new FakePaymentProvider();
  const service = new PurchaseService(world.uow, provider, world.access, world.audit, world.clock);
  return { world, service };
};

/** Insert a pending payment+purchase pair (the TX1 half), as a crash would leave it. */
const givenPendingPair = async (world: TestWorld, service: PurchaseService, key: string) => {
  const creator = await givenCreator(world);
  const plan = await givenPlan(world, creator);
  const user = await givenUser(world);
  return world.uow.run(async (repos) =>
    service.beginAttempt(repos, {
      userId: user.id,
      creatorId: creator.id,
      dropId: null,
      planId: plan.id, // purchases target exactly one of drop/plan (XOR)
      amountStars: 50,
      idempotencyKey: key,
    }),
  );
};

describe('PurchaseService.failStalePending', () => {
  it('fails a stale pending pair, audits as job, raises PaymentFailed', async () => {
    const { world, service } = setup();
    await givenPendingPair(world, service, 'stale');
    world.clock.advanceMs(20 * 60_000);

    const failed = await service.failStalePending(TTL_MIN, 100, 'cleanup-1');

    expect(failed).toBe(1);
    expect(world.store.state.payments[0]?.status).toBe('failed');
    expect(world.store.state.purchases[0]?.status).toBe('failed');
    const actions = world.store.state.auditLogs.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['payment.failed', 'purchase.failed']));
    const row = world.store.state.auditLogs.find((e) => e.action === 'payment.failed');
    expect(row?.actorType).toBe('job');
    expect(row?.actorUserId).toBeNull();
    expect(row?.correlationId).toBe('cleanup-1');
    expect(world.uow.dispatchedEvents.map((e) => e.type)).toEqual(['PaymentFailed']);
  });

  it('leaves pending pairs that are still within the TTL untouched', async () => {
    const { world, service } = setup();
    await givenPendingPair(world, service, 'fresh');
    world.clock.advanceMs(5 * 60_000); // younger than the 15-minute TTL

    const failed = await service.failStalePending(TTL_MIN);

    expect(failed).toBe(0);
    expect(world.store.state.payments[0]?.status).toBe('pending');
    expect(world.uow.dispatchedEvents).toHaveLength(0);
  });

  it('ignores already-resolved payments', async () => {
    const { world, service } = setup();
    const { payment } = await givenPendingPair(world, service, 'done');
    await world.uow.run(async (repos) => repos.payments.markSucceeded(payment.id, 'ch', {}));
    world.clock.advanceMs(20 * 60_000);

    const failed = await service.failStalePending(TTL_MIN);

    expect(failed).toBe(0);
    expect(world.store.state.payments[0]?.status).toBe('succeeded');
  });

  it('is idempotent — a second sweep finds nothing and raises no second event', async () => {
    const { world, service } = setup();
    await givenPendingPair(world, service, 'stale');
    world.clock.advanceMs(20 * 60_000);

    expect(await service.failStalePending(TTL_MIN)).toBe(1);
    expect(await service.failStalePending(TTL_MIN)).toBe(0);

    expect(world.uow.dispatchedEvents.filter((e) => e.type === 'PaymentFailed')).toHaveLength(1);
    expect(world.store.state.auditLogs.filter((e) => e.action === 'payment.failed')).toHaveLength(1);
  });

  it('rolls the whole sweep back on a mid-batch invariant violation (nothing commits or dispatches)', async () => {
    const { world, service } = setup();
    // one valid stale pending pair (processed first, asc by created_at) ...
    await givenPendingPair(world, service, 'valid');
    // ... then a lone stale payment with no purchase row — the invariant guard throws
    const creator = world.store.state.creators[0];
    if (creator === undefined) throw new Error('fixture missing creator');
    world.clock.advanceMs(1);
    await world.uow.run(async (repos) =>
      repos.payments.create({
        creatorId: creator.id,
        provider: 'mock',
        idempotencyKey: 'lone',
        amountStars: 10,
        status: 'pending',
      }),
    );
    world.clock.advanceMs(20 * 60_000);

    await expect(service.failStalePending(TTL_MIN)).rejects.toThrow(/no purchase row/);

    // the valid pair's flip was rolled back with the transaction ...
    expect(world.store.state.payments.every((p) => p.status === 'pending')).toBe(true);
    expect(world.store.state.auditLogs).toHaveLength(0);
    // ... and a rolled-back transaction never dispatches (after-commit guarantee)
    expect(world.uow.dispatchedEvents).toHaveLength(0);
  });
});
