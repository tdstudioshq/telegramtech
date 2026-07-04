/** DATABASE.md rev 2.2 §2 — the tenant table; every tenant-owned row points here. */
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { creatorStatusEnum } from './enums.js';
import { users } from './users.js';

export const creators = pgTable('creators', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  displayName: text('display_name').notNull(),
  bio: text('bio'),
  status: creatorStatusEnum('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
