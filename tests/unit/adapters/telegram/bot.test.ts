import type { Update } from 'telegraf/types';
import { describe, expect, it, vi } from 'vitest';
import {
  configureTelegramBot,
  createTelegramBot,
  type TelegramBotConfig,
} from '../../../../src/adapters/telegram/bot.js';
import { NoopCacheProvider } from '../../../../src/adapters/cache/noop-cache.provider.js';
import { CreatorContext } from '../../../../src/adapters/telegram/creator-context.js';
import { DeliveryEngine } from '../../../../src/core/engines/delivery.engine.js';
import { CreatorService } from '../../../../src/core/services/creator.service.js';
import { DropService } from '../../../../src/core/services/drop.service.js';
import { PurchaseService } from '../../../../src/core/services/purchase.service.js';
import { SubscriptionService } from '../../../../src/core/services/subscription.service.js';
import { UserService } from '../../../../src/core/services/user.service.js';
import { createLogger } from '../../../../src/logging/logger.js';
import { FakeContentProvider, FakeContentTransport } from '../../../fakes/fake-content.js';
import { FakePaymentProvider } from '../../../fakes/fake-payment-provider.js';
import { createWorld, givenCreator, givenPlan, givenPublishedDrop } from '../../../fakes/world.js';

const config: TelegramBotConfig = {
  token: '123:test-token',
  mode: 'polling',
  port: 3000,
  rateLimitPoints: 20,
  rateLimitWindowSeconds: 60,
};

describe('Telegram bot commands and callbacks', () => {
  it('registers users, browses, unlocks, subscribes, and reports access', async () => {
    const world = createWorld();
    const creator = await givenCreator(world, { slug: 'demo' });
    await givenPublishedDrop(world, creator, 'free');
    const unlockDrop = await givenPublishedDrop(world, creator, 'pay_per_unlock');
    const plan = await givenPlan(world, creator);
    const logger = createLogger({ level: 'silent' });
    const users = new UserService(world.uow, world.audit);
    const creators = new CreatorService(world.uow);
    const cache = new NoopCacheProvider();
    const creatorContext = new CreatorContext(cache, creators, 'demo');
    const drops = new DropService(world.uow, world.audit, world.clock);
    const paymentProvider = new FakePaymentProvider();
    const purchases = new PurchaseService(
      world.uow,
      paymentProvider,
      world.access,
      world.audit,
      world.clock,
    );
    const subscriptions = new SubscriptionService(world.uow, purchases, world.audit, world.clock);
    const transport = new FakeContentTransport();
    const delivery = new DeliveryEngine(
      world.uow,
      world.access,
      new FakeContentProvider(world.clock),
      transport,
      world.audit,
      world.clock,
    );
    const bot = createTelegramBot(config.token);
    configureTelegramBot(bot, config, {
      creatorContext,
      users,
      drops,
      access: world.access,
      purchases,
      subscriptions,
      delivery,
      cache,
      logger,
    });
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: 'Test Bot',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };
    const callApi = vi.spyOn(bot.telegram, 'callApi').mockImplementation(async () => response());
    Object.assign(bot.context, { telegram: bot.telegram });

    await bot.handleUpdate(commandUpdate(1, '/start'));
    await bot.handleUpdate(commandUpdate(2, '/browse'));
    await bot.handleUpdate(callbackUpdate(3, `u:${unlockDrop.id}`));
    await bot.handleUpdate(callbackUpdate(4, `s:${plan.id}`));
    await bot.handleUpdate(commandUpdate(5, '/my_access'));

    const user = await world.store.repos.users.findByTelegramId(42n);
    expect(user).not.toBeNull();
    expect(world.store.state.accessGrants).toHaveLength(1);
    expect(world.store.state.subscriptions).toHaveLength(1);
    expect(transport.sends).toHaveLength(1);
    const sentTexts = callApi.mock.calls
      .filter(([method]) => method === 'sendMessage')
      .map(([, payload]) => {
        const record = payload as unknown as Record<string, unknown>;
        return String(record['text']);
      });
    expect(sentTexts.some((text) => text.includes('Welcome'))).toBe(true);
    expect(sentTexts.some((text) => text.includes('Available drops'))).toBe(true);
    expect(sentTexts.some((text) => text.includes('Unlocked'))).toBe(true);
    expect(sentTexts.some((text) => text.includes('Subscribed'))).toBe(true);
    expect(sentTexts.some((text) => text.includes('Your access'))).toBe(true);
  });
});

const from = {
  id: 42,
  is_bot: false,
  first_name: 'Ada',
  username: 'ada',
  language_code: 'en',
};

const chat = { id: 42, type: 'private' as const, first_name: 'Ada' };

const commandUpdate = (updateId: number, text: string): Update =>
  ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      from,
      chat,
      text,
      entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
    },
  }) as Update;

const callbackUpdate = (updateId: number, data: string): Update =>
  ({
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from,
      chat_instance: 'test',
      data,
      message: {
        message_id: updateId,
        date: 1_700_000_000,
        chat,
        text: 'button',
      },
    },
  }) as Update;

const response = () =>
  ({
    message_id: 1,
    date: 1_700_000_000,
    chat,
    text: 'ok',
  }) as never;
