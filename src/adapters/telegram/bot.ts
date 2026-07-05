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

const BOT_COMMANDS = [
  { command: 'start', description: 'Register and get started' },
  { command: 'help', description: 'Show available commands' },
  { command: 'browse', description: 'Browse published drops' },
  { command: 'unlock', description: 'Choose a drop to unlock' },
  { command: 'subscribe', description: 'View the Premium plan' },
  { command: 'my_access', description: 'Show content you can access' },
  { command: 'follow', description: 'Follow this creator for new drops' },
  { command: 'unfollow', description: 'Stop following this creator' },
  { command: 'creators', description: 'Creators you follow' },
];

/** The Telegram request handler (verifies the secret token). Pure — no network; the
 * caller mounts it on its own HTTP server (M6) and registers the webhook separately
 * so the server is listening before Telegram starts POSTing. */
export const createTelegramWebhookHandler = (
  bot: Telegraf<BotContext>,
  config: TelegramBotConfig,
): ReturnType<Telegraf<BotContext>['webhookCallback']> => {
  const { webhookUrl, webhookSecretToken } = requireWebhookConfig(config);
  return bot.webhookCallback(new URL(webhookUrl).pathname, { secretToken: webhookSecretToken });
};

/** Register the bot's commands + point Telegram at the webhook URL. Call AFTER the
 * HTTP server is listening (webhook mode, production). */
export const registerTelegramWebhook = async (
  bot: Telegraf<BotContext>,
  config: TelegramBotConfig,
): Promise<void> => {
  const { webhookUrl, webhookSecretToken } = requireWebhookConfig(config);
  await bot.telegram.setMyCommands(BOT_COMMANDS);
  await bot.telegram.setWebhook(webhookUrl, {
    secret_token: webhookSecretToken,
    drop_pending_updates: false,
  });
};

/** Best-effort webhook teardown on shutdown — a failure here never blocks exit. */
export const deleteTelegramWebhook = async (bot: Telegraf<BotContext>): Promise<void> => {
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });
};

/** Long-polling launch (development only — production is webhook, ADR-017/ADR-020).
 * Resolves when the bot stops, so callers must not block startup work behind it. */
export const startTelegramPolling = async (bot: Telegraf<BotContext>): Promise<void> => {
  await bot.telegram.setMyCommands(BOT_COMMANDS);
  await bot.launch({ dropPendingUpdates: false });
};

const requireWebhookConfig = (
  config: TelegramBotConfig,
): { webhookUrl: string; webhookSecretToken: string } => {
  if (config.webhookUrl === undefined || config.webhookSecretToken === undefined) {
    throw new Error('webhookUrl and webhookSecretToken are required in webhook mode');
  }
  return { webhookUrl: config.webhookUrl, webhookSecretToken: config.webhookSecretToken };
};
