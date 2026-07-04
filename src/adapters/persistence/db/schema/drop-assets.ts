/**
 * DATABASE.md rev 2.2 §4 — storage source of truth (Q1) + delivery cache.
 * Interpretation note (flagged for review): the §4 CHECK ("text type ⇒ text_content set;
 * media types ⇒ storage path set") implies storage columns are unset for text assets,
 * so storage_bucket/storage_path are nullable with the CHECK enforcing shape per type.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { contentTypeEnum } from './enums.js';
import { creators } from './creators.js';
import { drops } from './drops.js';

export const dropAssets = pgTable(
  'drop_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dropId: uuid('drop_id')
      .notNull()
      .references(() => drops.id),
    // tenant key (denormalized per §4)
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    position: integer('position').notNull().default(0),
    contentType: contentTypeEnum('content_type').notNull(),
    storageBucket: text('storage_bucket'),
    storagePath: text('storage_path'),
    mimeType: text('mime_type'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'bigint' }),
    textContent: text('text_content'),
    // rebuildable optimization, never authoritative (e.g. {"telegram:<botId>": "<file_id>"})
    transportCache: jsonb('transport_cache'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('drop_assets_drop_position_uq').on(t.dropId, t.position),
    index('drop_assets_creator_idx').on(t.creatorId),
    check(
      'drop_assets_content_shape',
      sql`(${t.contentType} = 'text' AND ${t.textContent} IS NOT NULL) OR (${t.contentType} <> 'text' AND ${t.storageBucket} IS NOT NULL AND ${t.storagePath} IS NOT NULL)`,
    ),
  ],
);
