/**
 * DATABASE.md rev 2.2 §11 — bot_settings (tenant-scopable) & system_settings (global).
 * Values are jsonb, Zod-validated on read (ADR-013).
 * bot_settings uniqueness uses UNIQUE NULLS NOT DISTINCT so exactly one platform-default
 * row (creator_id NULL) can exist per key — the native PG15+ form of the documented
 * "coalesced unique index" intent.
 */
import { jsonb, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { creators } from './creators.js';
import { users } from './users.js';

export const botSettings = pgTable(
  'bot_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL = platform default; a row with creator_id overrides it
    creatorId: uuid('creator_id').references(() => creators.id),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    description: text('description'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('bot_settings_creator_key_uq').on(t.creatorId, t.key).nullsNotDistinct()],
);

export const systemSettings = pgTable('system_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  // groups settings for administration/filtering: payments, telegram, storage, jobs, maintenance
  category: varchar('category', { length: 50 }).notNull(),
  value: jsonb('value').notNull(),
  description: text('description'),
  // future admin-dashboard provenance; NULL for system changes and throughout MVP
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
