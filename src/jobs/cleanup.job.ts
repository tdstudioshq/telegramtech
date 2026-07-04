/**
 * Cleanup job (§11, every 30 min by default).
 *
 * Implemented: PurchaseService.failStalePending — pending payment/purchase pairs
 * stranded by a crash between TX1 and TX2 are failed (idempotently, correlation-
 * stamped, PaymentFailed raised for a retry prompt).
 *
 * Deferred (accepted debt — see docs/ROADMAP.md): orphaned-storage / transport_cache
 * pruning. The ContentProvider port has no bucket-listing capability and
 * transport_cache carries no expiry metadata, so any destructive pruning would
 * require a schema/port change M5 must not make (source-of-truth bucket; a
 * migration is a human-reviewed stop point). The step is a logged placeholder so
 * the seam stays visible — replace this body, not the scheduler, when it lands.
 */
import type { PurchaseService } from '../core/services/purchase.service.js';
import type { Job, JobContext, JobRunStats } from './scheduler.js';

export interface CleanupJobConfig {
  readonly intervalMs: number;
  readonly lockTtlSeconds: number;
  readonly stalePendingMinutes: number;
  readonly batchSize: number;
}

export const createCleanupJob = (
  purchases: PurchaseService,
  config: CleanupJobConfig,
): Job => ({
  name: 'cleanup',
  intervalMs: config.intervalMs,
  lockTtlSeconds: config.lockTtlSeconds,
  async run(ctx: JobContext): Promise<JobRunStats> {
    const stalePendingFailed = await purchases.failStalePending(
      config.stalePendingMinutes,
      config.batchSize,
      ctx.correlationId,
    );
    ctx.logger.debug('orphaned-storage scan skipped (deferred — see ROADMAP debt register)');
    return { processed: stalePendingFailed, stalePendingFailed };
  },
});
