/** DATABASE.md rev 2.2 §7 — commerce records (distinct from access_grants, the entitlement ledger). */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { purchaseStatusEnum } from './enums.js';
import { creators } from './creators.js';
import { drops } from './drops.js';
import { payments } from './payments.js';
import { subscriptionPlans } from './subscription-plans.js';
import { users } from './users.js';

export const purchases = pgTable(
  'purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    dropId: uuid('drop_id').references(() => drops.id),
    planId: uuid('plan_id').references(() => subscriptionPlans.id),
    // 1:1 with payments
    paymentId: uuid('payment_id')
      .notNull()
      .unique()
      .references(() => payments.id),
    // snapshot at purchase time — drop/plan prices may change later
    amountStars: integer('amount_stars').notNull(),
    status: purchaseStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('purchases_user_library_idx').on(t.userId, t.createdAt.desc()),
    index('purchases_creator_idx').on(t.creatorId, t.createdAt.desc()),
    // a purchase targets exactly one of drop XOR plan
    check('purchases_target_xor', sql`(${t.dropId} IS NULL) <> (${t.planId} IS NULL)`),
  ],
);
