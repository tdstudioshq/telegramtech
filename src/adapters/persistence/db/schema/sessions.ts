/**
 * M7.1 — opaque bearer sessions for the dashboard/API. Only the SHA-256 hash of the
 * token is stored, so a DB leak never yields a live session. Transport-agnostic:
 * the same session model serves the future SPA, mobile, and public API.
 */
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { creatorIdentities } from './creator-identities.js';

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => creatorIdentities.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_identity_idx').on(t.identityId)],
);
