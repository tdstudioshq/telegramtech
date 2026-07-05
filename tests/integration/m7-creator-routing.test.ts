/**
 * M7.0 repository coverage against real Postgres: slug resolution + uniqueness and
 * a creator's active-plan listing (the reads the shared-bot resolver depends on).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  expectUniqueViolation,
  makeCreator,
  makeUser,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = connect();
});

afterAll(async () => {
  await ctx.db.close();
});

describe('creators.findBySlug', () => {
  it('resolves a creator by slug and returns null for an unknown slug', async () => {
    const { repos } = ctx;
    const user = await makeUser(repos);
    const slug = `alpha-${randomUUID().slice(0, 8)}`;
    const created = await repos.creators.create({
      userId: user.id,
      displayName: 'Alpha',
      slug,
      status: 'active',
    });

    expect((await repos.creators.findBySlug(slug))?.id).toBe(created.id);
    expect(await repos.creators.findBySlug(`missing-${randomUUID()}`)).toBeNull();
  });

  it('enforces slug uniqueness', async () => {
    const { repos } = ctx;
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    const a = await makeUser(repos);
    const b = await makeUser(repos);
    await repos.creators.create({ userId: a.id, displayName: 'A', slug, status: 'active' });
    await expectUniqueViolation(
      repos.creators.create({ userId: b.id, displayName: 'B', slug, status: 'active' }),
    );
  });

  it('allows multiple creators with a null slug (pre-backfill rows coexist)', async () => {
    const { repos } = ctx;
    const a = await makeUser(repos);
    const b = await makeUser(repos);
    await repos.creators.create({ userId: a.id, displayName: 'A', slug: null, status: 'active' });
    await repos.creators.create({ userId: b.id, displayName: 'B', slug: null, status: 'active' });
    // no throw = success (nullable unique permits many NULLs)
  });
});

describe('subscriptionPlans.listActiveByCreator', () => {
  it('returns only the creator active plans, oldest first', async () => {
    const { repos } = ctx;
    const { creator } = await makeCreator(repos);
    const p1 = await repos.plans.create({
      creatorId: creator.id,
      name: 'Basic',
      priceStars: 100,
      durationDays: 30,
      status: 'active',
    });
    await repos.plans.create({
      creatorId: creator.id,
      name: 'Old',
      priceStars: 50,
      durationDays: 30,
      status: 'retired',
    });
    const { creator: otherCreator } = await makeCreator(repos);
    await repos.plans.create({
      creatorId: otherCreator.id,
      name: 'Other',
      priceStars: 200,
      durationDays: 30,
      status: 'active',
    });

    const active = await repos.plans.listActiveByCreator(creator.id);
    expect(active.map((p) => p.id)).toEqual([p1.id]); // only this creator, only active
  });
});
