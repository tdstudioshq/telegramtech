import { describe, expect, it } from 'vitest';
import { InMemoryNotificationQueue } from '../../../../src/adapters/notifications/in-memory-notification-queue.js';
import { NotificationEngine } from '../../../../src/core/engines/notification.engine.js';
import { analyticsStub } from '../../../../src/core/events/handlers/analytics.handler.js';
import {
  contentUnlockedEnrichment,
  purchaseCompletedEnrichment,
} from '../../../../src/core/events/handlers/audit-enrichment.handler.js';
import {
  paymentFailedNotification,
  subscriptionActivatedNotification,
  subscriptionExpiredNotification,
} from '../../../../src/core/events/handlers/notification.handler.js';
import type {
  ContentUnlocked,
  PaymentFailed,
  PurchaseCompleted,
  SubscriptionActivated,
  SubscriptionExpired,
} from '../../../../src/core/events/events.js';
import { FakeNotifier } from '../../../fakes/fake-notifier.js';
import { createWorld } from '../../../fakes/world.js';

const at = new Date('2026-01-01T00:00:00Z');
const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  creator: '00000000-0000-4000-8000-000000000002',
  drop: '00000000-0000-4000-8000-000000000003',
  plan: '00000000-0000-4000-8000-000000000004',
  purchase: '00000000-0000-4000-8000-000000000005',
  payment: '00000000-0000-4000-8000-000000000006',
  subscription: '00000000-0000-4000-8000-000000000007',
};

describe('notification handlers enqueue intents', () => {
  it('PaymentFailed → payment_failed intent for the payer', async () => {
    const world = createWorld();
    const engine = new NotificationEngine(
      world.uow,
      new FakeNotifier(),
      new InMemoryNotificationQueue(),
    );
    const event: PaymentFailed = {
      type: 'PaymentFailed',
      paymentId: ids.payment,
      purchaseId: ids.purchase,
      userId: ids.user,
      creatorId: ids.creator,
      amountStars: 50,
      reason: 'declined',
      occurredAt: at,
    };

    await paymentFailedNotification(engine)(event);

    expect(await engine.size()).toBe(1);
  });

  it('SubscriptionActivated → welcome; SubscriptionExpired → renew prompt', async () => {
    const world = createWorld();
    const engine = new NotificationEngine(
      world.uow,
      new FakeNotifier(),
      new InMemoryNotificationQueue(),
    );
    const activated: SubscriptionActivated = {
      type: 'SubscriptionActivated',
      subscriptionId: ids.subscription,
      userId: ids.user,
      creatorId: ids.creator,
      planId: ids.plan,
      expiresAt: at,
      occurredAt: at,
    };
    const expired: SubscriptionExpired = {
      type: 'SubscriptionExpired',
      subscriptionId: ids.subscription,
      userId: ids.user,
      creatorId: ids.creator,
      planId: ids.plan,
      occurredAt: at,
    };

    await subscriptionActivatedNotification(engine)(activated);
    await subscriptionExpiredNotification(engine)(expired);

    expect(await engine.size()).toBe(2);
  });
});

describe('audit-enrichment handlers', () => {
  it('appends event.* enrichment rows after commit', async () => {
    const world = createWorld();
    const purchaseEvent: PurchaseCompleted = {
      type: 'PurchaseCompleted',
      purchaseId: ids.purchase,
      userId: ids.user,
      creatorId: ids.creator,
      dropId: ids.drop,
      planId: null,
      amountStars: 50,
      occurredAt: at,
    };
    const unlockEvent: ContentUnlocked = {
      type: 'ContentUnlocked',
      userId: ids.user,
      creatorId: ids.creator,
      dropId: ids.drop,
      occurredAt: at,
    };

    await purchaseCompletedEnrichment(world.uow, world.audit)(purchaseEvent);
    await contentUnlockedEnrichment(world.uow, world.audit)(unlockEvent);

    const actions = world.store.state.auditLogs.map((e) => e.action);
    expect(actions).toEqual(['event.purchase_completed', 'event.content_unlocked']);
    expect(world.store.state.auditLogs.every((e) => e.actorType === 'system')).toBe(true);
  });
});

describe('analytics stub', () => {
  it('is a registered no-op that never throws', async () => {
    const event: PurchaseCompleted = {
      type: 'PurchaseCompleted',
      purchaseId: ids.purchase,
      userId: ids.user,
      creatorId: ids.creator,
      dropId: ids.drop,
      planId: null,
      amountStars: 1,
      occurredAt: at,
    };
    await expect(Promise.resolve(analyticsStub()(event))).resolves.toBeUndefined();
  });
});
