import type { Telegraf } from 'telegraf';
import { z } from 'zod';
import type { DeliveryEngine } from '../../../core/engines/delivery.engine.js';
import type { AccessService } from '../../../core/services/access.service.js';
import type { DropService } from '../../../core/services/drop.service.js';
import type { PurchaseService } from '../../../core/services/purchase.service.js';
import type { SubscriptionService } from '../../../core/services/subscription.service.js';
import { appError, type AppError } from '../../../shared/app-error.js';
import type { CreatorId, DropId, PlanId } from '../../../shared/domain.js';
import type { BotContext } from '../context.js';
import {
  browseKeyboard,
  confirmSubscribeKeyboard,
  confirmUnlockKeyboard,
  openKeyboard,
} from '../keyboards/keyboards.js';
import {
  browseHeader,
  dropDetail,
  help,
  myAccessView,
  purchaseSucceeded,
  subscribePrompt,
  subscribeSucceeded,
  unlockPrompt,
  welcome,
} from '../views/views.js';
import { parseCallbackData, type TelegramCallback } from './callback-data.js';

export interface TelegramHandlerDependencies {
  readonly creatorId: CreatorId;
  readonly premiumPlanId: PlanId;
  readonly drops: DropService;
  readonly access: AccessService;
  readonly purchases: PurchaseService;
  readonly subscriptions: SubscriptionService;
  readonly delivery: DeliveryEngine;
}

const html = { parse_mode: 'HTML' as const };

export const registerTelegramHandlers = (
  bot: Telegraf<BotContext>,
  deps: TelegramHandlerDependencies,
): void => {
  bot.start(async (ctx) => {
    await ctx.reply(welcome(ctx.from?.first_name ?? null), html);
  });

  bot.help(async (ctx) => {
    await ctx.reply(help(), html);
  });

  bot.command('browse', async (ctx) => showBrowse(ctx, deps, 0));

  bot.command('unlock', async (ctx) => {
    const argument = commandArgument(ctx);
    if (argument !== null) {
      const dropId = z.uuid().safeParse(argument);
      if (!dropId.success) {
        await ctx.reply('Invalid drop id. Use /browse to choose a drop.');
        return;
      }
      await showUnlockPrompt(ctx, deps, dropId.data);
      return;
    }
    const drops = (await deps.drops.listPublished(deps.creatorId)).filter(
      (drop) => drop.accessType === 'pay_per_unlock',
    );
    await ctx.reply(
      drops.length === 0 ? 'No pay-per-unlock drops are available.' : 'Choose a drop to unlock:',
      drops.length === 0 ? undefined : browseKeyboard(drops, 0),
    );
  });

  bot.command('subscribe', async (ctx) => showSubscribePrompt(ctx, deps, deps.premiumPlanId));

  bot.command('my_access', async (ctx) => {
    const user = requireUser(ctx);
    const drops = await deps.drops.listPublished(deps.creatorId);
    const entries = await Promise.all(
      drops.map(async (drop) => ({
        drop,
        decision: await deps.access.resolveAccess(user.id, drop.id),
      })),
    );
    const active = await deps.subscriptions.hasActiveSubscription(user.id, deps.creatorId);
    await ctx.reply(myAccessView(entries, active), html);
  });

  bot.on('callback_query', async (ctx) => {
    await ctx.answerCbQuery();
    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : null;
    const callback = data === null ? null : parseCallbackData(data);
    if (callback === null) {
      await ctx.reply('That action is no longer valid. Please use /browse.');
      return;
    }
    await handleCallback(ctx, deps, callback);
  });
};

const handleCallback = async (
  ctx: BotContext,
  deps: TelegramHandlerDependencies,
  callback: TelegramCallback,
): Promise<void> => {
  switch (callback.action) {
    case 'browse':
      await showBrowse(ctx, deps, callback.page);
      return;
    case 'detail':
      await showDetail(ctx, deps, callback.dropId);
      return;
    case 'unlock_prompt':
      await showUnlockPrompt(ctx, deps, callback.dropId);
      return;
    case 'unlock':
      await unlock(ctx, deps, callback.dropId);
      return;
    case 'subscribe_prompt':
      await showSubscribePrompt(ctx, deps, callback.planId);
      return;
    case 'subscribe':
      await subscribe(ctx, deps, callback.planId);
      return;
  }
};

const showBrowse = async (
  ctx: BotContext,
  deps: TelegramHandlerDependencies,
  page: number,
): Promise<void> => {
  const drops = await deps.drops.listPublished(deps.creatorId);
  await ctx.reply(
    browseHeader(drops.length),
    drops.length === 0 ? html : { ...html, ...browseKeyboard(drops, page) },
  );
};

const showDetail = async (
  ctx: BotContext,
  deps: TelegramHandlerDependencies,
  dropId: DropId,
): Promise<void> => {
  const user = requireUser(ctx);
  const decision = await deps.access.resolveAccess(user.id, dropId);
  if (decision.drop === null) {
    await replyAppError(ctx, appError('not_found', 'Drop not found.'));
    return;
  }
  const keyboard = decision.allowed ? undefined : openKeyboard(decision.drop, deps.premiumPlanId);
  await ctx.reply(
    dropDetail(decision.drop, decision),
    keyboard === undefined ? html : { ...html, ...keyboard },
  );
  if (decision.allowed) await deliver(ctx, deps, dropId);
};

const showUnlockPrompt = async (
  ctx: BotContext,
  deps: TelegramHandlerDependencies,
  dropId: DropId,
): Promise<void> => {
  const published = await deps.drops.getPublishedDrop(dropId);
  if (!published.ok) {
    await replyAppError(ctx, published.error);
    return;
  }
  if (published.value.drop.accessType !== 'pay_per_unlock') {
    await replyAppError(ctx, appError('validation', 'This drop does not require an unlock.'));
    return;
  }
  const user = requireUser(ctx);
  const access = await deps.access.resolveAccess(user.id, dropId);
  if (access.allowed) {
    await ctx.reply('You already have access. Sending your content now…');
    await deliver(ctx, deps, dropId);
    return;
  }
  await ctx.reply(unlockPrompt(published.value.drop), {
    ...html,
    ...confirmUnlockKeyboard(published.value.drop),
  });
};

const unlock = async (
  ctx: BotContext,
  deps: TelegramHandlerDependencies,
  dropId: DropId,
): Promise<void> => {
  const user = requireUser(ctx);
  const result = await deps.purchases.purchaseDrop({
    userId: user.id,
    dropId,
    idempotencyKey: `telegram:unlock:${user.id}:${dropId}:${ctx.update.update_id}`,
    correlationId: ctx.correlationId,
  });
  if (!result.ok) {
    await replyAppError(ctx, result.error);
    return;
  }
  const drop = await deps.drops.getPublishedDrop(dropId);
  if (!drop.ok) {
    await replyAppError(ctx, drop.error);
    return;
  }
  await ctx.reply(purchaseSucceeded(drop.value.drop), html);
  await deliver(ctx, deps, dropId);
};

const showSubscribePrompt = async (
  ctx: BotContext,
  deps: TelegramHandlerDependencies,
  planId: PlanId,
): Promise<void> => {
  const plan = await deps.subscriptions.getActivePlan(planId);
  if (!plan.ok) {
    await replyAppError(ctx, plan.error);
    return;
  }
  await ctx.reply(subscribePrompt(plan.value), {
    ...html,
    ...confirmSubscribeKeyboard(plan.value),
  });
};

const subscribe = async (
  ctx: BotContext,
  deps: TelegramHandlerDependencies,
  planId: PlanId,
): Promise<void> => {
  const user = requireUser(ctx);
  const result = await deps.subscriptions.subscribe({
    userId: user.id,
    planId,
    idempotencyKey: `telegram:subscribe:${user.id}:${planId}:${ctx.update.update_id}`,
    correlationId: ctx.correlationId,
  });
  if (!result.ok) {
    await replyAppError(ctx, result.error);
    return;
  }
  await ctx.reply(
    subscribeSucceeded(result.value.subscription.expiresAt, result.value.renewed),
    html,
  );
};

const deliver = async (
  ctx: BotContext,
  deps: TelegramHandlerDependencies,
  dropId: DropId,
): Promise<void> => {
  const result = await deps.delivery.deliver(requireUser(ctx).id, dropId, ctx.correlationId);
  if (!result.ok) await replyAppError(ctx, result.error);
};

const requireUser = (ctx: BotContext) => {
  if (ctx.user === undefined) {
    throw appError('forbidden', 'This action requires a Telegram user.');
  }
  return ctx.user;
};

const replyAppError = async (ctx: BotContext, error: AppError): Promise<void> => {
  ctx.log.warn({ code: error.code, context: error.context }, 'telegram request rejected');
  await ctx.reply(error.message);
};

const commandArgument = (ctx: BotContext): string | null => {
  const message = ctx.message;
  if (message === undefined || !('text' in message)) return null;
  const parts = message.text.trim().split(/\s+/, 2);
  return parts[1] ?? null;
};
