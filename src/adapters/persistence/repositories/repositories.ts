/**
 * Drizzle repository implementations (ADR-009) — the ONLY layer that touches
 * Drizzle. SQL in, domain types out; tenant filters per ADR-012.
 */
import { and, asc, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type {
  AccessGrantRepository,
  AuditRepository,
  CreatorRepository,
  DropRepository,
  NewAccessGrant,
  NewAuditEntry,
  NewCreator,
  NewDrop,
  NewDropAsset,
  NewPayment,
  NewPurchase,
  NewSubscription,
  NewSubscriptionPlan,
  NewSystemSetting,
  NewUser,
  PaymentRepository,
  PurchaseRepository,
  Repositories,
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
  Drop,
  DropAsset,
  Payment,
  Purchase,
  Subscription,
  SubscriptionPlan,
  SystemSetting,
  User,
} from '../../../shared/entities.js';
import type {
  CreatorId,
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
  creators,
  dropAssets,
  drops,
  payments,
  purchases,
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
  drops: new DrizzleDropRepository(db),
  plans: new DrizzleSubscriptionPlanRepository(db),
  subscriptions: new DrizzleSubscriptionRepository(db),
  payments: new DrizzlePaymentRepository(db),
  purchases: new DrizzlePurchaseRepository(db),
  accessGrants: new DrizzleAccessGrantRepository(db),
  audit: new DrizzleAuditRepository(db),
  settings: new DrizzleSettingsRepository(db),
});
