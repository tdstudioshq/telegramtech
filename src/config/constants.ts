export const APP_NAME = 'creator-platform';

/** Release version — kept in sync with package.json; surfaced by the health endpoint. */
export const APP_VERSION = '0.2.1-platform';

/** HTTP path Railway's health check probes (must match railway.json healthcheckPath). */
export const HEALTH_PATH = '/health';

/** Max time a graceful shutdown may take before the process force-exits (ms). */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Per-run batch sizes for the M5 sweeps. Bounded so a backlog drains over several
 * ticks instead of one giant transaction; the sweeps are idempotent so leftovers
 * are picked up on the next interval.
 */
export const SUBSCRIPTION_SWEEP_BATCH = 100;
export const STALE_PAYMENT_BATCH = 100;
