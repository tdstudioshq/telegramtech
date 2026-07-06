/**
 * NotificationQueue port (ADR-022 / M7.3.1) — the buffer between after-commit event
 * handlers (which enqueue intents) and the notification job (which drains + sends).
 *
 * Extracted from NotificationEngine so the STORAGE can become shared/distributed
 * without touching the engine or handlers: the MVP default is per-process
 * (InMemoryNotificationQueue), and a RedisNotificationQueue / DB-backed outbox
 * implements this same port for horizontal scale (M7.4, debt #1/#6). The methods are
 * async precisely so a network/DB-backed implementation is a drop-in — no code above
 * this port changes.
 *
 * Note (M7.4): a shared queue is necessary but not sufficient for numReplicas>1 — the
 * notification job is still gated by the scheduler's shared lock, so draining must
 * also be made replica-safe (drain unlocked, or per-replica). Tracked for M7.4.
 */
import type { UserId } from '../../shared/domain.js';
import type { Notification } from './notifier.port.js';

export interface NotificationIntent {
  readonly userId: UserId;
  readonly notification: Notification;
}

export interface NotificationQueue {
  /** Append an intent to the queue (after-commit; called by notification handlers). */
  enqueue(intent: NotificationIntent): Promise<void>;
  /**
   * Atomically remove and return the currently-queued intents (up to `limit` if given),
   * so the same intent is never handed to two drains — the dedup guarantee the engine
   * relies on. The caller sends them; transient failures are re-enqueued by the engine.
   */
  drainPending(limit?: number): Promise<NotificationIntent[]>;
  /** Approximate number of queued intents (diagnostics/tests). */
  size(): Promise<number>;
}
