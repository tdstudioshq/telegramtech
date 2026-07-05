import { Markup } from 'telegraf';
import type { Drop, SubscriptionPlan } from '../../../shared/entities.js';
import { callbackData } from '../handlers/callback-data.js';
import { dropButtonLabel } from '../views/views.js';

export const BROWSE_PAGE_SIZE = 5;

export const browseKeyboard = (drops: readonly Drop[], page: number) => {
  const pageCount = Math.max(1, Math.ceil(drops.length / BROWSE_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = safePage * BROWSE_PAGE_SIZE;
  const rows = drops
    .slice(start, start + BROWSE_PAGE_SIZE)
    .map((drop) => [
      Markup.button.callback(
        dropButtonLabel(drop),
        callbackData({ action: 'detail', dropId: drop.id }),
      ),
    ]);
  if (pageCount > 1) {
    rows.push([
      ...(safePage > 0
        ? [
            Markup.button.callback(
              '← Previous',
              callbackData({ action: 'browse', page: safePage - 1 }),
            ),
          ]
        : []),
      ...(safePage < pageCount - 1
        ? [Markup.button.callback('Next →', callbackData({ action: 'browse', page: safePage + 1 }))]
        : []),
    ]);
  }
  return Markup.inlineKeyboard(rows);
};

export const openKeyboard = (drop: Drop, premiumPlanId: string | null) => {
  if (drop.accessType === 'pay_per_unlock') {
    return Markup.inlineKeyboard([
      Markup.button.callback(
        `Unlock for ${drop.priceStars ?? 0} ⭐`,
        callbackData({ action: 'unlock_prompt', dropId: drop.id }),
      ),
    ]);
  }
  // premium: only offer the button if the drop's creator has an active plan (M7.0)
  if (drop.accessType === 'premium' && premiumPlanId !== null) {
    return Markup.inlineKeyboard([
      Markup.button.callback(
        'View Premium',
        callbackData({ action: 'subscribe_prompt', planId: premiumPlanId }),
      ),
    ]);
  }
  return undefined;
};

export const confirmUnlockKeyboard = (drop: Drop) =>
  Markup.inlineKeyboard([
    Markup.button.callback(
      `Confirm ${drop.priceStars ?? 0} ⭐`,
      callbackData({ action: 'unlock', dropId: drop.id }),
    ),
  ]);

export const confirmSubscribeKeyboard = (plan: SubscriptionPlan) =>
  Markup.inlineKeyboard([
    Markup.button.callback(
      `Confirm ${plan.priceStars} ⭐`,
      callbackData({ action: 'subscribe', planId: plan.id }),
    ),
  ]);
