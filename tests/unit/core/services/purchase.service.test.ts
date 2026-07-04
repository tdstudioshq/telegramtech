import { describe, expect, it } from 'vitest';
import { PurchaseService } from '../../../../src/core/services/purchase.service.js';
import { FakePaymentProvider } from '../../../fakes/fake-payment-provider.js';
import {
  createWorld,
  givenCreator,
  givenPublishedDrop,
  givenUser,
  type TestWorld,
} from '../../../fakes/world.js';

const setup = (world: TestWorld = createWorld()) => {
  const provider = new FakePaymentProvider();
  const service = new PurchaseService(world.uow, provider, world.access, world.audit, world.clock);
  return { world, provider, service };
};

describe('PurchaseService.purchaseDrop — happy path', () => {
  it('completes payment, purchase, grant, audit rows, and after-commit events', async () => {
    const { world, provider, service } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const user = await givenUser(world);

    const result = await service.purchaseDrop({
      userId: user.id,
      dropId: drop.id,
      idempotencyKey: 'key-1',
      correlationId: 'corr-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payment.status).toBe('succeeded');
    expect(result.value.payment.providerChargeId).toBe('fake_ch_key-1');
    expect(result.value.purchase.status).toBe('completed');
    expect(result.value.grant?.grantType).toBe('purchase');
    expect(result.value.grant?.sourcePurchaseId).toBe(result.value.purchase.id);

    // real lifecycle order (ADR-005)
    expect(provider.calls).toEqual(['createIntent', 'awaitApproval', 'confirm']);

    // audit rows written in-transaction
    const actions = world.store.state.auditLogs.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['payment.succeeded', 'purchase.completed', 'grant.created']),
    );
    expect(world.store.state.auditLogs.every((e) => e.correlationId === 'corr-1')).toBe(true);

    // events dispatched strictly after commit
    expect(world.uow.dispatchedEvents.map((e) => e.type)).toEqual([
      'PurchaseCompleted',
      'ContentUnlocked',
    ]);
  });

  it('entitlement flips: the user can access the drop after purchase', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const user = await givenUser(world);

    await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'k' });

    const decision = await world.access.canAccess(world.store.repos, user.id, drop.id);
    expect(decision).toMatchObject({ allowed: true, basis: 'grant' });
  });
});

describe('PurchaseService.purchaseDrop — failure path', () => {
  it('marks payment+purchase failed, audits, raises PaymentFailed, mints no grant', async () => {
    const { world, provider, service } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const user = await givenUser(world);
    provider.failNext('card_declined');

    const result = await service.purchaseDrop({
      userId: user.id,
      dropId: drop.id,
      idempotencyKey: 'key-f',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('payment_failed');
    expect(result.error.message).toContain('not been charged');

    expect(world.store.state.payments[0]?.status).toBe('failed');
    expect(world.store.state.purchases[0]?.status).toBe('failed');
    expect(world.store.state.accessGrants).toHaveLength(0);
    expect(world.store.state.auditLogs.map((e) => e.action)).toEqual(
      expect.arrayContaining(['payment.failed', 'purchase.failed']),
    );
    expect(world.uow.dispatchedEvents.map((e) => e.type)).toEqual(['PaymentFailed']);
  });

  it('a pre-checkout rejection fails the same way without calling confirm', async () => {
    const { world, provider, service } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const user = await givenUser(world);
    provider.rejectNextApproval('insufficient_stars');

    const result = await service.purchaseDrop({
      userId: user.id,
      dropId: drop.id,
      idempotencyKey: 'key-r',
    });

    expect(result.ok).toBe(false);
    expect(provider.calls).toEqual(['createIntent', 'awaitApproval']);
    expect(world.store.state.payments[0]?.status).toBe('failed');
  });
});

describe('PurchaseService.purchaseDrop — idempotency', () => {
  it('a replayed key returns the original success without charging again', async () => {
    const { world, provider, service } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const user = await givenUser(world);

    const first = await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'dup' });
    const callsAfterFirst = provider.calls.length;
    const second = await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'dup' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.payment.id).toBe(first.value.payment.id);
    expect(second.value.grant?.id).toBe(first.value.grant?.id);
    expect(provider.calls.length).toBe(callsAfterFirst); // provider never re-ran
    expect(world.store.state.payments).toHaveLength(1);
  });

  it('a replayed key returns the original failure (a retry needs a fresh key)', async () => {
    const { world, provider, service } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const user = await givenUser(world);
    provider.failNext();

    await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'dup-f' });
    const replay = await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'dup-f' });

    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.code).toBe('payment_failed');
    expect(world.store.state.payments).toHaveLength(1);

    // …and a fresh key succeeds
    const retry = await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'fresh' });
    expect(retry.ok).toBe(true);
  });

  it('rejects a key that was used for a different drop', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const dropA = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const dropB = await givenPublishedDrop(world, creator, 'pay_per_unlock', 70);
    const user = await givenUser(world);

    await service.purchaseDrop({ userId: user.id, dropId: dropA.id, idempotencyKey: 'shared' });
    const reused = await service.purchaseDrop({ userId: user.id, dropId: dropB.id, idempotencyKey: 'shared' });

    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.error.code).toBe('conflict');
  });
});

describe('PurchaseService.purchaseDrop — validation short-circuits', () => {
  it('already-owned short-circuits before any payment row exists', async () => {
    const { world, provider, service } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const user = await givenUser(world);
    await world.store.repos.accessGrants.create({
      userId: user.id,
      dropId: drop.id,
      creatorId: creator.id,
      grantType: 'manual',
    });

    const result = await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'k' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('already_owned');
    expect(world.store.state.payments).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('free drops are not purchasable', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'free');
    const user = await givenUser(world);

    const result = await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'k' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // free + published means the user is already entitled — the oracle wins
    expect(result.error.code).toBe('already_owned');
  });

  it('premium drops cannot be bought per-unlock', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'premium');
    const user = await givenUser(world);

    const result = await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'k' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('validation');
    expect(world.store.state.payments).toHaveLength(0);
  });

  it('unknown drops are not found', async () => {
    const { world, service } = setup();
    const user = await givenUser(world);

    const result = await service.purchaseDrop({
      userId: user.id,
      dropId: '00000000-0000-4000-8000-000000000000',
      idempotencyKey: 'k',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });

  it('a suspended creator sells nothing', async () => {
    const { world, service } = setup();
    const owner = await givenUser(world);
    const creator = await world.store.repos.creators.create({
      userId: owner.id,
      displayName: 'Suspended',
      status: 'suspended',
    });
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const user = await givenUser(world);

    const result = await service.purchaseDrop({ userId: user.id, dropId: drop.id, idempotencyKey: 'k' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('forbidden');
    expect(world.store.state.payments).toHaveLength(0);
  });
});
