/**
 * FollowService (M7.3) — follow/unfollow is idempotent, user→creator, and rejects
 * unknown creators.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FollowService } from '../../../../src/core/services/follow.service.js';
import { createWorld, givenCreator, givenUser } from '../../../fakes/world.js';

describe('FollowService', () => {
  it('follows idempotently, lists, and unfollows', async () => {
    const world = createWorld();
    const follows = new FollowService(world.uow);
    const creator = await givenCreator(world);
    const user = await givenUser(world);

    const first = await follows.follow(user.id, creator.id);
    expect(first.ok).toBe(true);
    expect(await follows.isFollowing(user.id, creator.id)).toBe(true);

    await follows.follow(user.id, creator.id); // idempotent
    expect(world.store.state.follows).toHaveLength(1);

    expect((await follows.listFollowedCreators(user.id)).map((c) => c.id)).toEqual([creator.id]);

    await follows.unfollow(user.id, creator.id);
    expect(await follows.isFollowing(user.id, creator.id)).toBe(false);
    expect(await follows.listFollowedCreators(user.id)).toHaveLength(0);
  });

  it('rejects following an unknown creator', async () => {
    const world = createWorld();
    const follows = new FollowService(world.uow);
    const user = await givenUser(world);
    const result = await follows.follow(user.id, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});
