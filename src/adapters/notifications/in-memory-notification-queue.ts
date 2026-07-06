/**
 * InMemoryNotificationQueue (M7.3.1) — the MVP default NotificationQueue: a
 * per-process array with an atomic swap-and-return drain, preserving the exact
 * behavior NotificationEngine had when it owned the array inline. Per-process is
 * tracked debt #1; a shared RedisNotificationQueue / DB outbox implements the same
 * port for horizontal scale (M7.4) with no change to core.
 */
import type {
  NotificationIntent,
  NotificationQueue,
} from '../../core/ports/notification-queue.port.js';

export class InMemoryNotificationQueue implements NotificationQueue {
  private queue: NotificationIntent[] = [];

  async enqueue(intent: NotificationIntent): Promise<void> {
    this.queue.push(intent);
  }

  async drainPending(limit?: number): Promise<NotificationIntent[]> {
    if (limit === undefined || limit >= this.queue.length) {
      const batch = this.queue;
      this.queue = []; // atomic swap: nothing else can observe these intents again
      return batch;
    }
    return this.queue.splice(0, limit);
  }

  async size(): Promise<number> {
    return this.queue.length;
  }
}
