import { defineConfig } from 'vitest/config';

/**
 * Integration tests: repositories + DB constraints against real Postgres.
 * Requires TEST_DATABASE_URL (see SETUP.md). Files run sequentially — they share
 * one database whose schema is reset once in global setup.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
