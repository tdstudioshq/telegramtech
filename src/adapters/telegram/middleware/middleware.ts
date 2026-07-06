import type { MiddlewareFn } from 'telegraf';
import type { CacheProvider } from '../../../core/ports/cache-provider.port.js';
import type { UserService } from '../../../core/services/user.service.js';
import { isAppError } from '../../../shared/app-error.js';
import type { Logger } from '../../../logging/logger.js';
import type { BotContext } from '../context.js';

export const correlationMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  ctx.correlationId = `tg:${ctx.update.update_id}`;
  return next();
};

export const loggingMiddleware =
  (logger: Logger): MiddlewareFn<BotContext> =>
  async (ctx, next) => {
    ctx.log = logger.child({
      correlationId: ctx.correlationId,
      telegramUserId: ctx.from?.id,
      updateType: ctx.updateType,
    });
    const startedAt = Date.now();
    try {
      await next();
      ctx.log.info({ durationMs: Date.now() - startedAt }, 'telegram update handled');
    } catch (error) {
      ctx.log.error({ err: error, durationMs: Date.now() - startedAt }, 'telegram update failed');
      throw error;
    }
  };

export const rateLimitMiddleware =
  (cache: CacheProvider, points: number, windowSeconds: number): MiddlewareFn<BotContext> =>
  async (ctx, next) => {
    if (ctx.from === undefined) return next();
    let count: number;
    try {
      count = await cache.incr(`rate:telegram:${ctx.from.id}`, windowSeconds);
    } catch (error) {
      // Fail OPEN: a cache outage must not silence the bot — allow the update through.
      ctx.log.warn({ err: error }, 'rate-limit cache unavailable — allowing (fail-open)');
      return next();
    }
    if (count <= points) return next();
    ctx.log.warn({ count, points, windowSeconds }, 'telegram rate limit exceeded');
    await ctx.reply('Too many requests. Please wait a moment and try again.');
  };

export const authMiddleware =
  (users: UserService): MiddlewareFn<BotContext> =>
  async (ctx, next) => {
    if (ctx.from === undefined) return next();
    ctx.user = await users.ensureRegistered(
      {
        telegramId: BigInt(ctx.from.id),
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
        lastName: ctx.from.last_name ?? null,
        languageCode: ctx.from.language_code ?? null,
      },
      ctx.correlationId,
    );
    return next();
  };

export const errorMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
};

export const handleTelegramError = async (ctx: BotContext, error: unknown): Promise<void> => {
  ctx.log.error({ err: error }, 'telegram request failed');
  const message = isAppError(error)
    ? error.message
    : 'Something went wrong. Please try again in a moment.';
  // The error-reply MUST NOT throw. This runs from both errorMiddleware and bot.catch, so
  // a failed reply here (user blocked the bot, chat not found, Telegram unreachable — all
  // routine in production) would escape as an unhandledRejection and shut the process down.
  // Swallow it; the original error is already logged above.
  try {
    await ctx.reply(message);
  } catch (replyError) {
    ctx.log.warn({ err: replyError }, 'failed to deliver error reply (ignored)');
  }
};
