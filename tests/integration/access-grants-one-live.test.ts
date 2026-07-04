/** DB constraint: partial unique (user_id, drop_id) WHERE revoked_at IS NULL (DATABASE.md §9). */
import { afterAll, describe, expect, it } from 'vitest';
import { connect, expectUniqueViolation, makeCreator, makeUser } from './helpers.js';
import type { Repositories } from '../../src/core/repositories/index.js';

const ctx = connect();
afterAll(() => ctx.db.close());

const makeUnlockDrop = async (repos: Repositories, creatorId: string) =>
  repos.drops.create({
    creatorId,
    title: 'Unlockable',
    accessType: 'pay_per_unlock',
    priceStars: 50,
    status: 'published',
    publishedAt: new Date(),
  });

describe('one live grant per (user, drop)', () => {
  it('rejects a second live grant for the same user and drop', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const drop = await makeUnlockDrop(ctx.repos, creator.id);
    const user = await makeUser(ctx.repos);

    await ctx.repos.accessGrants.create({
      userId: user.id,
      dropId: drop.id,
      creatorId: creator.id,
      grantType: 'manual',
    });

    await expectUniqueViolation(
      ctx.repos.accessGrants.create({
        userId: user.id,
        dropId: drop.id,
        creatorId: creator.id,
        grantType: 'manual',
      }),
    );
  });

  it('allows a fresh grant after revocation, and findLiveGrant sees only the live one', async () => {
    const { creator } = await makeCreator(ctx.repos);
    const drop = await makeUnlockDrop(ctx.repos, creator.id);
    const user = await makeUser(ctx.repos);

    const first = await ctx.repos.accessGrants.create({
      userId: user.id,
      dropId: drop.id,
      creatorId: creator.id,
      grantType: 'manual',
    });
    await ctx.repos.accessGrants.revoke(first.id, new Date());
    expect(await ctx.repos.accessGrants.findLiveGrant(user.id, drop.id)).toBeNull();

    const second = await ctx.repos.accessGrants.create({
      userId: user.id,
      dropId: drop.id,
      creatorId: creator.id,
      grantType: 'purchase',
    });
    const live = await ctx.repos.accessGrants.findLiveGrant(user.id, drop.id);
    expect(live?.id).toBe(second.id);
    expect(live?.revokedAt).toBeNull();
  });
});
