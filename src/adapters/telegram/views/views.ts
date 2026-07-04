/**
 * Pure view builders (SYSTEM_ARCHITECTURE §4: "view builder (pure) → reply").
 * No Telegraf, no I/O — text in, text out — so they unit-test trivially. HTML
 * parse mode is used at reply time; these escape user/creator-supplied strings.
 */
import type { Drop, DropAsset, SubscriptionPlan } from '../../../shared/entities.js';
import type { AccessType, Stars } from '../../../shared/domain.js';
import type { AccessDecision } from '../../../core/services/access.service.js';

/** Escape the five HTML-significant chars Telegram's HTML parse mode cares about. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const accessBadge = (accessType: AccessType, priceStars: Stars | null): string => {
  switch (accessType) {
    case 'free':
      return '🆓 Free';
    case 'premium':
      return '⭐ Premium';
    case 'pay_per_unlock':
      return `🔓 Unlock — ${priceStars ?? 0} ⭐`;
  }
};

export const welcome = (firstName: string | null): string =>
  [
    `👋 Welcome${firstName ? `, ${escapeHtml(firstName)}` : ''}!`,
    '',
    'This is a creator content bot. You can:',
    '• /browse — see available drops',
    '• /my_access — what you can view right now',
    '• /help — full command list',
  ].join('\n');

export const help = (): string =>
  [
    '<b>Commands</b>',
    '',
    '/start — register &amp; get started',
    '/browse — list published drops',
    '/my_access — your unlocked &amp; subscribed content',
    '/help — this message',
    '',
    'Tap a drop to see details, then <b>Unlock</b> a single drop or <b>Subscribe</b> for all premium content.',
    '',
    '<i>Payments are simulated in this build — no real Stars are charged.</i>',
  ].join('\n');

export const browseHeader = (count: number): string =>
  count === 0
    ? 'No drops are published yet. Check back soon!'
    : `<b>Available drops</b> (${count})\n\nTap one for details:`;

export const dropButtonLabel = (drop: Drop): string =>
  `${accessBadge(drop.accessType, drop.priceStars)} · ${truncate(drop.title, 40)}`;

export interface DropDetailView {
  readonly text: string;
  readonly decision: AccessDecision;
}

/** Detail body shown before delivery — preview only, never the content itself. */
export const dropDetail = (drop: Drop, decision: AccessDecision): string => {
  const lines = [`<b>${escapeHtml(drop.title)}</b>`, accessBadge(drop.accessType, drop.priceStars)];
  if (drop.description) lines.push('', escapeHtml(drop.description));
  if (drop.previewText) lines.push('', `<i>${escapeHtml(drop.previewText)}</i>`);
  lines.push(
    '',
    decision.allowed ? '✅ You have access — sending now…' : lockedNote(drop.accessType),
  );
  return lines.join('\n');
};

const lockedNote = (accessType: AccessType): string => {
  switch (accessType) {
    case 'premium':
      return '🔒 Subscribe to view premium content.';
    case 'pay_per_unlock':
      return '🔒 Unlock to view this drop.';
    case 'free':
      return '🔒 Not available.';
  }
};

export const unlockPrompt = (drop: Drop): string =>
  `Unlock <b>${escapeHtml(drop.title)}</b> for ${drop.priceStars ?? 0} ⭐?`;

export const subscribePrompt = (plan: SubscriptionPlan): string =>
  [
    `<b>${escapeHtml(plan.name)}</b>`,
    plan.description ? escapeHtml(plan.description) : null,
    '',
    `${plan.priceStars} ⭐ for ${plan.durationDays} days of premium access.`,
  ]
    .filter((line) => line !== null)
    .join('\n');

export const purchaseSucceeded = (drop: Drop): string =>
  `✅ Unlocked <b>${escapeHtml(drop.title)}</b>! Sending your content…`;

export const subscribeSucceeded = (expiresAt: Date, renewed: boolean): string =>
  `✅ ${renewed ? 'Renewed' : 'Subscribed'}! Premium access until ${expiresAt
    .toISOString()
    .slice(0, 10)}.`;

export const myAccessView = (
  entries: { drop: Drop; decision: AccessDecision }[],
  hasActiveSubscription: boolean,
): string => {
  const lines: string[] = ['<b>Your access</b>', ''];
  lines.push(
    hasActiveSubscription ? '⭐ Premium subscription: active' : '⭐ Premium subscription: none',
  );
  lines.push('');
  const unlocked = entries.filter((e) => e.decision.allowed);
  if (unlocked.length === 0) {
    lines.push('You have no unlocked drops yet. Try /browse.');
  } else {
    lines.push('Unlocked drops:');
    for (const { drop, decision } of unlocked) {
      const how =
        decision.allowed && decision.basis === 'grant'
          ? 'unlocked'
          : decision.allowed && decision.basis === 'subscription'
            ? 'premium'
            : 'free';
      lines.push(`• ${escapeHtml(drop.title)} <i>(${how})</i>`);
    }
  }
  return lines.join('\n');
};

/** Media assets have no inline body; a text asset's content is sent verbatim. */
export const isTextAsset = (asset: DropAsset): boolean => asset.contentType === 'text';

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;
