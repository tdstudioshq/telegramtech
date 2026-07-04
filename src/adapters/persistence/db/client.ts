/**
 * Drizzle client over postgres-js. Runtime connections go through the Supabase
 * pooler (transaction mode) — prepared statements must stay off (SETUP.md).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type DbClient = PostgresJsDatabase<typeof schema>;
/** A live transaction inside DbClient.transaction() — same query surface as DbClient. */
export type DbSession = DbClient | Parameters<Parameters<DbClient['transaction']>[0]>[0];

export interface Database {
  db: DbClient;
  /** Liveness probe for the health endpoint — a trivial round-trip to the pooler. */
  ping: () => Promise<void>;
  /** Close the underlying connection pool (jobs/tests teardown). */
  close: () => Promise<void>;
}

export const createDatabase = (connectionString: string): Database => {
  const client = postgres(connectionString, { prepare: false });
  return {
    db: drizzle(client, { schema }),
    ping: async () => {
      await client`select 1`;
    },
    close: () => client.end(),
  };
};
