import { describe, expect, it } from 'vitest';
import { createWorld, givenCreator, givenPlan, givenPublishedDrop, givenUser } from '../../../fakes/world.js';

describe('AccessService — the entitlement oracle', () => {
  it('allows free published drops to anyone', async () => {
    const world = createWorld();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'free');
    const user = await givenUser(world);

    const decision = await world.access.canAccess(world.store.repos, user.id, drop.id);

    expect(decision).toMatchObject({ allowed: true, basis: 'free' });
  });

  it('denies drafts as not-found — their existence never leaks', async () => {
    const world = createWorld();
    const creator = await givenCreator(world);
    const draft = await world.store.repos.drops.create({
      creatorId: creator.id,
      title: 'draft',
      accessType: 'free',
      status: 'draft',
    });
    const user = await givenUser(world);

    const decision = await world.access.canAccess(world.store.repos, user.id, draft.id);

    expect(decision).toMatchObject({ allowed: false, reason: 'drop_not_found', drop: null });
  });

  it('allows premium via a live active-subscription check', async () => {
    const world = createWorld();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'premium');
    const plan = await givenPlan(world, creator);
    const user = await givenUser(world);
    await world.store.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: world.clock.now(),
      expiresAt: new Date(world.clock.now().getTime() + 1000),
    });

    const decision = await world.access.canAccess(world.store.repos, user.id, drop.id);

    expect(decision).toMatchObject({ allowed: true, basis: 'subscription' });
  });

  it('denies premium exactly at the expiry boundary (strict >, ADR-011)', async () => {
    const world = createWorld();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'premium');
    const plan = await givenPlan(world, creator);
    const user = await givenUser(world);
    const expiresAt = new Date(world.clock.now().getTime() + 60_000);
    await world.store.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: world.clock.now(),
      expiresAt,
    });

    world.clock.set(expiresAt); // expires_at == now → NOT entitled
    const atBoundary = await world.access.canAccess(world.store.repos, user.id, drop.id);
    expect(atBoundary).toMatchObject({ allowed: false, reason: 'requires_subscription' });

    world.clock.set(new Date(expiresAt.getTime() - 1));
    const justBefore = await world.access.canAccess(world.store.repos, user.id, drop.id);
    expect(justBefore.allowed).toBe(true);
  });

  it('denies premium without any subscription', async () => {
    const world = createWorld();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'premium');
    const user = await givenUser(world);

    const decision = await world.access.canAccess(world.store.repos, user.id, drop.id);

    expect(decision).toMatchObject({ allowed: false, reason: 'requires_subscription' });
  });

  it('allows pay_per_unlock only via a live grant', async () => {
    const world = createWorld();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock');
    const user = await givenUser(world);

    const before = await world.access.canAccess(world.store.repos, user.id, drop.id);
    expect(before).toMatchObject({ allowed: false, reason: 'requires_unlock' });

    await world.store.repos.accessGrants.create({
      userId: user.id,
      dropId: drop.id,
      creatorId: creator.id,
      grantType: 'purchase',
    });
    const after = await world.access.canAccess(world.store.repos, user.id, drop.id);
    expect(after).toMatchObject({ allowed: true, basis: 'grant' });
  });

  it('denies pay_per_unlock once the grant is revoked', async () => {
    const world = createWorld();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock');
    const user = await givenUser(world);
    const grant = await world.store.repos.accessGrants.create({
      userId: user.id,
      dropId: drop.id,
      creatorId: creator.id,
      grantType: 'manual',
    });

    await world.store.repos.accessGrants.revoke(grant.id, world.clock.now());

    const decision = await world.access.canAccess(world.store.repos, user.id, drop.id);
    expect(decision).toMatchObject({ allowed: false, reason: 'requires_unlock' });
  });

  it('does NOT let a premium subscription open pay_per_unlock drops (distinct concepts)', async () => {
    const world = createWorld();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock');
    const plan = await givenPlan(world, creator);
    const user = await givenUser(world);
    await world.store.repos.subscriptions.create({
      userId: user.id,
      planId: plan.id,
      creatorId: creator.id,
      status: 'active',
      startedAt: world.clock.now(),
      expiresAt: new Date(world.clock.now().getTime() + 1000_000),
    });

    const decision = await world.access.canAccess(world.store.repos, user.id, drop.id);

    expect(decision).toMatchObject({ allowed: false, reason: 'requires_unlock' });
  });
});
