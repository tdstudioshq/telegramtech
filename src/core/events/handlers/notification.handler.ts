/**
 * Notification handlers (§9 MVP handlers table): PaymentFailed → retry offer,
 * SubscriptionActivated → welcome, SubscriptionExpired → renew prompt.
 * Handlers only ENQUEUE intents — sending happens in the notification job's
 * drain, so a slow Telegram API never runs inside event dispatch. Enqueueing is
 * naturally idempotent-enough: dispatch-at-most-once per process (ADR-010).
 * Registration happens in app.ts so the wiring stays visible in one place.
 */
import type { NotificationEngine } from '../../engines/notification.engine.js';
import type { EventHandler } from '../dispatcher.js';

export const paymentFailedNotification =
  (engine: NotificationEngine): EventHandler<'PaymentFailed'> =>
  (event) =>
    engine.enqueue({
      userId: event.userId,
      notification: {
        kind: 'payment_failed',
        text: `Your payment of ${event.amountStars} ⭐ didn't go through — you have not been charged. Tap the button again to retry.`,
      },
    });

export const subscriptionActivatedNotification =
  (engine: NotificationEngine): EventHandler<'SubscriptionActivated'> =>
  (event) =>
    engine.enqueue({
      userId: event.userId,
      notification: {
        kind: 'subscription_activated',
        text: `Welcome aboard! Your premium access is active until ${event.expiresAt.toISOString().slice(0, 10)}.`,
      },
    });

export const subscriptionExpiredNotification =
  (engine: NotificationEngine): EventHandler<'SubscriptionExpired'> =>
  (event) =>
    engine.enqueue({
      userId: event.userId,
      notification: {
        kind: 'subscription_expired',
        text: 'Your premium access has expired. Renew any time to pick up right where you left off.',
      },
    });
