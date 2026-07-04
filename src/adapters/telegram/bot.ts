import { Telegraf } from 'telegraf';
import type { CacheProvider } from '../../core/ports/cache-provider.port.js';
import type { UserService } from '../../core/services/user.service.js';
import type { Logger } from '../../logging/logger.js';
import type { BotContext } from './context.js';
import {
  handleTelegramError,
  authMiddleware,
  correlationMiddleware,
  errorMiddleware,
  loggingMiddleware,
  rateLimitMiddleware,
} from './middleware/middleware.js';
import { registerTelegramHandlers, type TelegramHandlerDependencies } from './handlers/handlers.js';

export interface TelegramBotConfig {
  readonly token: string;
  readonly mode: 'polling' | 'webhook';
  readonly webhookUrl?: string;
  readonly webhookSecretToken?: string;
  readonly port: number;
  readonly rateLimitPoints: number;
  readonly rateLimitWindowSeconds: number;
}

export interface TelegramBotDependencies extends TelegramHandlerDependencies {
  readonly users: UserService;
  readonly cache: CacheProvider;
  readonly logger: Logger;
}

/** Telegraf factory. Construction is separate so transports can share bot.telegram. */
export const createTelegramBot = (token: string): Telegraf<BotContext> =>
  new Telegraf<BotContext>(token);

export const configureTelegramBot = (
  bot: Telegraf<BotContext>,
  config: TelegramBotConfig,
  deps: TelegramBotDependencies,
): Telegraf<BotContext> => {
  bot.use(correlationMiddleware);
  bot.use(loggingMiddleware(deps.logger));
  bot.use(rateLimitMiddleware(deps.cache, config.rateLimitPoints, config.rateLimitWindowSeconds));
  bot.use(authMiddleware(deps.users));
  bot.use(errorMiddleware);
  registerTelegramHandlers(bot, deps);
  bot.catch(async (error, ctx) => handleTelegramError(ctx, error));
  return bot;
};

export const launchTelegramBot = async (
  bot: Telegraf<BotContext>,
  config: TelegramBotConfig,
): Promise<void> => {
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Register and get started' },
    { command: 'help', description: 'Show available commands' },
    { command: 'browse', description: 'Browse published drops' },
    { command: 'unlock', description: 'Choose a drop to unlock' },
    { command: 'subscribe', description: 'View the Premium plan' },
    { command: 'my_access', description: 'Show content you can access' },
  ]);

  if (config.mode === 'polling') {
    await bot.launch({ dropPendingUpdates: false });
    return;
  }

  if (config.webhookUrl === undefined || config.webhookSecretToken === undefined) {
    throw new Error('webhookUrl and webhookSecretToken are required in webhook mode');
  }
  const webhookUrl = new URL(config.webhookUrl);
  await bot.launch({
    dropPendingUpdates: false,
    webhook: {
      domain: webhookUrl.origin,
      path: webhookUrl.pathname,
      host: '0.0.0.0',
      port: config.port,
      secretToken: config.webhookSecretToken,
    },
  });
};
