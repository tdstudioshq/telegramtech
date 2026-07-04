/** Boot: config → composition root → Telegram client + background job scheduler. */
import { createApplication } from './app.js';
import { APP_NAME } from './config/constants.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './logging/logger.js';

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, name: APP_NAME });
const app = createApplication(env, logger);

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutdown requested');
  await app.stop(signal);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  logger.info(
    { nodeEnv: env.NODE_ENV, botMode: env.BOT_MODE, paymentProvider: env.PAYMENT_PROVIDER },
    'starting application',
  );
  await app.start();
} catch (error) {
  logger.fatal({ err: error }, 'application failed to start');
  await app.stop('startup failure');
  process.exitCode = 1;
}
