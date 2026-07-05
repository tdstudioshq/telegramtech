/**
 * M7.3 — a Telegram user following a creator's storefront (for discovery + new-drop
 * notifications). One row per (user, creator); users are platform-level, creators
 * are the tenant. Distinct from paid subscriptions.
 */
import { index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { creators } from './creators.js';
import { users } from './users.js';

export const follows = pgTable(
  'follows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    followedAt: timestamp('followed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('follows_user_creator_uq').on(t.userId, t.creatorId),
    index('follows_creator_idx').on(t.creatorId),
  ],
);
