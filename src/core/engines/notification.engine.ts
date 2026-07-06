/**
 * NotificationEngine — notification intents → Notifier (§1). Event handlers
 * enqueue intents; the M5 notification job calls drainPending on an interval.
 * Storage lives behind the NotificationQueue port (M7.3.1) so it can become
 * shared/distributed for horizontal scale (M7.4) without touching this engine;
 * the MVP default (InMemoryNotificationQueue) is per-process (ADR-010 trade-off).
 *
 * Outcome handling stays here (business logic): `sent` done · `failed` re-queued
 * for the next drain (transient) · `blocked` marks users.is_blocked and drops the
 * intent — a user who blocked the bot is never retried forever.
 */
import type { Notifier } from '../ports/notifier.port.js';
import type { NotificationIntent, NotificationQueue } from '../ports/notification-queue.port.js';
import type { UnitOfWork } from '../repositories/index.js';

export type { NotificationIntent };

export interface DrainStats {
  readonly sent: number;
  readonly blocked: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Per-tick drain bound (mirrors the M5 sweeps' bounded batches): a backlog drains over
 * several ticks instead of one unbounded pull. Keeps each drain small and fast — under
 * the Redis command deadline — so an atomic queue drain can never be removed-but-not-sent,
 * and no single replica monopolizes a large backlog at scale.
 */
const DRAIN_BATCH = 500;

export class NotificationEngine {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly notifier: Notifier,
    private readonly queue: NotificationQueue,
  ) {}

  enqueue(intent: NotificationIntent): Promise<void> {
    return this.queue.enqueue(intent);
  }

  size(): Promise<number> {
    return this.queue.size();
  }

  async drainPending(): Promise<DrainStats> {
    const batch = await this.queue.drainPending(DRAIN_BATCH);
    let sent = 0;
    let blocked = 0;
    let failed = 0;
    let skipped = 0;

    for (const intent of batch) {
      const user = await this.uow.run(async (repos) => repos.users.findById(intent.userId));
      if (user === null || user.isBlocked) {
        skipped += 1;
        continue;
      }
      const outcome = await this.notifier.notify(user, intent.notification);
      if (outcome === 'sent') {
        sent += 1;
      } else if (outcome === 'blocked') {
        blocked += 1;
        await this.uow.run(async (repos) => repos.users.setBlocked(user.id, true));
      } else {
        failed += 1;
        await this.queue.enqueue(intent); // transient — retry on the next drain
      }
    }
    return { sent, blocked, failed, skipped };
  }
}
