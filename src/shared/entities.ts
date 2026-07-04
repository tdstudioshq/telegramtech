/**
 * Domain entity shapes — the types repositories return (SQL in, domain types out,
 * ADR-009). Mirrors DATABASE.md rev 2.2; nullability matches the schema exactly.
 */
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
} from './domain.js';

export interface User {
  id: UserId;
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  isBlocked: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
}

export interface Creator {
  id: CreatorId;
  userId: UserId;
  displayName: string;
  bio: string | null;
  status: CreatorStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Drop {
  id: DropId;
  creatorId: CreatorId;
  title: string;
  description: string | null;
  previewText: string | null;
  accessType: AccessType;
  priceStars: Stars | null;
  status: DropStatus;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropAsset {
  id: DropAssetId;
  dropId: DropId;
  creatorId: CreatorId;
  position: number;
  contentType: ContentType;
  storageBucket: string | null;
  storagePath: string | null;
  mimeType: string | null;
  fileSizeBytes: bigint | null;
  textContent: string | null;
  /** Rebuildable delivery cache, e.g. {"telegram:<botId>": "<file_id>"} — never authoritative. */
  transportCache: Record<string, string> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionPlan {
  id: PlanId;
  creatorId: CreatorId;
  name: string;
  description: string | null;
  priceStars: Stars;
  durationDays: number;
  status: PlanStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Subscription {
  id: SubscriptionId;
  userId: UserId;
  planId: PlanId;
  creatorId: CreatorId;
  status: SubscriptionStatus;
  startedAt: Date;
  expiresAt: Date;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Payment {
  id: PaymentId;
  creatorId: CreatorId;
  provider: PaymentProviderName;
  providerChargeId: string | null;
  idempotencyKey: string;
  amountStars: Stars;
  currency: string;
  status: PaymentStatus;
  rawPayload: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface Purchase {
  id: PurchaseId;
  userId: UserId;
  creatorId: CreatorId;
  dropId: DropId | null;
  planId: PlanId | null;
  paymentId: PaymentId;
  amountStars: Stars;
  status: PurchaseStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccessGrant {
  id: GrantId;
  userId: UserId;
  dropId: DropId;
  creatorId: CreatorId;
  grantType: GrantType;
  sourcePurchaseId: PurchaseId | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface AuditLogEntry {
  id: string;
  creatorId: CreatorId | null;
  action: string;
  entityType: string;
  entityId: string;
  actorType: AuditActorType;
  actorUserId: UserId | null;
  correlationId: string | null;
  context: unknown;
  createdAt: Date;
}

export interface SystemSetting {
  id: string;
  key: string;
  category: string;
  value: unknown;
  description: string | null;
  updatedBy: UserId | null;
  updatedAt: Date;
}

export interface BotSetting {
  id: string;
  creatorId: CreatorId | null;
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: Date;
}
