import { describe, expect, it } from 'vitest';
import { DeliveryEngine } from '../../../../src/core/engines/delivery.engine.js';
import { FakeContentProvider, FakeContentTransport } from '../../../fakes/fake-content.js';
import {
  createWorld,
  givenCreator,
  givenPublishedDrop,
  givenUser,
  type TestWorld,
} from '../../../fakes/world.js';

const setup = (world: TestWorld = createWorld()) => {
  const content = new FakeContentProvider(world.clock);
  const transport = new FakeContentTransport();
  const engine = new DeliveryEngine(
    world.uow,
    world.access,
    content,
    transport,
    world.audit,
    world.clock,
  );
  return { world, content, transport, engine };
};

describe('DeliveryEngine.deliver', () => {
  it('never sends content to an unentitled user', async () => {
    const { world, transport, engine } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'pay_per_unlock', 50);
    const user = await givenUser(world);

    const result = await engine.deliver(user.id, drop.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('forbidden');
    expect(transport.sends).toHaveLength(0);
    expect(world.store.state.auditLogs).toHaveLength(0);
  });

  it('delivers text assets directly, protected, and audits content.delivered', async () => {
    const { world, transport, engine } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'free'); // fixture adds one text asset
    const user = await givenUser(world);

    const result = await engine.deliver(user.id, drop.id, 'corr-d');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deliveredAssets).toBe(1);
    expect(transport.sends[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(transport.sends[0]?.options.protect).toBe(true);

    const audit = world.store.state.auditLogs.find((e) => e.action === 'content.delivered');
    expect(audit?.entityId).toBe(drop.id);
    expect(audit?.correlationId).toBe('corr-d');
  });

  it('resolves media assets to signed deliverables via the ContentProvider', async () => {
    const { world, content, transport, engine } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'free');
    await world.store.repos.drops.addAsset({
      dropId: drop.id,
      creatorId: creator.id,
      position: 1,
      contentType: 'photo',
      storageBucket: 'drops',
      storagePath: `creators/${creator.id}/drops/${drop.id}/pic.jpg`,
    });
    content.putObject('drops', `creators/${creator.id}/drops/${drop.id}/pic.jpg`);
    const user = await givenUser(world);

    const result = await engine.deliver(user.id, drop.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deliveredAssets).toBe(2);
    const media = transport.sends[1]?.content;
    expect(media?.kind).toBe('media');
    if (media?.kind !== 'media') return;
    expect(media.deliverable.url).toBe(
      `signed://drops/creators/${creator.id}/drops/${drop.id}/pic.jpg`,
    );
  });

  it('a transport failure surfaces as an error and writes no delivery audit', async () => {
    const { world, transport, engine } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'free');
    const user = await givenUser(world);
    transport.failNextSends(1);

    const result = await engine.deliver(user.id, drop.id);

    expect(result.ok).toBe(false);
    expect(world.store.state.auditLogs.map((e) => e.action)).not.toContain('content.delivered');
  });

  it('missing storage objects fail without partial audit', async () => {
    const { world, engine } = setup();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'free');
    await world.store.repos.drops.addAsset({
      dropId: drop.id,
      creatorId: creator.id,
      position: 1,
      contentType: 'video',
      storageBucket: 'drops',
      storagePath: 'creators/x/drops/y/missing.mp4',
    });
    const user = await givenUser(world);

    const result = await engine.deliver(user.id, drop.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });
});
