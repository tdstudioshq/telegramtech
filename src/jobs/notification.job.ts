/**
 * Notification job (§11, every 1 min by default) — drains queued notification
 * intents through the Notifier. NotificationEngine.drainPending owns the dedup
 * (it swaps the queue atomically, so no intent is sent twice), the transient
 * retry (failed → re-queued for the next drain), and blocked-user handling
 * (blocked → users.is_blocked, never retried forever). The job just invokes it.
 */
import type { NotificationEngine } from '../core/engines/notification.engine.js';
import type { Job, JobContext, JobRunStats } from './scheduler.js';

export interface NotificationJobConfig {
  readonly intervalMs: number;
  readonly lockTtlSeconds: number;
}

export const createNotificationJob = (
  notifications: NotificationEngine,
  config: NotificationJobConfig,
): Job => ({
  name: 'notification',
  intervalMs: config.intervalMs,
  lockTtlSeconds: config.lockTtlSeconds,
  async run(ctx: JobContext): Promise<JobRunStats> {
    const stats = await notifications.drainPending();
    ctx.logger.debug(stats, 'notification drain');
    return { processed: stats.sent + stats.blocked + stats.failed + stats.skipped, ...stats };
  },
});
