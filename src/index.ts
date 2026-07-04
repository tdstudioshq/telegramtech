/** Boot: config → composition root → Telegram client + background job scheduler. */
import { createApplication } from './app.js';
import { APP_NAME, APP_VERSION, HEALTH_PATH, SHUTDOWN_TIMEOUT_MS } from './config/constants.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './logging/logger.js';

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, name: APP_NAME });

// Startup diagnostics — a hand-picked, secret-free summary of the effective config.
// (Never log the raw env: DATABASE_URL/keys carry credentials.)
logger.info(
  {
    version: APP_VERSION,
    nodeEnv: env.NODE_ENV,
    botMode: env.BOT_MODE,
    paymentProvider: env.PAYMENT_PROVIDER,
    cacheProvider: env.CACHE_PROVIDER,
    port: env.PORT,
    healthPath: HEALTH_PATH,
    jobIntervalsMin: {
      subscriptionSweep: env.JOB_SUBSCRIPTION_SWEEP_INTERVAL,
      notification: env.JOB_NOTIFICATION_INTERVAL,
      cleanup: env.JOB_CLEANUP_INTERVAL,
    },
    logLevel: env.LOG_LEVEL,
  },
  'starting application',
);
if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'mock') {
  logger.warn('running with MOCK payments in production (MVP launch posture — no real Stars charged)');
}

const app = createApplication(env, logger);

let stopping = false;
const shutdown = async (reason: string, exitCode: number): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, 'shutdown requested');
  const force = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  let code = exitCode;
  try {
    await app.stop(reason);
    logger.info('shutdown complete');
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    code = 1;
  }
  clearTimeout(force);
  process.exit(code);
};

process.once('SIGINT', () => void shutdown('SIGINT', 0));
process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

try {
  await app.start();
} catch (error) {
  logger.fatal({ err: error }, 'application failed to start');
  await app.stop('startup failure');
  process.exit(1);
}
