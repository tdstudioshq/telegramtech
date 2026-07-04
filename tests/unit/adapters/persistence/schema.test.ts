import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../../src/adapters/persistence/db/schema/index.js';
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
} from '../../../../src/shared/domain.js';

describe('schema enums mirror the shared domain vocabulary (no silent drift)', () => {
  it.each([
    ['access_type', schema.accessTypeEnum, ACCESS_TYPES],
    ['drop_status', schema.dropStatusEnum, DROP_STATUSES],
    ['creator_status', schema.creatorStatusEnum, CREATOR_STATUSES],
    ['plan_status', schema.planStatusEnum, PLAN_STATUSES],
    ['subscription_status', schema.subscriptionStatusEnum, SUBSCRIPTION_STATUSES],
    ['purchase_status', schema.purchaseStatusEnum, PURCHASE_STATUSES],
    ['payment_status', schema.paymentStatusEnum, PAYMENT_STATUSES],
    ['payment_provider', schema.paymentProviderEnum, PAYMENT_PROVIDERS],
    ['grant_type', schema.grantTypeEnum, GRANT_TYPES],
    ['content_type', schema.contentTypeEnum, CONTENT_TYPES],
    ['audit_actor_type', schema.auditActorTypeEnum, AUDIT_ACTOR_TYPES],
  ] as const)('%s', (pgName, pgEnum, domainValues) => {
    expect(pgEnum.enumName).toBe(pgName);
    expect(pgEnum.enumValues).toEqual([...domainValues]);
  });
});

describe('the 11 tables of DATABASE.md rev 2.2 exist under their documented names', () => {
  it.each([
    ['users', schema.users],
    ['creators', schema.creators],
    ['drops', schema.drops],
    ['drop_assets', schema.dropAssets],
    ['subscription_plans', schema.subscriptionPlans],
    ['subscriptions', schema.subscriptions],
    ['purchases', schema.purchases],
    ['payments', schema.payments],
    ['access_grants', schema.accessGrants],
    ['audit_logs', schema.auditLogs],
    ['bot_settings', schema.botSettings],
    ['system_settings', schema.systemSettings],
  ] as const)('%s', (name, table) => {
    expect(getTableName(table)).toBe(name);
  });
});

describe('rev 2.2 specifics', () => {
  it('audit_logs.action is varchar(100) and entity_type is varchar(50), not enums', () => {
    expect(schema.auditLogs.action.getSQLType()).toBe('varchar(100)');
    expect(schema.auditLogs.entityType.getSQLType()).toBe('varchar(50)');
  });

  it('system_settings has category varchar(50) and nullable updated_by', () => {
    expect(schema.systemSettings.category.getSQLType()).toBe('varchar(50)');
    expect(schema.systemSettings.category.notNull).toBe(true);
    expect(schema.systemSettings.updatedBy.notNull).toBe(false);
  });

  it('money columns are integers, never floats', () => {
    expect(schema.drops.priceStars.getSQLType()).toBe('integer');
    expect(schema.subscriptionPlans.priceStars.getSQLType()).toBe('integer');
    expect(schema.payments.amountStars.getSQLType()).toBe('integer');
    expect(schema.purchases.amountStars.getSQLType()).toBe('integer');
  });
});
