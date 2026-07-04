/**
 * NotificationEngine — notification intents → Notifier (§1). Event handlers
 * enqueue intents (cheap, sync, in-process); the M5 notification job calls
 * drainPending on an interval. Intents are as durable as domain events are
 * (in-process, ADR-010 trade-off — accepted).
 *
 * Outcome handling: `sent` done · `failed` re-queued for the next drain
 * (transient) · `blocked` marks users.is_blocked and drops the intent —
 * a user who blocked the bot is never retried forever.
 */
import type { UserId } from '../../shared/domain.js';
import type { Notification, Notifier } from '../ports/notifier.port.js';
import type { UnitOfWork } from '../repositories/index.js';

export interface NotificationIntent {
  readonly userId: UserId;
  readonly notification: Notification;
}

export interface DrainStats {
  readonly sent: number;
  readonly blocked: number;
  readonly failed: number;
  readonly skipped: number;
}

export class NotificationEngine {
  private queue: NotificationIntent[] = [];

  constructor(
    private readonly uow: UnitOfWork,
    private readonly notifier: Notifier,
  ) {}

  enqueue(intent: NotificationIntent): void {
    this.queue.push(intent);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  async drainPending(): Promise<DrainStats> {
    const batch = this.queue;
    this.queue = [];
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
        this.queue.push(intent); // transient — retry on the next drain
      }
    }
    return { sent, blocked, failed, skipped };
  }
}
