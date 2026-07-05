/**
 * Drizzle repository implementations (ADR-009) — the ONLY layer that touches
 * Drizzle. SQL in, domain types out; tenant filters per ADR-012.
 */
import { and, asc, desc, eq, gt, ilike, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type {
  AccessGrantRepository,
  AuditRepository,
  CreatorIdentityRepository,
  CreatorProfilePatch,
  CreatorRepository,
  CreatorSalesAggregate,
  DiscoverCreatorsQuery,
  DropRepository,
  FollowRepository,
  NewAccessGrant,
  NewAuditEntry,
  NewCreator,
  NewCreatorIdentity,
  NewDrop,
  NewFollow,
  NewDropAsset,
  NewPayment,
  NewPurchase,
  NewSession,
  NewSubscription,
  NewSubscriptionPlan,
  NewSystemSetting,
  NewUser,
  PaymentRepository,
  PurchaseRepository,
  Repositories,
  SessionRepository,
  SettingsRepository,
  SubscriptionPlanRepository,
  SubscriptionRepository,
  UserRepository,
} from '../../../core/repositories/index.js';
import type {
  AccessGrant,
  AuditLogEntry,
  BotSetting,
  Creator,
  CreatorIdentity,
  Drop,
  DropAsset,
  Payment,
  Purchase,
  Session,
  Subscription,
  SubscriptionPlan,
  SystemSetting,
  User,
} from '../../../shared/entities.js';
import type {
  CreatorId,
  DropAssetId,
  DropId,
  GrantId,
  PaymentId,
  PurchaseId,
  SubscriptionId,
  UserId,
} from '../../../shared/domain.js';
import type { DbSession } from '../db/client.js';
import {
  accessGrants,
  auditLogs,
  botSettings,
  creatorIdentities,
  creators,
  dropAssets,
  drops,
  follows,
  payments,
  purchases,
  sessions,
  subscriptionPlans,
  subscriptions,
  systemSettings,
  users,
} from '../db/schema/index.js';

const one = <T>(rows: T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error('expected an inserted row to be returned');
  return row;
};

const first = <T>(rows: T[]): T | null => rows[0] ?? null;

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: DbSession) {}

  async create(user: NewUser): Promise<User> {
    return one(await this.db.insert(users).values(user).returning());
  }

  async findById(id: UserId): Promise<User | null> {
    return first(await this.db.select().from(users).where(eq(users.id, id)).limit(1));
  }

  async findByTelegramId(telegramId: bigint): Promise<User | null> {
    return first(
      await this.db.select().from(users).where(eq(users.telegramId, telegramId)).limit(1),
    );
  }

  async setBlocked(id: UserId, isBlocked: boolean): Promise<void> {
    await this.db
      .update(users)
      .set({ isBlocked, updatedAt: sql`now()` })
      .where(eq(users.id, id));
  }
}

export class DrizzleCreatorRepository implements CreatorRepository {
  constructor(private readonly db: DbSession) {}

  async create(creator: NewCreator): Promise<Creator> {
    return one(await this.db.insert(creators).values(creator).returning());
  }

  async findById(id: CreatorId): Promise<Creator | null> {
    return first(await this.db.select().from(creators).where(eq(creators.id, id)).limit(1));
  }

  async findByUserId(userId: UserId): Promise<Creator | null> {
    return first(await this.db.select().from(creators).where(eq(creators.userId, userId)).limit(1));
  }

  async findBySlug(slug: string): Promise<Creator | null> {
    return first(await this.db.select().from(creators).where(eq(creators.slug, slug)).limit(1));
  }

  async update(id: CreatorId, patch: CreatorProfilePatch): Promise<Creator> {
    return one(
      await this.db
        .update(creators)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(creators.id, id))
        .returning(),
    );
  }

  async markOnboarded(id: CreatorId, at: Date): Promise<Creator> {
    return one(
      await this.db
        .update(creators)
        .set({ onboardingCompletedAt: at, updatedAt: sql`now()` })
        .where(eq(creators.id, id))
        .returning(),
    );
  }

  async listDiscoverable(query: DiscoverCreatorsQuery): Promise<Creator[]> {
    const filters = [discoverable()];
    if (query.query !== undefined && query.query.trim() !== '') {
      const pattern = `%${query.query.trim()}%`;
      filters.push(or(ilike(creators.displayName, pattern), ilike(creators.slug, pattern)));
    }
    if (query.category !== undefined) filters.push(eq(creators.category, query.category));
    return this.db
      .select()
      .from(creators)
      .where(and(...filters))
      .orderBy(desc(creators.isFeatured), desc(creators.createdAt))
      .limit(query.limit)
      .offset(query.offset);
  }

  async listFeatured(limit: number): Promise<Creator[]> {
    return this.db
      .select()
      .from(creators)
      .where(and(discoverable(), eq(creators.isFeatured, true)))
      .orderBy(desc(creators.createdAt))
      .limit(limit);
  }

  async listCategories(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ category: creators.category })
      .from(creators)
      .where(and(discoverable(), isNotNull(creators.category)));
    return rows
      .map((r) => r.category)
      .filter((c): c is string => c !== null)
      .sort();
  }
}

/** Marketplace-visible creators: active, with a storefront slug, onboarding complete. */
const discoverable = () =>
  and(
    eq(creators.status, 'active'),
    isNotNull(creators.slug),
    isNotNull(creators.onboardingCompletedAt),
  );

export class DrizzleFollowRepository implements FollowRepository {
  constructor(private readonly db: DbSession) {}

  async create(follow: NewFollow): Promise<void> {
    await this.db.insert(follows).values(follow).onConflictDoNothing();
  }

  async delete(userId: UserId, creatorId: CreatorId): Promise<void> {
    await this.db
      .delete(follows)
      .where(and(eq(follows.userId, userId), eq(follows.creatorId, creatorId)));
  }

  async exists(userId: UserId, creatorId: CreatorId): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(follows)
      .where(and(eq(follows.userId, userId), eq(follows.creatorId, creatorId)))
      .limit(1);
    return rows.length > 0;
  }

  async listCreatorsByUser(userId: UserId): Promise<Creator[]> {
    const rows = await this.db
      .select({ creator: creators })
      .from(follows)
      .innerJoin(creators, eq(follows.creatorId, creators.id))
      .where(eq(follows.userId, userId))
      .orderBy(desc(follows.followedAt));
    return rows.map((r) => r.creator);
  }

  async countByCreator(creatorId: CreatorId): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(follows)
      .where(eq(follows.creatorId, creatorId));
    return rows[0]?.n ?? 0;
  }
}

export class DrizzleCreatorIdentityRepository implements CreatorIdentityRepository {
  constructor(private readonly db: DbSession) {}

  async create(identity: NewCreatorIdentity): Promise<CreatorIdentity> {
    return one(await this.db.insert(creatorIdentities).values(identity).returning());
  }

  async findByEmail(email: string): Promise<CreatorIdentity | null> {
    return first(
      await this.db
        .select()
        .from(creatorIdentities)
        .where(eq(creatorIdentities.email, email))
        .limit(1),
    );
  }

  async findById(id: string): Promise<CreatorIdentity | null> {
    return first(
      await this.db.select().from(creatorIdentities).where(eq(creatorIdentities.id, id)).limit(1),
    );
  }
}

export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: DbSession) {}

  async create(session: NewSession): Promise<Session> {
    return one(await this.db.insert(sessions).values(session).returning());
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    return first(
      await this.db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1),
    );
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }
}

const mapAsset = (row: typeof dropAssets.$inferSelect): DropAsset => ({
  ...row,
  transportCache: row.transportCache as Record<string, string> | null,
});

export class DrizzleDropRepository implements DropRepository {
  constructor(private readonly db: DbSession) {}

  async create(drop: NewDrop): Promise<Drop> {
    return one(await this.db.insert(drops).values(drop).returning());
  }

  async findById(id: DropId): Promise<Drop | null> {
    return first(await this.db.select().from(drops).where(eq(drops.id, id)).limit(1));
  }

  async listPublishedByCreator(creatorId: CreatorId): Promise<Drop[]> {
    return this.db
      .select()
      .from(drops)
      .where(and(eq(drops.creatorId, creatorId), eq(drops.status, 'published')))
      .orderBy(desc(drops.publishedAt));
  }

  async listByCreator(creatorId: CreatorId): Promise<Drop[]> {
    return this.db
      .select()
      .from(drops)
      .where(eq(drops.creatorId, creatorId))
      .orderBy(desc(drops.createdAt));
  }

  async publish(id: DropId, at: Date): Promise<Drop> {
    return one(
      await this.db
        .update(drops)
        .set({ status: 'published', publishedAt: at, updatedAt: sql`now()` })
        .where(eq(drops.id, id))
        .returning(),
    );
  }

  async addAsset(asset: NewDropAsset): Promise<DropAsset> {
    return mapAsset(one(await this.db.insert(dropAssets).values(asset).returning()));
  }

  async listAssets(dropId: DropId): Promise<DropAsset[]> {
    const rows = await this.db
      .select()
      .from(dropAssets)
      .where(eq(dropAssets.dropId, dropId))
      .orderBy(dropAssets.position);
    return rows.map(mapAsset);
  }

  async cacheAssetTransport(
    creatorId: CreatorId,
    assetId: DropAssetId,
    key: string,
    transportId: string,
  ): Promise<void> {
    // jsonb merge: preserve other transports' cached ids, set/overwrite this key.
    // The merge object is a bound parameter (cast text → jsonb), never interpolated.
    const patch = JSON.stringify({ [key]: transportId });
    await this.db
      .update(dropAssets)
      .set({
        transportCache: sql`coalesce(${dropAssets.transportCache}, '{}'::jsonb) || ${patch}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(dropAssets.id, assetId), eq(dropAssets.creatorId, creatorId)));
  }
}

export class DrizzleSubscriptionPlanRepository implements SubscriptionPlanRepository {
  constructor(private readonly db: DbSession) {}

  async create(plan: NewSubscriptionPlan): Promise<SubscriptionPlan> {
    return one(await this.db.insert(subscriptionPlans).values(plan).returning());
  }

  async findById(id: string): Promise<SubscriptionPlan | null> {
    return first(
      await this.db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id)).limit(1),
    );
  }

  async findByCreatorAndName(creatorId: CreatorId, name: string): Promise<SubscriptionPlan | null> {
    return first(
      await this.db
        .select()
        .from(subscriptionPlans)
        .where(and(eq(subscriptionPlans.creatorId, creatorId), eq(subscriptionPlans.name, name)))
        .limit(1),
    );
  }

  async listActiveByCreator(creatorId: CreatorId): Promise<SubscriptionPlan[]> {
    return this.db
      .select()
      .from(subscriptionPlans)
      .where(and(eq(subscriptionPlans.creatorId, creatorId), eq(subscriptionPlans.status, 'active')))
      .orderBy(asc(subscriptionPlans.createdAt));
  }

  async listByCreator(creatorId: CreatorId): Promise<SubscriptionPlan[]> {
    return this.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.creatorId, creatorId))
      .orderBy(asc(subscriptionPlans.createdAt));
  }
}

export class DrizzleSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: DbSession) {}

  async create(subscription: NewSubscription): Promise<Subscription> {
    return one(await this.db.insert(subscriptions).values(subscription).returning());
  }

  async findById(id: string): Promise<Subscription | null> {
    return first(
      await this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1),
    );
  }

  async hasActiveForUserAndCreator(
    userId: UserId,
    creatorId: CreatorId,
    at: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ exists: sql<number>`1` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.creatorId, creatorId),
          eq(subscriptions.status, 'active'),
          gt(subscriptions.expiresAt, at),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async findActiveForUserAndCreator(
    userId: UserId,
    creatorId: CreatorId,
  ): Promise<Subscription | null> {
    return first(
      await this.db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.creatorId, creatorId),
            eq(subscriptions.status, 'active'),
          ),
        )
        .limit(1),
    );
  }

  async renew(id: SubscriptionId, newExpiresAt: Date): Promise<Subscription> {
    return one(
      await this.db
        .update(subscriptions)
        .set({ expiresAt: newExpiresAt, updatedAt: sql`now()` })
        .where(and(eq(subscriptions.id, id), eq(subscriptions.status, 'active')))
        .returning(),
    );
  }

  async listLapsed(at: Date, limit: number): Promise<Subscription[]> {
    return this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.status, 'active'), lte(subscriptions.expiresAt, at)))
      .orderBy(asc(subscriptions.expiresAt))
      .limit(limit);
  }

  async markExpired(id: SubscriptionId): Promise<boolean> {
    // status guard makes the sweep idempotent under overlap: second flip is a no-op
    const updated = await this.db
      .update(subscriptions)
      .set({ status: 'expired', updatedAt: sql`now()` })
      .where(and(eq(subscriptions.id, id), eq(subscriptions.status, 'active')))
      .returning({ id: subscriptions.id });
    return updated.length > 0;
  }

  async countActiveByCreator(creatorId: CreatorId, at: Date): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.creatorId, creatorId),
          eq(subscriptions.status, 'active'),
          gt(subscriptions.expiresAt, at),
        ),
      );
    return rows[0]?.n ?? 0;
  }
}

export class DrizzlePaymentRepository implements PaymentRepository {
  constructor(private readonly db: DbSession) {}

  async create(payment: NewPayment): Promise<Payment> {
    return one(await this.db.insert(payments).values(payment).returning());
  }

  async findById(id: PaymentId): Promise<Payment | null> {
    return first(await this.db.select().from(payments).where(eq(payments.id, id)).limit(1));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    return first(
      await this.db
        .select()
        .from(payments)
        .where(eq(payments.idempotencyKey, idempotencyKey))
        .limit(1),
    );
  }

  async markSucceeded(
    id: PaymentId,
    providerChargeId: string,
    rawPayload: unknown,
  ): Promise<Payment> {
    return one(
      await this.db
        .update(payments)
        .set({ status: 'succeeded', providerChargeId, rawPayload, updatedAt: sql`now()` })
        .where(eq(payments.id, id))
        .returning(),
    );
  }

  async markFailed(id: PaymentId, rawPayload: unknown): Promise<Payment> {
    return one(
      await this.db
        .update(payments)
        .set({ status: 'failed', rawPayload, updatedAt: sql`now()` })
        .where(eq(payments.id, id))
        .returning(),
    );
  }

  async listStalePending(olderThan: Date, limit: number): Promise<Payment[]> {
    return this.db
      .select()
      .from(payments)
      .where(and(eq(payments.status, 'pending'), lt(payments.createdAt, olderThan)))
      .orderBy(asc(payments.createdAt))
      .limit(limit);
  }

  async markFailedIfPending(id: PaymentId, rawPayload: unknown): Promise<Payment | null> {
    // status guard makes the sweep idempotent under overlap: a second flip is a no-op
    return first(
      await this.db
        .update(payments)
        .set({ status: 'failed', rawPayload, updatedAt: sql`now()` })
        .where(and(eq(payments.id, id), eq(payments.status, 'pending')))
        .returning(),
    );
  }
}

export class DrizzlePurchaseRepository implements PurchaseRepository {
  constructor(private readonly db: DbSession) {}

  async create(purchase: NewPurchase): Promise<Purchase> {
    return one(await this.db.insert(purchases).values(purchase).returning());
  }

  async findById(id: PurchaseId): Promise<Purchase | null> {
    return first(await this.db.select().from(purchases).where(eq(purchases.id, id)).limit(1));
  }

  async findByPaymentId(paymentId: PaymentId): Promise<Purchase | null> {
    return first(
      await this.db.select().from(purchases).where(eq(purchases.paymentId, paymentId)).limit(1),
    );
  }

  async listByUser(userId: UserId): Promise<Purchase[]> {
    return this.db
      .select()
      .from(purchases)
      .where(eq(purchases.userId, userId))
      .orderBy(desc(purchases.createdAt));
  }

  async markCompleted(id: PurchaseId): Promise<Purchase> {
    return one(
      await this.db
        .update(purchases)
        .set({ status: 'completed', updatedAt: sql`now()` })
        .where(eq(purchases.id, id))
        .returning(),
    );
  }

  async markFailed(id: PurchaseId): Promise<Purchase> {
    return one(
      await this.db
        .update(purchases)
        .set({ status: 'failed', updatedAt: sql`now()` })
        .where(eq(purchases.id, id))
        .returning(),
    );
  }

  async aggregateByCreator(creatorId: CreatorId): Promise<CreatorSalesAggregate> {
    const rows = await this.db
      .select({
        completedSales: sql<number>`count(*)::int`,
        revenueStars: sql<number>`coalesce(sum(${purchases.amountStars}), 0)::int`,
      })
      .from(purchases)
      .where(and(eq(purchases.creatorId, creatorId), eq(purchases.status, 'completed')));
    return { completedSales: rows[0]?.completedSales ?? 0, revenueStars: rows[0]?.revenueStars ?? 0 };
  }
}

export class DrizzleAccessGrantRepository implements AccessGrantRepository {
  constructor(private readonly db: DbSession) {}

  async create(grant: NewAccessGrant): Promise<AccessGrant> {
    return one(await this.db.insert(accessGrants).values(grant).returning());
  }

  async findById(id: GrantId): Promise<AccessGrant | null> {
    return first(await this.db.select().from(accessGrants).where(eq(accessGrants.id, id)).limit(1));
  }

  async findLiveGrant(userId: UserId, dropId: DropId): Promise<AccessGrant | null> {
    return first(
      await this.db
        .select()
        .from(accessGrants)
        .where(
          and(
            eq(accessGrants.userId, userId),
            eq(accessGrants.dropId, dropId),
            isNull(accessGrants.revokedAt),
          ),
        )
        .limit(1),
    );
  }

  async revoke(id: GrantId, at: Date): Promise<void> {
    await this.db.update(accessGrants).set({ revokedAt: at }).where(eq(accessGrants.id, id));
  }
}

/** Append-only: INSERT and SELECT statements exist here — UPDATE/DELETE never do. */
export class DrizzleAuditRepository implements AuditRepository {
  constructor(private readonly db: DbSession) {}

  async append(entry: NewAuditEntry): Promise<AuditLogEntry> {
    return one(await this.db.insert(auditLogs).values(entry).returning());
  }

  async find(limit = 100): Promise<AuditLogEntry[]> {
    return this.db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
  }

  async findByEntity(entityType: string, entityId: string): Promise<AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)))
      .orderBy(desc(auditLogs.createdAt));
  }

  async findByCreator(creatorId: CreatorId, limit = 100): Promise<AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.creatorId, creatorId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }

  async findByCorrelation(correlationId: string): Promise<AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, correlationId))
      .orderBy(desc(auditLogs.createdAt));
  }

  async existsForActor(
    creatorId: CreatorId,
    action: string,
    entityType: string,
    entityId: string,
    actorUserId: UserId,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ exists: sql<number>`1` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.creatorId, creatorId),
          eq(auditLogs.action, action),
          eq(auditLogs.entityType, entityType),
          eq(auditLogs.entityId, entityId),
          eq(auditLogs.actorUserId, actorUserId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}

export class DrizzleSettingsRepository implements SettingsRepository {
  constructor(private readonly db: DbSession) {}

  async getSystem(key: string): Promise<SystemSetting | null> {
    return first(
      await this.db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1),
    );
  }

  async upsertSystem(setting: NewSystemSetting): Promise<SystemSetting> {
    const inserted = await this.db
      .insert(systemSettings)
      .values(setting)
      .onConflictDoNothing({ target: systemSettings.key })
      .returning();
    if (inserted.length > 0) return one(inserted);
    const existing = await this.getSystem(setting.key);
    if (existing === null) throw new Error(`system setting ${setting.key} vanished during upsert`);
    return existing;
  }

  async getBot(creatorId: CreatorId | null, key: string): Promise<BotSetting | null> {
    const creatorFilter =
      creatorId === null ? isNull(botSettings.creatorId) : eq(botSettings.creatorId, creatorId);
    return first(
      await this.db
        .select()
        .from(botSettings)
        .where(and(creatorFilter, eq(botSettings.key, key)))
        .limit(1),
    );
  }
}

export const buildRepositories = (db: DbSession): Repositories => ({
  users: new DrizzleUserRepository(db),
  creators: new DrizzleCreatorRepository(db),
  creatorIdentities: new DrizzleCreatorIdentityRepository(db),
  sessions: new DrizzleSessionRepository(db),
  follows: new DrizzleFollowRepository(db),
  drops: new DrizzleDropRepository(db),
  plans: new DrizzleSubscriptionPlanRepository(db),
  subscriptions: new DrizzleSubscriptionRepository(db),
  payments: new DrizzlePaymentRepository(db),
  purchases: new DrizzlePurchaseRepository(db),
  accessGrants: new DrizzleAccessGrantRepository(db),
  audit: new DrizzleAuditRepository(db),
  settings: new DrizzleSettingsRepository(db),
});
