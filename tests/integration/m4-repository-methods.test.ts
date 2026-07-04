import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, makeCreator, makeUser, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = connect();
});

afterAll(async () => {
  await ctx.db.close();
});

describe('M4 repository support', () => {
  it('merges transport cache only inside the asset creator scope', async () => {
    const { repos } = ctx;
    const { creator } = await makeCreator(repos);
    const { creator: otherCreator } = await makeCreator(repos);
    const drop = await repos.drops.create({
      creatorId: creator.id,
      title: 'Transport cache target',
      accessType: 'free',
      status: 'published',
      publishedAt: new Date(),
    });
    const asset = await repos.drops.addAsset({
      creatorId: creator.id,
      dropId: drop.id,
      position: 0,
      contentType: 'text',
      textContent: 'cached delivery',
    });

    await repos.drops.cacheAssetTransport(otherCreator.id, asset.id, 'telegram:1', 'wrong');
    expect((await repos.drops.listAssets(drop.id))[0]?.transportCache).toBeNull();

    await repos.drops.cacheAssetTransport(creator.id, asset.id, 'telegram:1', 'file-1');
    await repos.drops.cacheAssetTransport(creator.id, asset.id, 'telegram:2', 'file-2');
    expect((await repos.drops.listAssets(drop.id))[0]?.transportCache).toEqual({
      'telegram:1': 'file-1',
      'telegram:2': 'file-2',
    });
  });

  it('scopes first-delivery audit lookups by creator and actor', async () => {
    const { repos } = ctx;
    const user = await makeUser(repos);
    const otherUser = await makeUser(repos);
    const { creator } = await makeCreator(repos);
    const { creator: otherCreator } = await makeCreator(repos);
    const drop = await repos.drops.create({
      creatorId: creator.id,
      title: 'Audit target',
      accessType: 'free',
      status: 'published',
      publishedAt: new Date(),
    });
    await repos.audit.append({
      creatorId: creator.id,
      action: 'content.delivered',
      entityType: 'drop',
      entityId: drop.id,
      actorType: 'user',
      actorUserId: user.id,
    });

    expect(
      await repos.audit.existsForActor(creator.id, 'content.delivered', 'drop', drop.id, user.id),
    ).toBe(true);
    expect(
      await repos.audit.existsForActor(
        otherCreator.id,
        'content.delivered',
        'drop',
        drop.id,
        user.id,
      ),
    ).toBe(false);
    expect(
      await repos.audit.existsForActor(
        creator.id,
        'content.delivered',
        'drop',
        drop.id,
        otherUser.id,
      ),
    ).toBe(false);
  });
});
