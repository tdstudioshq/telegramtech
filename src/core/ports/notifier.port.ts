/**
 * Notifier port — send a user-facing notification on whatever channel the
 * adapter serves (M4: TelegramNotifier). `blocked` is a distinct outcome because
 * the notification job must mark users.is_blocked rather than retry forever.
 */
import type { User } from '../../shared/entities.js';

export const NOTIFICATION_KINDS = [
  'payment_failed',
  'subscription_activated',
  'subscription_expired',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface Notification {
  readonly kind: NotificationKind;
  readonly text: string;
}

export type NotifyOutcome = 'sent' | 'blocked' | 'failed';

export interface Notifier {
  notify(user: User, notification: Notification): Promise<NotifyOutcome>;
}
