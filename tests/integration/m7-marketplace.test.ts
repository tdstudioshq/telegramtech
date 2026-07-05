/**
 * M7.3 repository coverage on real Postgres (migration 0004): follows (idempotent,
 * join, count) and the discovery reads (discoverable predicate, search, category,
 * featured, categories).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, makeCreator, makeUser, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = connect();
});

afterAll(async () => {
  await ctx.db.close();
});

/** A fully discoverable creator (active + slug + onboarded), optionally featured. */
const makeDiscoverable = async (
  ctx2: TestContext,
  opts: { category?: string; featured?: boolean } = {},
) => {
  const user = await makeUser(ctx2.repos);
  return ctx2.repos.creators.create({
    userId: user.id,
    displayName: `Creator ${randomUUID().slice(0, 6)}`,
    slug: `slug-${randomUUID().slice(0, 8)}`,
    category: opts.category ?? null,
    isFeatured: opts.featured ?? false,
    onboardingCompletedAt: new Date(),
    status: 'active',
  });
};

describe('follows', () => {
  it('is idempotent, joins to creators, and counts', async () => {
    const { repos } = ctx;
    const user = await makeUser(repos);
    const { creator } = await makeCreator(repos);

    await repos.follows.create({ userId: user.id, creatorId: creator.id });
    await repos.follows.create({ userId: user.id, creatorId: creator.id }); // no-op
    expect(await repos.follows.exists(user.id, creator.id)).toBe(true);
    expect(await repos.follows.countByCreator(creator.id)).toBe(1);
    expect((await repos.follows.listCreatorsByUser(user.id)).map((c) => c.id)).toContain(creator.id);

    await repos.follows.delete(user.id, creator.id);
    expect(await repos.follows.exists(user.id, creator.id)).toBe(false);
  });
});

describe('discovery reads', () => {
  it('lists discoverable creators with search/category/featured and categories', async () => {
    const { repos } = ctx;
    const cat = `Cat-${randomUUID().slice(0, 6)}`;
    const featured = await makeDiscoverable(ctx, { category: cat, featured: true });
    await makeDiscoverable(ctx, { category: cat });
    // non-discoverable control: active + slug but NOT onboarded
    const notOnboardedUser = await makeUser(repos);
    const hidden = await repos.creators.create({
      userId: notOnboardedUser.id,
      displayName: 'Hidden',
      slug: `hidden-${randomUUID().slice(0, 8)}`,
      status: 'active',
    });

    const byCategory = await repos.creators.listDiscoverable({ category: cat, limit: 50, offset: 0 });
    expect(byCategory.length).toBe(2);
    expect(byCategory.map((c) => c.id)).not.toContain(hidden.id);
    expect(byCategory[0]?.id).toBe(featured.id); // featured first

    const bySearch = await repos.creators.listDiscoverable({
      query: featured.displayName.slice(0, 8),
      limit: 50,
      offset: 0,
    });
    expect(bySearch.map((c) => c.id)).toContain(featured.id);

    expect((await repos.creators.listFeatured(50)).map((c) => c.id)).toContain(featured.id);
    expect(await repos.creators.listCategories()).toContain(cat);
  });
});
