/**
 * Idempotent seed (M2): creator, one Premium plan (Q3), drops of all three access
 * types (Q2), system settings. Deterministic UUIDs + ON CONFLICT DO NOTHING make
 * re-runs no-ops that never clobber later manual edits.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { DbClient } from './client.js';
import {
  botSettings,
  creators,
  dropAssets,
  drops,
  subscriptionPlans,
  systemSettings,
  users,
} from './schema/index.js';

/** Deep-link handle for the seeded demo creator (M7.0); also the DEFAULT_CREATOR_SLUG default. */
export const SEED_CREATOR_SLUG = 'demo';

/** Fixed ids so re-runs target the same rows and FKs stay stable across environments. */
export const SEED_IDS = {
  creatorUser: '5eed0000-0000-4000-8000-000000000001',
  creator: '5eed0000-0000-4000-8000-000000000002',
  premiumPlan: '5eed0000-0000-4000-8000-000000000003',
  dropFree: '5eed0000-0000-4000-8000-000000000010',
  dropPremium: '5eed0000-0000-4000-8000-000000000011',
  dropUnlock: '5eed0000-0000-4000-8000-000000000012',
  assetFree: '5eed0000-0000-4000-8000-000000000020',
  assetPremium: '5eed0000-0000-4000-8000-000000000021',
  assetUnlock: '5eed0000-0000-4000-8000-000000000022',
} as const;

/** Placeholder telegram id for the seeded creator's user row (replaced on real /start). */
const SEED_CREATOR_TELEGRAM_ID = 7_000_000_001n;

export const runSeed = async (db: DbClient, now: () => Date = () => new Date()): Promise<void> => {
  await db
    .insert(users)
    .values({
      id: SEED_IDS.creatorUser,
      telegramId: SEED_CREATOR_TELEGRAM_ID,
      username: 'seed_creator',
      firstName: 'Seed',
      lastName: 'Creator',
    })
    .onConflictDoNothing();

  await db
    .insert(creators)
    .values({
      id: SEED_IDS.creator,
      userId: SEED_IDS.creatorUser,
      displayName: 'Demo Creator',
      slug: SEED_CREATOR_SLUG,
      bio: 'Seeded MVP creator (single tenant until SaaS onboarding).',
      status: 'active',
    })
    .onConflictDoNothing();

  // Backfill the slug on a pre-M7.0 seed row (insert above is a no-op once it exists).
  // Idempotent: only sets when still null, never clobbers a manually chosen slug.
  await db
    .update(creators)
    .set({ slug: SEED_CREATOR_SLUG })
    .where(and(eq(creators.id, SEED_IDS.creator), isNull(creators.slug)));

  await db
    .insert(subscriptionPlans)
    .values({
      id: SEED_IDS.premiumPlan,
      creatorId: SEED_IDS.creator,
      name: 'Premium',
      description: 'Access to all premium drops while active.',
      priceStars: 250,
      durationDays: 30,
      status: 'active',
    })
    .onConflictDoNothing();

  const publishedAt = now();
  await db
    .insert(drops)
    .values([
      {
        id: SEED_IDS.dropFree,
        creatorId: SEED_IDS.creator,
        title: 'Welcome drop (free)',
        description: 'A free sample everyone can open.',
        previewText: 'Free for everyone — tap to view.',
        accessType: 'free',
        priceStars: null,
        status: 'published',
        publishedAt,
      },
      {
        id: SEED_IDS.dropPremium,
        creatorId: SEED_IDS.creator,
        title: 'Members lounge (premium)',
        description: 'Visible to active Premium subscribers.',
        previewText: 'Subscribe to Premium to unlock.',
        accessType: 'premium',
        priceStars: null,
        status: 'published',
        publishedAt,
      },
      {
        id: SEED_IDS.dropUnlock,
        creatorId: SEED_IDS.creator,
        title: 'Exclusive single (pay-per-unlock)',
        description: 'One-time unlock, yours forever.',
        previewText: 'Unlock once for ⭐50.',
        accessType: 'pay_per_unlock',
        priceStars: 50,
        status: 'published',
        publishedAt,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(dropAssets)
    .values([
      {
        id: SEED_IDS.assetFree,
        dropId: SEED_IDS.dropFree,
        creatorId: SEED_IDS.creator,
        position: 0,
        contentType: 'text',
        textContent: 'Welcome! This is the free seeded drop. 🎉',
      },
      {
        id: SEED_IDS.assetPremium,
        dropId: SEED_IDS.dropPremium,
        creatorId: SEED_IDS.creator,
        position: 0,
        contentType: 'text',
        textContent: 'Premium members only — thanks for subscribing. 💎',
      },
      {
        id: SEED_IDS.assetUnlock,
        dropId: SEED_IDS.dropUnlock,
        creatorId: SEED_IDS.creator,
        position: 0,
        contentType: 'text',
        textContent: 'You unlocked the exclusive drop. ⭐',
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(systemSettings)
    .values([
      {
        key: 'maintenance_mode',
        category: 'maintenance',
        value: false,
        description: 'When true, clients answer with a maintenance notice instead of serving.',
      },
      {
        key: 'payments.mock_enabled',
        category: 'payments',
        value: true,
        description: 'Mock payment provider active (MVP). Flip only when real Stars ships.',
      },
    ])
    .onConflictDoNothing({ target: systemSettings.key });

  // platform-default bot settings row (creator_id NULL) — safe example key
  await db
    .insert(botSettings)
    .values({
      creatorId: null,
      key: 'welcome_message',
      value: 'Welcome! Browse /drops to see what is available.',
      description: 'Platform-default /start greeting (creator rows override).',
    })
    .onConflictDoNothing();
};
