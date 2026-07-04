/**
 * DeliveryEngine — access check → ContentProvider → ContentTransport (§8).
 * The locked view (denied path) is the ADAPTER's job; this engine never sends
 * content to an unentitled user, and never sends anything BUT the content.
 *
 * Transport I/O happens outside any DB transaction: a read-only tx gathers
 * user/drop/assets, delivery runs against the ports, then the audit row is
 * written in its own transaction. `protect` is always true — even free content
 * is protected from forwarding (§8 diagram).
 */
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { DropAsset, User } from '../../shared/entities.js';
import type { DropId, UserId } from '../../shared/domain.js';
import type { Clock } from '../ports/clock.port.js';
import type { ContentProvider } from '../ports/content-provider.port.js';
import type { ContentTransport, TransportContent } from '../ports/content-transport.port.js';
import type { UnitOfWork } from '../repositories/index.js';
import { AccessService, type AccessDenialReason } from '../services/access.service.js';
import { AuditService } from '../services/audit.service.js';

export interface DeliveryReceipt {
  readonly deliveredAssets: number;
}

const denialToError = (reason: AccessDenialReason, dropId: DropId): AppError => {
  switch (reason) {
    case 'drop_not_found':
      return appError('not_found', 'Drop not found.', { dropId });
    case 'requires_subscription':
      return appError('forbidden', 'This content is for subscribers.', { dropId, reason });
    case 'requires_unlock':
      return appError('forbidden', 'Unlock this content to view it.', { dropId, reason });
  }
};

export class DeliveryEngine {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessService,
    private readonly content: ContentProvider,
    private readonly transport: ContentTransport,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async deliver(
    userId: UserId,
    dropId: DropId,
    correlationId?: string,
  ): Promise<Result<DeliveryReceipt, AppError>> {
    // read-only tx: entitlement + payload gathering
    const prep = await this.uow.run(
      async (
        repos,
      ): Promise<Result<{ user: User; creatorId: string; assets: DropAsset[] }, AppError>> => {
        const user = await repos.users.findById(userId);
        if (user === null) return err(appError('not_found', 'User not found.', { userId }));
        const decision = await this.access.canAccess(repos, userId, dropId);
        if (!decision.allowed) return err(denialToError(decision.reason, dropId));
        const assets = await repos.drops.listAssets(dropId);
        if (assets.length === 0) {
          return err(appError('internal', 'This content is temporarily unavailable.', { dropId }));
        }
        return ok({ user, creatorId: decision.drop.creatorId, assets });
      },
    );
    if (!prep.ok) return prep;
    const { user, creatorId, assets } = prep.value;

    // port I/O — no transaction held open
    for (const asset of assets) {
      const content = await this.resolveContent(asset);
      if (!content.ok) return content;
      const sent = await this.transport.send(user, content.value, { protect: true });
      if (!sent.ok) return sent;
    }

    await this.uow.run(async (repos) => {
      await this.audit.record(repos, {
        creatorId,
        action: 'content.delivered',
        entityType: 'drop',
        entityId: dropId,
        actorType: 'user',
        actorUserId: userId,
        correlationId,
        context: { assetCount: assets.length },
      });
    });
    return ok({ deliveredAssets: assets.length });
  }

  private async resolveContent(asset: DropAsset): Promise<Result<TransportContent, AppError>> {
    if (asset.contentType === 'text') {
      if (asset.textContent === null) {
        return err(appError('internal', 'This content is temporarily unavailable.', { assetId: asset.id }));
      }
      return ok({ kind: 'text', text: asset.textContent });
    }
    if (asset.storageBucket === null || asset.storagePath === null) {
      return err(appError('internal', 'This content is temporarily unavailable.', { assetId: asset.id }));
    }
    const deliverable = await this.content.getDeliverable(asset.storageBucket, asset.storagePath);
    if (!deliverable.ok) return deliverable;
    return ok({ kind: 'media', asset, deliverable: deliverable.value });
  }
}
