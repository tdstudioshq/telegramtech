/**
 * DATABASE.md rev 2.2 §6. The (user_id, creator_id, status) index serves the live
 * premium entitlement check (ADR-011); (status, expires_at) serves the sweep.
 */
import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { subscriptionStatusEnum } from './enums.js';
import { creators } from './creators.js';
import { subscriptionPlans } from './subscription-plans.js';
import { users } from './users.js';

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    planId: uuid('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id),
    // tenant key (denormalized per §6)
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    status: subscriptionStatusEnum('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one active subscription per (user, plan) — DB-enforced
    uniqueIndex('subscriptions_one_active_per_plan_uq')
      .on(t.userId, t.planId)
      .where(sql`${t.status} = 'active'`),
    index('subscriptions_entitlement_idx').on(t.userId, t.creatorId, t.status),
    index('subscriptions_sweep_idx').on(t.status, t.expiresAt),
  ],
);
