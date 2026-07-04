/**
 * Analytics job — registered NO-OP stub (§11, interval "—"). The analytics
 * pipeline stays event-driven via `analyticsStub` (the PurchaseCompleted handler
 * registered in app.ts); this reserves the job slot so a future batch/rollup
 * pipeline is added by replacing this body, not by touching the scheduler.
 * Registered with intervalMs 0 → wired and visible, but never ticked. Preserves
 * the existing event boundaries (it consumes nothing, emits nothing).
 */
import type { Job, JobRunStats } from './scheduler.js';

export const createAnalyticsJob = (): Job => ({
  name: 'analytics',
  intervalMs: 0, // no interval (§11) — registered for visibility, not scheduled
  lockTtlSeconds: 0,
  async run(): Promise<JobRunStats> {
    return { processed: 0 };
  },
});
