/**
 * Audit-enrichment handlers (§9): append post-commit `event.*` rows for
 * PurchaseCompleted and ContentUnlocked. These ENRICH the ledger (DATABASE.md
 * §10) — the authoritative core rows (payment.succeeded, purchase.completed,
 * grant.created, …) were already written in the originating transaction and
 * never depend on these handlers running.
 */
import type { UnitOfWork } from '../../repositories/index.js';
import { AuditService } from '../../services/audit.service.js';
import type { EventHandler } from '../dispatcher.js';

export const purchaseCompletedEnrichment =
  (uow: UnitOfWork, audit: AuditService): EventHandler<'PurchaseCompleted'> =>
  async (event) => {
    await uow.run(async (repos) => {
      await audit.record(repos, {
        creatorId: event.creatorId,
        action: 'event.purchase_completed',
        entityType: 'purchase',
        entityId: event.purchaseId,
        actorType: 'system',
        context: {
          userId: event.userId,
          dropId: event.dropId,
          planId: event.planId,
          amountStars: event.amountStars,
          occurredAt: event.occurredAt.toISOString(),
        },
      });
    });
  };

export const contentUnlockedEnrichment =
  (uow: UnitOfWork, audit: AuditService): EventHandler<'ContentUnlocked'> =>
  async (event) => {
    await uow.run(async (repos) => {
      await audit.record(repos, {
        creatorId: event.creatorId,
        action: 'event.content_unlocked',
        entityType: 'drop',
        entityId: event.dropId,
        actorType: 'system',
        context: { userId: event.userId, occurredAt: event.occurredAt.toISOString() },
      });
    });
  };
