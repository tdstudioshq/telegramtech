/**
 * Subscription-expiration job (§11, every 5 min by default) — flips lapsed active
 * subscriptions to expired. All logic lives in SubscriptionService.expireLapsed;
 * the job only forwards config + the run's correlation id (which lands on the
 * `subscription.expired` audit rows, proving end-to-end propagation).
 */
import type { SubscriptionService } from '../core/services/subscription.service.js';
import type { Job, JobContext, JobRunStats } from './scheduler.js';

export interface SubscriptionExpirationJobConfig {
  readonly intervalMs: number;
  readonly lockTtlSeconds: number;
  readonly batchSize: number;
}

export const createSubscriptionExpirationJob = (
  subscriptions: SubscriptionService,
  config: SubscriptionExpirationJobConfig,
): Job => ({
  name: 'subscription-expiration',
  intervalMs: config.intervalMs,
  lockTtlSeconds: config.lockTtlSeconds,
  async run(ctx: JobContext): Promise<JobRunStats> {
    const expired = await subscriptions.expireLapsed(config.batchSize, ctx.correlationId);
    return { processed: expired, expired };
  },
});
