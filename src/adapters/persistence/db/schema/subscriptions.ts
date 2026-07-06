/**
 * DATABASE.md rev 2.2 §6. The (user_id, creator_id, status) index serves the live
 * premium entitlement check (ADR-011); (status, expires_at) serves the sweep.
 * The one-active-per-creator partial unique index DB-enforces the entitlement grain
 * (ADR-021 / M7.3.1): a user may hold at most one active subscription per creator.
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
    // one active subscription per (user, creator) — DB-enforced (M7.3.1). Entitlement
    // is per-creator (ADR-011), so this is the correct grain: it also subsumes the
    // former per-plan guard, since a creator's plans are mutually exclusive when active.
    uniqueIndex('subscriptions_one_active_per_creator_uq')
      .on(t.userId, t.creatorId)
      .where(sql`${t.status} = 'active'`),
    index('subscriptions_entitlement_idx').on(t.userId, t.creatorId, t.status),
    index('subscriptions_sweep_idx').on(t.status, t.expiresAt),
  ],
);
