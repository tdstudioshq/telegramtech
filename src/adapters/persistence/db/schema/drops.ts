/** DATABASE.md rev 2.2 §3 — drops; content columns live in drop_assets. */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accessTypeEnum, dropStatusEnum } from './enums.js';
import { creators } from './creators.js';

export const drops = pgTable(
  'drops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    title: text('title').notNull(),
    description: text('description'),
    previewText: text('preview_text'),
    accessType: accessTypeEnum('access_type').notNull(),
    priceStars: integer('price_stars'),
    status: dropStatusEnum('status').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('drops_creator_status_idx').on(t.creatorId, t.status),
    // browse queries: partial on published drops only
    index('drops_creator_access_published_idx')
      .on(t.creatorId, t.accessType)
      .where(sql`${t.status} = 'published'`),
    // price is present iff the drop is pay_per_unlock (Q2)
    check(
      'drops_price_matches_access_type',
      sql`(${t.accessType} = 'pay_per_unlock' AND ${t.priceStars} > 0) OR (${t.accessType} <> 'pay_per_unlock' AND ${t.priceStars} IS NULL)`,
    ),
  ],
);
