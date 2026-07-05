/**
 * Repository interfaces — consumed by core services, implemented in
 * adapters/persistence (ADR-009). SQL in, domain types out. Repositories always
 * filter by creator_id where tenant-owned (ADR-012). Method sets are the minimum
 * required by M2 (constraints, seed, entitlement predicate); M3 services extend them.
 */
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
} from '../../shared/entities.js';
import type {
  AccessType,
  AuditActorType,
  ContentType,
  CreatorId,
  CreatorStatus,
  DropAssetId,
  DropId,
  DropStatus,
  GrantId,
  GrantType,
  PaymentId,
  PaymentProviderName,
  PaymentStatus,
  PlanId,
  PlanStatus,
  PurchaseId,
  PurchaseStatus,
  Stars,
  SubscriptionId,
  SubscriptionStatus,
  UserId,
} from '../../shared/domain.js';
import type { EventBuffer } from '../events/dispatcher.js';

// ---- creation inputs (ids optional so the seed can be deterministic) ----

export interface NewUser {
  id?: UserId;
  telegramId: bigint;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
}

export interface NewCreator {
  id?: CreatorId;
  userId?: UserId | null;
  displayName: string;
  slug?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  status: CreatorStatus;
}

/** Mutable profile fields a creator edits from the dashboard (M7.1). All optional. */
export interface CreatorProfilePatch {
  displayName?: string;
  slug?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
}

export interface NewCreatorIdentity {
  id?: string;
  creatorId: CreatorId;
  email: string;
  passwordHash: string;
}

export interface NewSession {
  id?: string;
  identityId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface NewDrop {
  id?: DropId;
  creatorId: CreatorId;
  title: string;
  description?: string | null;
  previewText?: string | null;
  accessType: AccessType;
  priceStars?: Stars | null;
  status: DropStatus;
  publishedAt?: Date | null;
}

export interface NewDropAsset {
  id?: DropAssetId;
  dropId: DropId;
  creatorId: CreatorId;
  position: number;
  contentType: ContentType;
  storageBucket?: string | null;
  storagePath?: string | null;
  mimeType?: string | null;
  fileSizeBytes?: bigint | null;
  textContent?: string | null;
}

export interface NewSubscriptionPlan {
  id?: PlanId;
  creatorId: CreatorId;
  name: string;
  description?: string | null;
  priceStars: Stars;
  durationDays: number;
  status: PlanStatus;
}

export interface NewSubscription {
  id?: string;
  userId: UserId;
  planId: PlanId;
  creatorId: CreatorId;
  status: SubscriptionStatus;
  startedAt: Date;
  expiresAt: Date;
}

export interface NewPayment {
  id?: PaymentId;
  creatorId: CreatorId;
  provider: PaymentProviderName;
  providerChargeId?: string | null;
  idempotencyKey: string;
  amountStars: Stars;
  status: PaymentStatus;
  rawPayload?: unknown;
}

export interface NewPurchase {
  id?: PurchaseId;
  userId: UserId;
  creatorId: CreatorId;
  dropId?: DropId | null;
  planId?: PlanId | null;
  paymentId: PaymentId;
  amountStars: Stars;
  status: PurchaseStatus;
}

export interface NewAccessGrant {
  id?: GrantId;
  userId: UserId;
  dropId: DropId;
  creatorId: CreatorId;
  grantType: GrantType;
  sourcePurchaseId?: PurchaseId | null;
}

export interface NewAuditEntry {
  creatorId?: CreatorId | null;
  action: string;
  entityType: string;
  entityId: string;
  actorType: AuditActorType;
  actorUserId?: UserId | null;
  correlationId?: string | null;
  context?: unknown;
}

export interface NewSystemSetting {
  key: string;
  category: string;
  value: unknown;
  description?: string | null;
}

// ---- repositories ----

export interface UserRepository {
  create(user: NewUser): Promise<User>;
  findById(id: UserId): Promise<User | null>;
  findByTelegramId(telegramId: bigint): Promise<User | null>;
  /** Notification path: a `blocked` outcome flips this instead of retrying forever. */
  setBlocked(id: UserId, isBlocked: boolean): Promise<void>;
}

export interface CreatorRepository {
  create(creator: NewCreator): Promise<Creator>;
  findById(id: CreatorId): Promise<Creator | null>;
  findByUserId(userId: UserId): Promise<Creator | null>;
  /** Shared-bot deep-link resolution (M7.0): map a storefront slug to its creator. */
  findBySlug(slug: string): Promise<Creator | null>;
  /** Dashboard profile edit (M7.1): patch only the provided fields, stamp updated_at. */
  update(id: CreatorId, patch: CreatorProfilePatch): Promise<Creator>;
  /** Onboarding completion marker (M7.2). */
  markOnboarded(id: CreatorId, at: Date): Promise<Creator>;
}

export interface CreatorIdentityRepository {
  create(identity: NewCreatorIdentity): Promise<CreatorIdentity>;
  findByEmail(email: string): Promise<CreatorIdentity | null>;
  findById(id: string): Promise<CreatorIdentity | null>;
}

export interface SessionRepository {
  create(session: NewSession): Promise<Session>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
}

export interface DropRepository {
  create(drop: NewDrop): Promise<Drop>;
  findById(id: DropId): Promise<Drop | null>;
  listPublishedByCreator(creatorId: CreatorId): Promise<Drop[]>;
  /** Dashboard content management (M7.1): every drop for a creator, any status, newest first. */
  listByCreator(creatorId: CreatorId): Promise<Drop[]>;
  /** draft → published, stamping published_at. Status transitions over deletion. */
  publish(id: DropId, at: Date): Promise<Drop>;
  addAsset(asset: NewDropAsset): Promise<DropAsset>;
  listAssets(dropId: DropId): Promise<DropAsset[]>;
  /**
   * Write back a per-transport delivery id (e.g. Telegram file_id) into
   * transport_cache under `key`. Rebuildable optimization, never authoritative
   * (ADR-006) — merges into any existing cache map.
   */
  cacheAssetTransport(
    creatorId: CreatorId,
    assetId: DropAssetId,
    key: string,
    transportId: string,
  ): Promise<void>;
}

export interface SubscriptionPlanRepository {
  create(plan: NewSubscriptionPlan): Promise<SubscriptionPlan>;
  findById(id: PlanId): Promise<SubscriptionPlan | null>;
  findByCreatorAndName(creatorId: CreatorId, name: string): Promise<SubscriptionPlan | null>;
  /** A creator's active plans, oldest first (M7.0: resolve the current creator's plan for /subscribe). */
  listActiveByCreator(creatorId: CreatorId): Promise<SubscriptionPlan[]>;
  /** All of a creator's plans, any status, oldest first (M7.1 dashboard plan management). */
  listByCreator(creatorId: CreatorId): Promise<SubscriptionPlan[]>;
}

export interface SubscriptionRepository {
  create(subscription: NewSubscription): Promise<Subscription>;
  findById(id: string): Promise<Subscription | null>;
  /** THE premium entitlement predicate (ADR-011): active subscription with expires_at > at. */
  hasActiveForUserAndCreator(userId: UserId, creatorId: CreatorId, at: Date): Promise<boolean>;
  /** The row behind the predicate — renewal needs the current expires_at to extend. */
  findActiveForUserAndCreator(userId: UserId, creatorId: CreatorId): Promise<Subscription | null>;
  /** Renewal: status stays active, expires_at extends (§7 self-loop). */
  renew(id: SubscriptionId, newExpiresAt: Date): Promise<Subscription>;
  /** Sweep input: active rows with expires_at <= at, oldest first, bounded batch. */
  listLapsed(at: Date, limit: number): Promise<Subscription[]>;
  /** Dashboard analytics (M7.1): count of a creator's live subscriptions (active, expires_at > at). */
  countActiveByCreator(creatorId: CreatorId, at: Date): Promise<number>;
  /** Expiration is a single status flip (ADR-011); returns false if the row was no longer active (idempotent sweep). */
  markExpired(id: SubscriptionId): Promise<boolean>;
}

export interface PaymentRepository {
  create(payment: NewPayment): Promise<Payment>;
  findById(id: PaymentId): Promise<Payment | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null>;
  /** pending → succeeded; records the provider charge id + raw payload snapshot. */
  markSucceeded(id: PaymentId, providerChargeId: string, rawPayload: unknown): Promise<Payment>;
  /** pending → failed; raw payload keeps the provider's failure detail. */
  markFailed(id: PaymentId, rawPayload: unknown): Promise<Payment>;
  /** Cleanup-sweep input (M5): pending rows created before `olderThan`, oldest first, bounded batch. */
  listStalePending(olderThan: Date, limit: number): Promise<Payment[]>;
  /**
   * Guarded pending → failed for the cleanup sweep: returns null if the row was no
   * longer pending, so overlapping sweeps flip (and raise PaymentFailed for) each
   * stale payment exactly once — correctness never depends on the job lock (§11).
   */
  markFailedIfPending(id: PaymentId, rawPayload: unknown): Promise<Payment | null>;
}

export interface PurchaseRepository {
  create(purchase: NewPurchase): Promise<Purchase>;
  findById(id: PurchaseId): Promise<Purchase | null>;
  /** 1:1 with payments — the idempotency re-entry path resolves payment → purchase. */
  findByPaymentId(paymentId: PaymentId): Promise<Purchase | null>;
  listByUser(userId: UserId): Promise<Purchase[]>;
  markCompleted(id: PurchaseId): Promise<Purchase>;
  markFailed(id: PurchaseId): Promise<Purchase>;
  /** Dashboard analytics (M7.1): completed-sale count + Stars revenue for a creator. */
  aggregateByCreator(creatorId: CreatorId): Promise<CreatorSalesAggregate>;
}

export interface CreatorSalesAggregate {
  readonly completedSales: number;
  readonly revenueStars: number;
}

export interface AccessGrantRepository {
  create(grant: NewAccessGrant): Promise<AccessGrant>;
  findById(id: GrantId): Promise<AccessGrant | null>;
  /** Live = revoked_at IS NULL (the access predicate). */
  findLiveGrant(userId: UserId, dropId: DropId): Promise<AccessGrant | null>;
  revoke(id: GrantId, at: Date): Promise<void>;
}

/**
 * Append-only by construction (DATABASE.md rev 2.2 §10): exposes append/find* ONLY.
 * update()/delete() must never exist on this interface — the audit log is immutable.
 */
export interface AuditRepository {
  append(entry: NewAuditEntry): Promise<AuditLogEntry>;
  find(limit?: number): Promise<AuditLogEntry[]>;
  findByEntity(entityType: string, entityId: string): Promise<AuditLogEntry[]>;
  findByCreator(creatorId: CreatorId, limit?: number): Promise<AuditLogEntry[]>;
  findByCorrelation(correlationId: string): Promise<AuditLogEntry[]>;
  /** First-delivery detection (ADR-019): has this actor already produced `action` on this entity? */
  existsForActor(
    creatorId: CreatorId,
    action: string,
    entityType: string,
    entityId: string,
    actorUserId: UserId,
  ): Promise<boolean>;
}

export interface SettingsRepository {
  getSystem(key: string): Promise<SystemSetting | null>;
  /** Insert if absent; never clobbers an existing value (idempotent seed semantics). */
  upsertSystem(setting: NewSystemSetting): Promise<SystemSetting>;
  getBot(creatorId: CreatorId | null, key: string): Promise<BotSetting | null>;
}

export interface Repositories {
  users: UserRepository;
  creators: CreatorRepository;
  creatorIdentities: CreatorIdentityRepository;
  sessions: SessionRepository;
  drops: DropRepository;
  plans: SubscriptionPlanRepository;
  subscriptions: SubscriptionRepository;
  payments: PaymentRepository;
  purchases: PurchaseRepository;
  accessGrants: AccessGrantRepository;
  audit: AuditRepository;
  settings: SettingsRepository;
}

/**
 * Unit of work (ADR-009): composes multi-repo transactions. Events raised into the
 * buffer during `fn` are dispatched strictly AFTER commit (ADR-010); if `fn` throws,
 * the transaction rolls back and the buffer is never drained.
 */
export interface UnitOfWork {
  run<T>(fn: (repos: Repositories, events: EventBuffer) => Promise<T>): Promise<T>;
}
