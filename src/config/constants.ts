export const APP_NAME = 'creator-platform';

/**
 * Per-run batch sizes for the M5 sweeps. Bounded so a backlog drains over several
 * ticks instead of one giant transaction; the sweeps are idempotent so leftovers
 * are picked up on the next interval.
 */
export const SUBSCRIPTION_SWEEP_BATCH = 100;
export const STALE_PAYMENT_BATCH = 100;
