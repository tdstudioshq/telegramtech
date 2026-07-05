/**
 * M7.1 — web/API login identity for a creator, distinct from a Telegram `users` row
 * (proposed ADR-023). One identity per creator for now (teams/agencies later).
 * `password_hash` is a self-describing scrypt string; email is stored lower-cased.
 */
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { creators } from './creators.js';

export const creatorIdentities = pgTable('creator_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id')
    .notNull()
    .unique()
    .references(() => creators.id),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
