import type { Telegram } from 'telegraf';
import { describe, expect, it, vi } from 'vitest';
import { TelegramContentTransport } from '../../../../src/adapters/telegram/telegram-content-transport.js';
import { TelegramNotifier } from '../../../../src/adapters/telegram/telegram-notifier.js';
import { createWorld, givenCreator, givenPublishedDrop, givenUser } from '../../../fakes/world.js';

const logger = { warn: vi.fn() };

describe('TelegramContentTransport', () => {
  it('sends text with content protection enabled', async () => {
    const world = createWorld();
    const user = await givenUser(world);
    const sendMessage = vi.fn().mockResolvedValue({});
    const telegram = { sendMessage } as unknown as Telegram;
    const transport = new TelegramContentTransport(telegram, world.uow, logger);

    const result = await transport.send(user, { kind: 'text', text: 'secret' }, { protect: true });

    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(user.telegramId.toString(), 'secret', {
      protect_content: true,
    });
  });

  it('uploads a signed URL once, writes file_id cache, then reuses it', async () => {
    const world = createWorld();
    const creator = await givenCreator(world);
    const drop = await givenPublishedDrop(world, creator, 'free');
    const user = await givenUser(world);
    const asset = await world.store.repos.drops.addAsset({
      dropId: drop.id,
      creatorId: creator.id,
      position: 1,
      contentType: 'photo',
      storageBucket: 'drops',
      storagePath: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
    const sendPhoto = vi
      .fn()
      .mockResolvedValue({ photo: [{ file_id: 'small' }, { file_id: 'cached-file-id' }] });
    const telegram = {
      getMe: vi.fn().mockResolvedValue({ id: 777 }),
      sendPhoto,
    } as unknown as Telegram;
    const transport = new TelegramContentTransport(telegram, world.uow, logger);
    const content = {
      kind: 'media' as const,
      asset,
      deliverable: {
        url: 'https://storage.example/signed-photo',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      },
    };

    expect((await transport.send(user, content, { protect: true })).ok).toBe(true);
    const refreshedAsset = (await world.store.repos.drops.listAssets(drop.id)).find(
      (candidate) => candidate.id === asset.id,
    );
    expect(refreshedAsset?.transportCache).toEqual({ 'telegram:777': 'cached-file-id' });
    expect(
      (
        await transport.send(
          user,
          { ...content, asset: refreshedAsset ?? asset },
          { protect: true },
        )
      ).ok,
    ).toBe(true);

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expect(sendPhoto.mock.calls[0]?.[1]).toEqual({
      url: 'https://storage.example/signed-photo',
      filename: undefined,
    });
    expect(sendPhoto.mock.calls[1]?.[1]).toBe('cached-file-id');
    expect(sendPhoto.mock.calls[0]?.[2]).toEqual({ protect_content: true });
  });
});

describe('TelegramNotifier', () => {
  it('distinguishes sent, blocked, and transient failures', async () => {
    const world = createWorld();
    const user = await givenUser(world);
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({
        response: { error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      })
      .mockRejectedValueOnce(new Error('network down'));
    const notifier = new TelegramNotifier({ sendMessage } as unknown as Telegram);
    const notification = { kind: 'payment_failed' as const, text: 'Try again' };

    expect(await notifier.notify(user, notification)).toBe('sent');
    expect(await notifier.notify(user, notification)).toBe('blocked');
    expect(await notifier.notify(user, notification)).toBe('failed');
  });
});
