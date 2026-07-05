/**
 * DiscoveryService (M7.3) — only discoverable creators (active + slug + onboarded)
 * are exposed; featured-first ordering, search, category filter, categories list,
 * and a public profile with drops + follower count + deep-link param. DTOs must not
 * leak internal fields (userId/status).
 */
import { describe, expect, it } from 'vitest';
import { DiscoveryService } from '../../../../src/core/services/discovery.service.js';
import { createWorld, givenUser, type TestWorld } from '../../../fakes/world.js';

const seed = async (world: TestWorld) => {
  const now = world.clock.now();
  const repos = world.store.repos;
  // discoverable: active + slug + onboarded
  await repos.creators.create({ displayName: 'Alpha', slug: 'alpha', category: 'Music', isFeatured: true, onboardingCompletedAt: now, status: 'active' });
  await repos.creators.create({ displayName: 'Beta', slug: 'beta', category: 'Art', onboardingCompletedAt: now, status: 'active' });
  // NOT discoverable
  await repos.creators.create({ displayName: 'NoSlug', slug: null, onboardingCompletedAt: now, status: 'active' });
  await repos.creators.create({ displayName: 'Onboarding', slug: 'ob', onboardingCompletedAt: null, status: 'active' });
  await repos.creators.create({ displayName: 'Suspended', slug: 'susp', category: 'Music', onboardingCompletedAt: now, status: 'suspended' });
};

describe('DiscoveryService', () => {
  it('lists only discoverable creators, featured first, with no leaked fields', async () => {
    const world = createWorld();
    await seed(world);
    const discovery = new DiscoveryService(world.uow);

    const list = await discovery.list({});
    expect(list.creators.map((c) => c.slug)).toEqual(['alpha', 'beta']); // alpha featured → first
    expect(Object.keys(list.creators[0] ?? {})).not.toContain('userId');
    expect(Object.keys(list.creators[0] ?? {})).not.toContain('status');
  });

  it('filters by search and category, and lists categories/featured', async () => {
    const world = createWorld();
    await seed(world);
    const discovery = new DiscoveryService(world.uow);

    expect((await discovery.list({ query: 'alph' })).creators.map((c) => c.slug)).toEqual(['alpha']);
    expect((await discovery.list({ category: 'Art' })).creators.map((c) => c.slug)).toEqual(['beta']);
    expect((await discovery.featured()).map((c) => c.slug)).toEqual(['alpha']);
    expect(await discovery.categories()).toEqual(['Art', 'Music']); // sorted, discoverable only
  });

  it('returns a public profile with drops, follower count, and deep-link param', async () => {
    const world = createWorld();
    await seed(world);
    const discovery = new DiscoveryService(world.uow);
    const repos = world.store.repos;
    const alpha = await repos.creators.findBySlug('alpha');
    if (alpha === null) throw new Error('fixture');
    await repos.drops.create({ creatorId: alpha.id, title: 'Song', accessType: 'free', priceStars: null, status: 'published', publishedAt: world.clock.now() });
    const user = await givenUser(world);
    await repos.follows.create({ userId: user.id, creatorId: alpha.id });

    const profile = await discovery.profile('alpha');
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;
    expect(profile.value.startParam).toBe('c_alpha');
    expect(profile.value.followerCount).toBe(1);
    expect(profile.value.drops.map((d) => d.title)).toEqual(['Song']);
  });

  it('404s the profile of a non-discoverable creator', async () => {
    const world = createWorld();
    await seed(world);
    const discovery = new DiscoveryService(world.uow);
    expect((await discovery.profile('ob')).ok).toBe(false); // not onboarded
    expect((await discovery.profile('susp')).ok).toBe(false); // suspended
    expect((await discovery.profile('nope')).ok).toBe(false); // missing
  });
});
