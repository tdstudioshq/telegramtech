/**
 * Resets the test database and applies the generated migrations — the same SQL
 * that will run against Supabase, validated here against real Postgres.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export default async function globalSetup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required for integration tests, e.g.\n' +
        '  docker run -d --name creator-platform-test-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:17\n' +
        '  TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54329/postgres pnpm test:integration',
    );
  }
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await client`DROP SCHEMA IF EXISTS public CASCADE`;
    await client`CREATE SCHEMA public`;
    await client`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await migrate(drizzle(client), {
      migrationsFolder: 'src/adapters/persistence/db/migrations',
    });
  } finally {
    await client.end();
  }
}
