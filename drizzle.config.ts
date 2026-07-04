/**
 * drizzle-kit config. Migrations connect via DATABASE_DIRECT_URL (port 5432),
 * never the pooler (SETUP.md). `db:generate` works offline from the schema;
 * the URL is only needed for `db:migrate` — which runs only after human review
 * of the generated SQL (project rule: migrations are reviewed before apply).
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/adapters/persistence/db/schema/index.ts',
  out: './src/adapters/persistence/db/migrations',
  dbCredentials: { url: process.env['DATABASE_DIRECT_URL'] ?? '' },
  strict: true,
  verbose: true,
});
