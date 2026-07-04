/**
 * In-memory repository fakes (testing strategy: hand-written fakes, no mocking
 * libraries). One MemoryStore holds all "tables"; snapshot/restore gives the
 * FakeUnitOfWork honest rollback semantics. The unique constraints that carry
 * business meaning (idempotency key, one-active-sub-per-plan, one-live-grant,
 * unique telegram id, 1:1 purchase↔payment) throw like the database would.
 */
import { randomUUID } from 'node:crypto';
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
} from '../../src/core/repositories/index.js';
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
} from '../../src/shared/entities.js';
import type {
  CreatorId,
  DropId,
  GrantId,
  PaymentId,
  PurchaseId,
  SubscriptionId,
  UserId,
} from '../../src/shared/domain.js';
import { FakeClock } from './fake-clock.js';

export interface StoreState {
  users: User[];
  creators: Creator[];
  drops: Drop[];
  dropAssets: DropAsset[];
  plans: SubscriptionPlan[];
  subscriptions: Subscription[];
  payments: Payment[];
  purchases: Purchase[];
  accessGrants: AccessGrant[];
  auditLogs: AuditLogEntry[];
  systemSettings: SystemSetting[];
  botSettings: BotSetting[];
}

const emptyState = (): StoreState => ({
  users: [],
  creators: [],
  drops: [],
  dropAssets: [],
  plans: [],
  subscriptions: [],
  payments: [],
  purchases: [],
  accessGrants: [],
  auditLogs: [],
  systemSettings: [],
  botSettings: [],
});

/**
 * Real queries return fresh rows, never live references into storage — mirror
 * that by deep-cloning every repository return value, so tests can't couple to
 * (or be confused by) in-place mutation of previously returned entities.
 */
const cloningRepo = <T extends object>(repo: T): T =>
  new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) =>
        structuredClone(await (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });

export class MemoryStore {
  state: StoreState = emptyState();
  readonly repos: Repositories;

  constructor(readonly clock: FakeClock = new FakeClock()) {
    this.repos = {
      users: cloningRepo(new MemoryUserRepository(this)),
      creators: cloningRepo(new MemoryCreatorRepository(this)),
      drops: cloningRepo(new MemoryDropRepository(this)),
      plans: cloningRepo(new MemorySubscriptionPlanRepository(this)),
      subscriptions: cloningRepo(new MemorySubscriptionRepository(this)),
      payments: cloningRepo(new MemoryPaymentRepository(this)),
      purchases: cloningRepo(new MemoryPurchaseRepository(this)),
      accessGrants: cloningRepo(new MemoryAccessGrantRepository(this)),
      audit: cloningRepo(new MemoryAuditRepository(this)),
      settings: cloningRepo(new MemorySettingsRepository(this)),
    };
  }

  snapshot(): StoreState {
    return structuredClone(this.state);
  }

  restore(snapshot: StoreState): void {
    this.state = snapshot;
  }
}

class MemoryUserRepository implements UserRepository {
  constructor(private readonly store: MemoryStore) {}

  async create(user: NewUser): Promise<User> {
    if (this.store.state.users.some((u) => u.telegramId === user.telegramId)) {
      throw new Error('unique constraint violated: users.telegram_id');
    }
    const now = this.store.clock.now();
    const row: User = {
      id: user.id ?? randomUUID(),
      telegramId: user.telegramId,
      username: user.username ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      languageCode: user.languageCode ?? null,
      isBlocked: false,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
    };
    this.store.state.users.push(row);
    return row;
  }

  async findById(id: UserId): Promise<User | null> {
    return this.store.state.users.find((u) => u.id === id) ?? null;
  }

  async findByTelegramId(telegramId: bigint): Promise<User | null> {
    return this.store.state.users.find((u) => u.telegramId === telegramId) ?? null;
  }

  async setBlocked(id: UserId, isBlocked: boolean): Promise<void> {
    const user = this.store.state.users.find((u) => u.id === id);
    if (user !== undefined) {
      user.isBlocked = isBlocked;
      user.updatedAt = this.store.clock.now();
    }
  }
}

class MemoryCreatorRepository implements CreatorRepository {
  constructor(private readonly store: MemoryStore) {}

  async create(creator: NewCreator): Promise<Creator> {
    const now = this.store.clock.now();
    const row: Creator = {
      id: creator.id ?? randomUUID(),
      userId: creator.userId,
      displayName: creator.displayName,
      bio: creator.bio ?? null,
      status: creator.status,
      createdAt: now,
      updatedAt: now,
    };
    this.store.state.creators.push(row);
    return row;
  }

  async findById(id: CreatorId): Promise<Creator | null> {
    return this.store.state.creators.find((c) => c.id === id) ?? null;
  }

  async findByUserId(userId: UserId): Promise<Creator | null> {
    return this.store.state.creators.find((c) => c.userId === userId) ?? null;
  }
}

class MemoryDropRepository implements DropRepository {
  constructor(private readonly store: MemoryStore) {}

  async create(drop: NewDrop): Promise<Drop> {
    const now = this.store.clock.now();
    const row: Drop = {
      id: drop.id ?? randomUUID(),
      creatorId: drop.creatorId,
      title: drop.title,
      description: drop.description ?? null,
      previewText: drop.previewText ?? null,
      accessType: drop.accessType,
      priceStars: drop.priceStars ?? null,
      status: drop.status,
      publishedAt: drop.publishedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.state.drops.push(row);
    return row;
  }

  async findById(id: DropId): Promise<Drop | null> {
    return this.store.state.drops.find((d) => d.id === id) ?? null;
  }

  async listPublishedByCreator(creatorId: CreatorId): Promise<Drop[]> {
    return this.store.state.drops
      .filter((d) => d.creatorId === creatorId && d.status === 'published')
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  }

  async publish(id: DropId, at: Date): Promise<Drop> {
    const drop = this.store.state.drops.find((d) => d.id === id);
    if (drop === undefined) throw new Error(`drop ${id} not found`);
    drop.status = 'published';
    drop.publishedAt = at;
    drop.updatedAt = this.store.clock.now();
    return drop;
  }

  async addAsset(asset: NewDropAsset): Promise<DropAsset> {
    const now = this.store.clock.now();
    const row: DropAsset = {
      id: asset.id ?? randomUUID(),
      dropId: asset.dropId,
      creatorId: asset.creatorId,
      position: asset.position,
      contentType: asset.contentType,
      storageBucket: asset.storageBucket ?? null,
      storagePath: asset.storagePath ?? null,
      mimeType: asset.mimeType ?? null,
      fileSizeBytes: asset.fileSizeBytes ?? null,
      textContent: asset.textContent ?? null,
      transportCache: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.state.dropAssets.push(row);
    return row;
  }

  async listAssets(dropId: DropId): Promise<DropAsset[]> {
    return this.store.state.dropAssets
      .filter((a) => a.dropId === dropId)
      .sort((a, b) => a.position - b.position);
  }
}

class MemorySubscriptionPlanRepository implements SubscriptionPlanRepository {
  constructor(private readonly store: MemoryStore) {}

  async create(plan: NewSubscriptionPlan): Promise<SubscriptionPlan> {
    const now = this.store.clock.now();
    const row: SubscriptionPlan = {
      id: plan.id ?? randomUUID(),
      creatorId: plan.creatorId,
      name: plan.name,
      description: plan.description ?? null,
      priceStars: plan.priceStars,
      durationDays: plan.durationDays,
      status: plan.status,
      createdAt: now,
      updatedAt: now,
    };
    this.store.state.plans.push(row);
    return row;
  }

  async findById(id: string): Promise<SubscriptionPlan | null> {
    return this.store.state.plans.find((p) => p.id === id) ?? null;
  }

  async findByCreatorAndName(creatorId: CreatorId, name: string): Promise<SubscriptionPlan | null> {
    return (
      this.store.state.plans.find((p) => p.creatorId === creatorId && p.name === name) ?? null
    );
  }
}

class MemorySubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly store: MemoryStore) {}

  async create(subscription: NewSubscription): Promise<Subscription> {
    if (
      subscription.status === 'active' &&
      this.store.state.subscriptions.some(
        (s) =>
          s.userId === subscription.userId &&
          s.planId === subscription.planId &&
          s.status === 'active',
      )
    ) {
      throw new Error('unique constraint violated: subscriptions_one_active_per_plan_uq');
    }
    const now = this.store.clock.now();
    const row: Subscription = {
      id: subscription.id ?? randomUUID(),
      userId: subscription.userId,
      planId: subscription.planId,
      creatorId: subscription.creatorId,
      status: subscription.status,
      startedAt: subscription.startedAt,
      expiresAt: subscription.expiresAt,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.state.subscriptions.push(row);
    return row;
  }

  async findById(id: string): Promise<Subscription | null> {
    return this.store.state.subscriptions.find((s) => s.id === id) ?? null;
  }

  async hasActiveForUserAndCreator(userId: UserId, creatorId: CreatorId, at: Date): Promise<boolean> {
    return this.store.state.subscriptions.some(
      (s) =>
        s.userId === userId &&
        s.creatorId === creatorId &&
        s.status === 'active' &&
        s.expiresAt.getTime() > at.getTime(),
    );
  }

  async findActiveForUserAndCreator(
    userId: UserId,
    creatorId: CreatorId,
  ): Promise<Subscription | null> {
    return (
      this.store.state.subscriptions.find(
        (s) => s.userId === userId && s.creatorId === creatorId && s.status === 'active',
      ) ?? null
    );
  }

  async renew(id: SubscriptionId, newExpiresAt: Date): Promise<Subscription> {
    const sub = this.store.state.subscriptions.find((s) => s.id === id && s.status === 'active');
    if (sub === undefined) throw new Error(`active subscription ${id} not found`);
    sub.expiresAt = newExpiresAt;
    sub.updatedAt = this.store.clock.now();
    return sub;
  }

  async listLapsed(at: Date, limit: number): Promise<Subscription[]> {
    return this.store.state.subscriptions
      .filter((s) => s.status === 'active' && s.expiresAt.getTime() <= at.getTime())
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
      .slice(0, limit);
  }

  async markExpired(id: SubscriptionId): Promise<boolean> {
    const sub = this.store.state.subscriptions.find((s) => s.id === id && s.status === 'active');
    if (sub === undefined) return false;
    sub.status = 'expired';
    sub.updatedAt = this.store.clock.now();
    return true;
  }
}

class MemoryPaymentRepository implements PaymentRepository {
  constructor(private readonly store: MemoryStore) {}

  async create(payment: NewPayment): Promise<Payment> {
    if (this.store.state.payments.some((p) => p.idempotencyKey === payment.idempotencyKey)) {
      throw new Error('unique constraint violated: payments.idempotency_key');
    }
    const now = this.store.clock.now();
    const row: Payment = {
      id: payment.id ?? randomUUID(),
      creatorId: payment.creatorId,
      provider: payment.provider,
      providerChargeId: payment.providerChargeId ?? null,
      idempotencyKey: payment.idempotencyKey,
      amountStars: payment.amountStars,
      currency: 'XTR',
      status: payment.status,
      rawPayload: payment.rawPayload ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.state.payments.push(row);
    return row;
  }

  async findById(id: PaymentId): Promise<Payment | null> {
    return this.store.state.payments.find((p) => p.id === id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    return this.store.state.payments.find((p) => p.idempotencyKey === idempotencyKey) ?? null;
  }

  async markSucceeded(id: PaymentId, providerChargeId: string, rawPayload: unknown): Promise<Payment> {
    const payment = this.store.state.payments.find((p) => p.id === id);
    if (payment === undefined) throw new Error(`payment ${id} not found`);
    payment.status = 'succeeded';
    payment.providerChargeId = providerChargeId;
    payment.rawPayload = rawPayload;
    payment.updatedAt = this.store.clock.now();
    return payment;
  }

  async markFailed(id: PaymentId, rawPayload: unknown): Promise<Payment> {
    const payment = this.store.state.payments.find((p) => p.id === id);
    if (payment === undefined) throw new Error(`payment ${id} not found`);
    payment.status = 'failed';
    payment.rawPayload = rawPayload;
    payment.updatedAt = this.store.clock.now();
    return payment;
  }
}

class MemoryPurchaseRepository implements PurchaseRepository {
  constructor(private readonly store: MemoryStore) {}

  async create(purchase: NewPurchase): Promise<Purchase> {
    if (this.store.state.purchases.some((p) => p.paymentId === purchase.paymentId)) {
      throw new Error('unique constraint violated: purchases.payment_id');
    }
    const now = this.store.clock.now();
    const row: Purchase = {
      id: purchase.id ?? randomUUID(),
      userId: purchase.userId,
      creatorId: purchase.creatorId,
      dropId: purchase.dropId ?? null,
      planId: purchase.planId ?? null,
      paymentId: purchase.paymentId,
      amountStars: purchase.amountStars,
      status: purchase.status,
      createdAt: now,
      updatedAt: now,
    };
    this.store.state.purchases.push(row);
    return row;
  }

  async findById(id: PurchaseId): Promise<Purchase | null> {
    return this.store.state.purchases.find((p) => p.id === id) ?? null;
  }

  async findByPaymentId(paymentId: PaymentId): Promise<Purchase | null> {
    return this.store.state.purchases.find((p) => p.paymentId === paymentId) ?? null;
  }

  async listByUser(userId: UserId): Promise<Purchase[]> {
    return this.store.state.purchases
      .filter((p) => p.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async markCompleted(id: PurchaseId): Promise<Purchase> {
    const purchase = this.store.state.purchases.find((p) => p.id === id);
    if (purchase === undefined) throw new Error(`purchase ${id} not found`);
    purchase.status = 'completed';
    purchase.updatedAt = this.store.clock.now();
    return purchase;
  }

  async markFailed(id: PurchaseId): Promise<Purchase> {
    const purchase = this.store.state.purchases.find((p) => p.id === id);
    if (purchase === undefined) throw new Error(`purchase ${id} not found`);
    purchase.status = 'failed';
    purchase.updatedAt = this.store.clock.now();
    return purchase;
  }
}

class MemoryAccessGrantRepository implements AccessGrantRepository {
  constructor(private readonly store: MemoryStore) {}

  async create(grant: NewAccessGrant): Promise<AccessGrant> {
    if (
      this.store.state.accessGrants.some(
        (g) => g.userId === grant.userId && g.dropId === grant.dropId && g.revokedAt === null,
      )
    ) {
      throw new Error('unique constraint violated: access_grants_one_live_uq');
    }
    const row: AccessGrant = {
      id: grant.id ?? randomUUID(),
      userId: grant.userId,
      dropId: grant.dropId,
      creatorId: grant.creatorId,
      grantType: grant.grantType,
      sourcePurchaseId: grant.sourcePurchaseId ?? null,
      revokedAt: null,
      createdAt: this.store.clock.now(),
    };
    this.store.state.accessGrants.push(row);
    return row;
  }

  async findById(id: GrantId): Promise<AccessGrant | null> {
    return this.store.state.accessGrants.find((g) => g.id === id) ?? null;
  }

  async findLiveGrant(userId: UserId, dropId: DropId): Promise<AccessGrant | null> {
    return (
      this.store.state.accessGrants.find(
        (g) => g.userId === userId && g.dropId === dropId && g.revokedAt === null,
      ) ?? null
    );
  }

  async revoke(id: GrantId, at: Date): Promise<void> {
    const grant = this.store.state.accessGrants.find((g) => g.id === id);
    if (grant !== undefined) grant.revokedAt = at;
  }
}

class MemoryAuditRepository implements AuditRepository {
  constructor(private readonly store: MemoryStore) {}

  async append(entry: NewAuditEntry): Promise<AuditLogEntry> {
    const row: AuditLogEntry = {
      id: randomUUID(),
      creatorId: entry.creatorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      actorType: entry.actorType,
      actorUserId: entry.actorUserId ?? null,
      correlationId: entry.correlationId ?? null,
      context: entry.context ?? null,
      createdAt: this.store.clock.now(),
    };
    this.store.state.auditLogs.push(row);
    return row;
  }

  async find(limit = 100): Promise<AuditLogEntry[]> {
    return [...this.store.state.auditLogs].reverse().slice(0, limit);
  }

  async findByEntity(entityType: string, entityId: string): Promise<AuditLogEntry[]> {
    return this.store.state.auditLogs
      .filter((e) => e.entityType === entityType && e.entityId === entityId)
      .reverse();
  }

  async findByCreator(creatorId: CreatorId, limit = 100): Promise<AuditLogEntry[]> {
    return this.store.state.auditLogs
      .filter((e) => e.creatorId === creatorId)
      .reverse()
      .slice(0, limit);
  }

  async findByCorrelation(correlationId: string): Promise<AuditLogEntry[]> {
    return this.store.state.auditLogs.filter((e) => e.correlationId === correlationId).reverse();
  }
}

class MemorySettingsRepository implements SettingsRepository {
  constructor(private readonly store: MemoryStore) {}

  async getSystem(key: string): Promise<SystemSetting | null> {
    return this.store.state.systemSettings.find((s) => s.key === key) ?? null;
  }

  async upsertSystem(setting: NewSystemSetting): Promise<SystemSetting> {
    const existing = await this.getSystem(setting.key);
    if (existing !== null) return existing;
    const row: SystemSetting = {
      id: randomUUID(),
      key: setting.key,
      category: setting.category,
      value: setting.value,
      description: setting.description ?? null,
      updatedBy: null,
      updatedAt: this.store.clock.now(),
    };
    this.store.state.systemSettings.push(row);
    return row;
  }

  async getBot(creatorId: CreatorId | null, key: string): Promise<BotSetting | null> {
    return (
      this.store.state.botSettings.find((s) => s.creatorId === creatorId && s.key === key) ?? null
    );
  }
}
