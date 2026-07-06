/** DATABASE.md rev 2.2 §2 — the tenant table; every tenant-owned row points here. */
import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { creatorStatusEnum } from './enums.js';
import { users } from './users.js';

export const creators = pgTable(
  'creators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Nullable since M7.1: a web-registered creator has a creator_identity, not a Telegram user.
    userId: uuid('user_id')
      .unique()
      .references(() => users.id),
    displayName: text('display_name').notNull(),
    // shared-bot deep-link handle (M7.0); nullable + unique so multiple pre-backfill rows coexist
    slug: text('slug').unique(),
    bio: text('bio'),
    // profile (M7.1)
    avatarUrl: text('avatar_url'),
    // self-service onboarding completion marker (M7.2); null = still onboarding
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    // marketplace (M7.3): a single free-text category + editorial featured flag
    category: text('category'),
    isFeatured: boolean('is_featured').notNull().default(false),
    status: creatorStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Marketplace indexes (M7.3.1). The pg_trgm GIN indexes on display_name/slug that serve
  // the ILIKE search live in the migration (Drizzle doesn't manage extensions) — see
  // migration 0006 and DATABASE.md §2.
  (t) => [
    // Serves the discoverable() predicate + (is_featured, created_at) ordering; a backward
    // index scan covers the ORDER BY is_featured DESC, created_at DESC.
    index('creators_discoverable_idx')
      .on(t.isFeatured, t.createdAt)
      .where(
        sql`${t.status} = 'active' and ${t.slug} is not null and ${t.onboardingCompletedAt} is not null`,
      ),
    // Category filter + distinct-category listing over discoverable creators.
    index('creators_category_idx')
      .on(t.category)
      .where(
        sql`${t.status} = 'active' and ${t.slug} is not null and ${t.onboardingCompletedAt} is not null and ${t.category} is not null`,
      ),
  ],
);
