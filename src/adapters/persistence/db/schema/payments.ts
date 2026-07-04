/** DATABASE.md rev 2.2 §8 — tenant revenue rows; unique idempotency_key absorbs double-taps. */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { paymentProviderEnum, paymentStatusEnum } from './enums.js';
import { creators } from './creators.js';

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // payments are tenant revenue — filterable per creator without joins (future payouts)
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    provider: paymentProviderEnum('provider').notNull(),
    providerChargeId: text('provider_charge_id'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    amountStars: integer('amount_stars').notNull(),
    currency: text('currency').notNull().default('XTR'),
    status: paymentStatusEnum('status').notNull(),
    rawPayload: jsonb('raw_payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_provider_charge_idx').on(t.provider, t.providerChargeId),
    index('payments_creator_status_created_idx').on(t.creatorId, t.status, t.createdAt),
    check('payments_amount_positive', sql`${t.amountStars} > 0`),
  ],
);
