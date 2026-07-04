/**
 * Postgres enums, mirrored 1:1 from the shared domain vocabulary so the DB and
 * core can never drift silently (a unit test asserts the mirror).
 * Note: audit_logs.action / entity_type are deliberately varchar, NOT enums
 * (DATABASE.md rev 2.2 §10) — extensible vocabulary, Zod-validated in the app layer.
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACCESS_TYPES,
  AUDIT_ACTOR_TYPES,
  CONTENT_TYPES,
  CREATOR_STATUSES,
  DROP_STATUSES,
  GRANT_TYPES,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  PLAN_STATUSES,
  PURCHASE_STATUSES,
  SUBSCRIPTION_STATUSES,
} from '../../../../shared/domain.js';

export const accessTypeEnum = pgEnum('access_type', [...ACCESS_TYPES]);
export const dropStatusEnum = pgEnum('drop_status', [...DROP_STATUSES]);
export const creatorStatusEnum = pgEnum('creator_status', [...CREATOR_STATUSES]);
export const planStatusEnum = pgEnum('plan_status', [...PLAN_STATUSES]);
export const subscriptionStatusEnum = pgEnum('subscription_status', [...SUBSCRIPTION_STATUSES]);
export const purchaseStatusEnum = pgEnum('purchase_status', [...PURCHASE_STATUSES]);
export const paymentStatusEnum = pgEnum('payment_status', [...PAYMENT_STATUSES]);
export const paymentProviderEnum = pgEnum('payment_provider', [...PAYMENT_PROVIDERS]);
export const grantTypeEnum = pgEnum('grant_type', [...GRANT_TYPES]);
export const contentTypeEnum = pgEnum('content_type', [...CONTENT_TYPES]);
export const auditActorTypeEnum = pgEnum('audit_actor_type', [...AUDIT_ACTOR_TYPES]);
