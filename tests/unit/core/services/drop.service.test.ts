import { describe, expect, it } from 'vitest';
import { DropService } from '../../../../src/core/services/drop.service.js';
import { createWorld, givenCreator, type TestWorld } from '../../../fakes/world.js';

const setup = (world: TestWorld = createWorld()) => ({
  world,
  service: new DropService(world.uow, world.audit, world.clock),
});

describe('DropService.createDrop — price/access CHECK mirror', () => {
  it('creates a draft pay_per_unlock drop with a positive price', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);

    const result = await service.createDrop({
      creatorId: creator.id,
      title: 'Unlockable',
      accessType: 'pay_per_unlock',
      priceStars: 50,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('draft');
    expect(result.value.publishedAt).toBeNull();
  });

  it('rejects pay_per_unlock without a positive integer price', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);

    for (const priceStars of [null, 0, -5, 12.5]) {
      const result = await service.createDrop({
        creatorId: creator.id,
        title: 'Bad',
        accessType: 'pay_per_unlock',
        priceStars,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('validation');
    }
  });

  it('rejects a price on free and premium drops', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);

    for (const accessType of ['free', 'premium'] as const) {
      const result = await service.createDrop({
        creatorId: creator.id,
        title: 'Bad',
        accessType,
        priceStars: 10,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('a suspended creator cannot create drops', async () => {
    const { world, service } = setup();
    const owner = await world.store.repos.users.create({ telegramId: 1n });
    const creator = await world.store.repos.creators.create({
      userId: owner.id,
      displayName: 'S',
      status: 'suspended',
    });

    const result = await service.createDrop({ creatorId: creator.id, title: 'X', accessType: 'free' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('forbidden');
  });
});

describe('DropService.addAsset — shape CHECK mirror', () => {
  it('accepts text assets with text content and audits content.uploaded', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const drop = await service.createDrop({ creatorId: creator.id, title: 'D', accessType: 'free' });
    if (!drop.ok) throw new Error('setup failed');

    const result = await service.addAsset({
      creatorId: creator.id,
      dropId: drop.value.id,
      position: 0,
      contentType: 'text',
      textContent: 'hello',
    });

    expect(result.ok).toBe(true);
    expect(world.store.state.auditLogs.map((e) => e.action)).toContain('content.uploaded');
  });

  it('rejects text assets with storage, and media assets without it', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const drop = await service.createDrop({ creatorId: creator.id, title: 'D', accessType: 'free' });
    if (!drop.ok) throw new Error('setup failed');

    const textWithStorage = await service.addAsset({
      creatorId: creator.id,
      dropId: drop.value.id,
      position: 0,
      contentType: 'text',
      textContent: 'x',
      storageBucket: 'drops',
      storagePath: 'somewhere',
    });
    expect(textWithStorage.ok).toBe(false);

    const mediaWithoutStorage = await service.addAsset({
      creatorId: creator.id,
      dropId: drop.value.id,
      position: 0,
      contentType: 'photo',
    });
    expect(mediaWithoutStorage.ok).toBe(false);
  });

  it("cannot attach assets to another creator's drop (tenant scope)", async () => {
    const { world, service } = setup();
    const creatorA = await givenCreator(world);
    const creatorB = await givenCreator(world);
    const drop = await service.createDrop({ creatorId: creatorA.id, title: 'A', accessType: 'free' });
    if (!drop.ok) throw new Error('setup failed');

    const result = await service.addAsset({
      creatorId: creatorB.id,
      dropId: drop.value.id,
      position: 0,
      contentType: 'text',
      textContent: 'intrusion',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found'); // existence never leaks cross-tenant
  });
});

describe('DropService.publishDrop', () => {
  it('publishes a draft with assets, stamping published_at from the clock', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const drop = await service.createDrop({ creatorId: creator.id, title: 'D', accessType: 'free' });
    if (!drop.ok) throw new Error('setup failed');
    await service.addAsset({
      creatorId: creator.id,
      dropId: drop.value.id,
      position: 0,
      contentType: 'text',
      textContent: 'x',
    });
    world.clock.advanceDays(1);

    const result = await service.publishDrop(creator.id, drop.value.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('published');
    expect(result.value.publishedAt?.getTime()).toBe(world.clock.now().getTime());
  });

  it('refuses to publish an empty drop', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const drop = await service.createDrop({ creatorId: creator.id, title: 'Empty', accessType: 'free' });
    if (!drop.ok) throw new Error('setup failed');

    const result = await service.publishDrop(creator.id, drop.value.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('validation');
  });

  it('only drafts can be published', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const drop = await service.createDrop({ creatorId: creator.id, title: 'D', accessType: 'free' });
    if (!drop.ok) throw new Error('setup failed');
    await service.addAsset({
      creatorId: creator.id,
      dropId: drop.value.id,
      position: 0,
      contentType: 'text',
      textContent: 'x',
    });
    await service.publishDrop(creator.id, drop.value.id);

    const again = await service.publishDrop(creator.id, drop.value.id);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('conflict');
  });
});

describe('DropService reads', () => {
  it('getPublishedDrop returns drop + assets, and hides drafts', async () => {
    const { world, service } = setup();
    const creator = await givenCreator(world);
    const draft = await service.createDrop({ creatorId: creator.id, title: 'D', accessType: 'free' });
    if (!draft.ok) throw new Error('setup failed');

    const hidden = await service.getPublishedDrop(draft.value.id);
    expect(hidden.ok).toBe(false);

    await service.addAsset({
      creatorId: creator.id,
      dropId: draft.value.id,
      position: 0,
      contentType: 'text',
      textContent: 'x',
    });
    await service.publishDrop(creator.id, draft.value.id);

    const visible = await service.getPublishedDrop(draft.value.id);
    expect(visible.ok).toBe(true);
    if (!visible.ok) return;
    expect(visible.value.assets).toHaveLength(1);
  });
});
