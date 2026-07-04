/** `pnpm db:seed` entry — env parse-or-crash, run the idempotent seed, exit. */
import { loadEnv } from '../../../config/env.js';
import { createLogger } from '../../../logging/logger.js';
import { createDatabase } from './client.js';
import { runSeed } from './seed.js';

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, name: 'db:seed' });
const { db, close } = createDatabase(env.DATABASE_URL);

try {
  await runSeed(db);
  logger.info('seed complete (idempotent — re-runs are no-ops)');
} finally {
  await close();
}
