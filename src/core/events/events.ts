/**
 * Typed domain events (ADR-010). Emitted by core services, dispatched strictly
 * after transaction commit. Events enrich — audit core rows are written
 * in-transaction by AuditService, never via events.
 */
import type {
  CreatorId,
  DropId,
  PaymentId,
  PlanId,
  PurchaseId,
  Stars,
  SubscriptionId,
  UserId,
} from '../../shared/domain.js';

interface BaseEvent {
  readonly occurredAt: Date;
}

export interface PurchaseCompleted extends BaseEvent {
  readonly type: 'PurchaseCompleted';
  readonly purchaseId: PurchaseId;
  readonly userId: UserId;
  readonly creatorId: CreatorId;
  /** XOR with planId — mirrors the purchases drop_id/plan_id CHECK. */
  readonly dropId: DropId | null;
  readonly planId: PlanId | null;
  readonly amountStars: Stars;
}

export interface PaymentFailed extends BaseEvent {
  readonly type: 'PaymentFailed';
  readonly paymentId: PaymentId;
  readonly purchaseId: PurchaseId;
  readonly userId: UserId;
  readonly creatorId: CreatorId;
  readonly amountStars: Stars;
  readonly reason: string;
}

export interface SubscriptionActivated extends BaseEvent {
  readonly type: 'SubscriptionActivated';
  readonly subscriptionId: SubscriptionId;
  readonly userId: UserId;
  readonly creatorId: CreatorId;
  readonly planId: PlanId;
  readonly expiresAt: Date;
}

export interface SubscriptionExpired extends BaseEvent {
  readonly type: 'SubscriptionExpired';
  readonly subscriptionId: SubscriptionId;
  readonly userId: UserId;
  readonly creatorId: CreatorId;
  readonly planId: PlanId;
}

export interface ContentUnlocked extends BaseEvent {
  readonly type: 'ContentUnlocked';
  readonly userId: UserId;
  readonly creatorId: CreatorId;
  readonly dropId: DropId;
}

export type DomainEvent =
  PurchaseCompleted | PaymentFailed | SubscriptionActivated | SubscriptionExpired | ContentUnlocked;

export type DomainEventType = DomainEvent['type'];

export type EventOfType<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;
