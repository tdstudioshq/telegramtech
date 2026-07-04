/**
 * DATABASE.md rev 2.2 §9 — entitlement ledger for pay-per-unlock purchases and
 * manual comps ONLY. Subscription entitlement is computed live, never materialized
 * here (ADR-011). Access predicate: revoked_at IS NULL.
 */
import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { grantTypeEnum } from './enums.js';
import { creators } from './creators.js';
import { drops } from './drops.js';
import { purchases } from './purchases.js';
import { users } from './users.js';

export const accessGrants = pgTable(
  'access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    dropId: uuid('drop_id')
      .notNull()
      .references(() => drops.id),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    grantType: grantTypeEnum('grant_type').notNull(),
    // provenance (null for manual comps)
    sourcePurchaseId: uuid('source_purchase_id').references(() => purchases.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one live grant per user per drop — DB-enforced
    uniqueIndex('access_grants_one_live_uq')
      .on(t.userId, t.dropId)
      .where(sql`${t.revokedAt} IS NULL`),
    index('access_grants_creator_idx').on(t.creatorId),
  ],
);
