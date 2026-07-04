/** DATABASE.md rev 2.2 §5 — MVP seeds exactly one Premium plan (Q3); schema is tier-ready. */
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { planStatusEnum } from './enums.js';
import { creators } from './creators.js';

export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    name: text('name').notNull(),
    description: text('description'),
    priceStars: integer('price_stars').notNull(),
    durationDays: integer('duration_days').notNull(),
    status: planStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('subscription_plans_price_positive', sql`${t.priceStars} > 0`),
    check('subscription_plans_duration_positive', sql`${t.durationDays} > 0`),
  ],
);
