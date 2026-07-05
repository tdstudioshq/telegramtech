/**
 * M7.0 end-to-end: the shared bot routes to different creators by deep-link and
 * keeps their storefronts isolated. Drives real updates through the configured
 * bot with a real (in-memory) cache so the current-creator session persists.
 */
import type { Update } from 'telegraf/types';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '../../../../src/adapters/cache/memory-cache.provider.js';
import { CreatorContext } from '../../../../src/adapters/telegram/creator-context.js';
import {
  configureTelegramBot,
  createTelegramBot,
  type TelegramBotConfig,
} from '../../../../src/adapters/telegram/bot.js';
import { DeliveryEngine } from '../../../../src/core/engines/delivery.engine.js';
import { CreatorService } from '../../../../src/core/services/creator.service.js';
import { DropService } from '../../../../src/core/services/drop.service.js';
import { PurchaseService } from '../../../../src/core/services/purchase.service.js';
import { SubscriptionService } from '../../../../src/core/services/subscription.service.js';
import { UserService } from '../../../../src/core/services/user.service.js';
import { createLogger } from '../../../../src/logging/logger.js';
import { FakeContentProvider, FakeContentTransport } from '../../../fakes/fake-content.js';
import { FakePaymentProvider } from '../../../fakes/fake-payment-provider.js';
import { createWorld, givenCreator, givenPublishedDrop } from '../../../fakes/world.js';

const config: TelegramBotConfig = {
  token: '123:test-token',
  mode: 'polling',
  port: 3000,
  rateLimitPoints: 1000,
  rateLimitWindowSeconds: 60,
};

const buildBot = async () => {
  const world = createWorld();
  const alpha = await givenCreator(world, { slug: 'alpha', displayName: 'Alpha' });
  await givenPublishedDrop(world, alpha, 'free'); // 1 drop
  const beta = await givenCreator(world, { slug: 'beta', displayName: 'Beta' });
  await givenPublishedDrop(world, beta, 'free'); // 2 drops
  await givenPublishedDrop(world, beta, 'premium');

  const cache = new MemoryCacheProvider(world.clock);
  const creators = new CreatorService(world.uow);
  const purchases = new PurchaseService(
    world.uow,
    new FakePaymentProvider(),
    world.access,
    world.audit,
    world.clock,
  );
  const bot = createTelegramBot(config.token);
  configureTelegramBot(bot, config, {
    creatorContext: new CreatorContext(cache, creators, 'alpha'),
    users: new UserService(world.uow, world.audit),
    drops: new DropService(world.uow, world.audit, world.clock),
    access: world.access,
    purchases,
    subscriptions: new SubscriptionService(world.uow, purchases, world.audit, world.clock),
    delivery: new DeliveryEngine(
      world.uow,
      world.access,
      new FakeContentProvider(world.clock),
      new FakeContentTransport(),
      world.audit,
      world.clock,
    ),
    cache,
    logger: createLogger({ level: 'silent' }),
  });
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: 'Shared Bot',
    username: 'shared_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  const calls = vi.spyOn(bot.telegram, 'callApi').mockImplementation(async () => ({}) as never);
  Object.assign(bot.context, { telegram: bot.telegram });
  return { bot, calls };
};

const sentTexts = (calls: { mock: { calls: unknown[][] } }): string[] =>
  calls.mock.calls
    .filter((call) => call[0] === 'sendMessage')
    .map((call) => String((call[1] as Record<string, unknown>)['text']));

let updateId = 0;
const command = (text: string, fromId: number): Update =>
  ({
    update_id: (updateId += 1),
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      from: { id: fromId, is_bot: false, first_name: 'U', language_code: 'en' },
      chat: { id: fromId, type: 'private', first_name: 'U' },
      text,
      entities: [{ offset: 0, length: text.split(' ')[0]?.length ?? 0, type: 'bot_command' }],
    },
  }) as Update;

describe('shared-bot multi-creator routing (M7.0)', () => {
  it('deep-link selects the creator storefront; browse is scoped to it', async () => {
    const { bot, calls } = await buildBot();

    await bot.handleUpdate(command('/start c_beta', 500));
    await bot.handleUpdate(command('/browse', 500));

    // Beta has 2 published drops — the browse header reflects Beta, not the default (Alpha).
    expect(sentTexts(calls).some((t) => t.includes('Available drops</b> (2)'))).toBe(true);
    expect(sentTexts(calls).some((t) => t.includes('(1)'))).toBe(false);
  });

  it('switching deep-links switches storefronts; sessions are per user', async () => {
    const { bot, calls } = await buildBot();

    await bot.handleUpdate(command('/start c_beta', 500)); // user 500 → Beta
    await bot.handleUpdate(command('/start c_alpha', 500)); // switch to Alpha
    calls.mockClear();
    await bot.handleUpdate(command('/browse', 500));
    expect(sentTexts(calls).some((t) => t.includes('Available drops</b> (1)'))).toBe(true);

    // a different user with no deep-link lands on the default storefront (alpha → 1 drop)
    calls.mockClear();
    await bot.handleUpdate(command('/browse', 777));
    expect(sentTexts(calls).some((t) => t.includes('Available drops</b> (1)'))).toBe(true);
  });
});
