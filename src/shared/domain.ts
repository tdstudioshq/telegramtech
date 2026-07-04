/**
 * Domain vocabulary shared across core and adapters.
 * Enum values mirror the approved schema in docs/DATABASE.md rev 2 exactly.
 */

// uuid PKs everywhere (DATABASE.md conventions)
export type UserId = string;
export type CreatorId = string;
export type DropId = string;
export type DropAssetId = string;
export type PlanId = string;
export type SubscriptionId = string;
export type PurchaseId = string;
export type PaymentId = string;
export type GrantId = string;

export const ACCESS_TYPES = ['free', 'premium', 'pay_per_unlock'] as const;
export type AccessType = (typeof ACCESS_TYPES)[number];

export const DROP_STATUSES = ['draft', 'published', 'archived'] as const;
export type DropStatus = (typeof DROP_STATUSES)[number];

export const CREATOR_STATUSES = ['active', 'suspended', 'pending'] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];

export const PLAN_STATUSES = ['active', 'retired'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'expired', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PURCHASE_STATUSES = ['pending', 'completed', 'failed', 'refunded'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_PROVIDERS = ['mock', 'telegram_stars'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const GRANT_TYPES = ['purchase', 'manual'] as const;
export type GrantType = (typeof GRANT_TYPES)[number];

export const CONTENT_TYPES = ['text', 'photo', 'video', 'document'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const AUDIT_ACTOR_TYPES = ['user', 'system', 'job'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Money is integer Stars, never floats (DATABASE.md conventions). */
export type Stars = number;

/** Telegram Stars currency code (payments.currency default). */
export const STARS_CURRENCY = 'XTR' as const;
