/**
 * Boot: config → logger. Clients and jobs are wired in via app.ts from M3+;
 * for the M1 skeleton the process validates its environment and reports readiness.
 */
import { APP_NAME } from './config/constants.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './logging/logger.js';

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, name: APP_NAME });

logger.info(
  { nodeEnv: env.NODE_ENV, botMode: env.BOT_MODE, paymentProvider: env.PAYMENT_PROVIDER },
  'boot ok — M1 skeleton (composition root, clients, and jobs land in M2+)',
);
