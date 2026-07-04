import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../../src/adapters/persistence/db/client.js';
import { buildRepositories } from '../../src/adapters/persistence/repositories/repositories.js';
import type { Repositories } from '../../src/core/repositories/index.js';
import type { Creator, SubscriptionPlan, User } from '../../src/shared/entities.js';

export interface TestContext {
  db: Database;
  repos: Repositories;
}

export const connect = (): TestContext => {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL missing (global setup should have failed first)');
  const db = createDatabase(url);
  return { db, repos: buildRepositories(db.db) };
};

let telegramIdCounter = 0n;
/** Unique per call within a run — telegram_id is globally unique in the schema. */
export const nextTelegramId = (): bigint => {
  telegramIdCounter += 1n;
  return (
    900_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)) * 10_000n + telegramIdCounter
  );
};

export const makeUser = async (repos: Repositories): Promise<User> =>
  repos.users.create({ telegramId: nextTelegramId(), username: `u_${randomUUID().slice(0, 8)}` });

export const makeCreator = async (
  repos: Repositories,
): Promise<{ user: User; creator: Creator }> => {
  const user = await makeUser(repos);
  const creator = await repos.creators.create({
    userId: user.id,
    displayName: `Creator ${randomUUID().slice(0, 8)}`,
    status: 'active',
  });
  return { user, creator };
};

export const makePlan = async (repos: Repositories, creatorId: string): Promise<SubscriptionPlan> =>
  repos.plans.create({
    creatorId,
    name: `Plan ${randomUUID().slice(0, 8)}`,
    priceStars: 100,
    durationDays: 30,
    status: 'active',
  });

/** Postgres unique_violation error code. */
export const UNIQUE_VIOLATION = '23505';

/** Drizzle wraps driver errors (DrizzleQueryError.cause = PostgresError) — check both. */
export const expectUniqueViolation = async (promise: Promise<unknown>): Promise<void> => {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected a unique_violation, but the statement succeeded');
    },
    (thrown: unknown) => thrown,
  );
  const code =
    (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  if (code !== UNIQUE_VIOLATION) throw error;
};
