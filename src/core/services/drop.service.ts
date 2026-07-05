/**
 * DropService — catalog lifecycle. Validation mirrors the DB CHECKs exactly
 * (DATABASE.md §3/§4) so violations surface as friendly AppErrors instead of
 * constraint exceptions:
 *   pay_per_unlock ⇒ price_stars > 0 · other access types ⇒ price is NULL
 *   text assets ⇒ text_content, no storage · media assets ⇒ storage bucket+path
 */
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Drop, DropAsset } from '../../shared/entities.js';
import type { AccessType, CreatorId, DropId, Stars } from '../../shared/domain.js';
import type { Clock } from '../ports/clock.port.js';
import type { NewDropAsset, UnitOfWork } from '../repositories/index.js';
import { AuditService } from './audit.service.js';
import { CreatorService } from './creator.service.js';

export interface CreateDropInput {
  readonly creatorId: CreatorId;
  readonly title: string;
  readonly description?: string | null;
  readonly previewText?: string | null;
  readonly accessType: AccessType;
  readonly priceStars?: Stars | null;
}

export interface AddAssetInput {
  readonly creatorId: CreatorId;
  readonly dropId: DropId;
  readonly position: number;
  readonly contentType: DropAsset['contentType'];
  readonly storageBucket?: string | null;
  readonly storagePath?: string | null;
  readonly mimeType?: string | null;
  readonly fileSizeBytes?: bigint | null;
  readonly textContent?: string | null;
  readonly correlationId?: string;
}

export class DropService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Drops are born draft; publishing is a separate, deliberate step. */
  async createDrop(input: CreateDropInput): Promise<Result<Drop, AppError>> {
    const price = input.priceStars ?? null;
    if (input.accessType === 'pay_per_unlock') {
      if (price === null || !Number.isInteger(price) || price <= 0) {
        return err(
          appError('validation', 'Pay-per-unlock drops need a positive integer Stars price.', {
            priceStars: price,
          }),
        );
      }
    } else if (price !== null) {
      return err(
        appError('validation', 'Only pay-per-unlock drops carry a price.', {
          accessType: input.accessType,
          priceStars: price,
        }),
      );
    }

    return this.uow.run(async (repos) => {
      const creator = await CreatorService.requireActive(repos, input.creatorId);
      if (!creator.ok) return creator;
      const drop = await repos.drops.create({
        creatorId: input.creatorId,
        title: input.title,
        description: input.description ?? null,
        previewText: input.previewText ?? null,
        accessType: input.accessType,
        priceStars: price,
        status: 'draft',
      });
      return ok(drop);
    });
  }

  async addAsset(input: AddAssetInput): Promise<Result<DropAsset, AppError>> {
    const shapeError = validateAssetShape(input);
    if (shapeError !== null) return err(shapeError);

    return this.uow.run(async (repos) => {
      const drop = await repos.drops.findById(input.dropId);
      // tenant scope: a creator can only attach assets to their own drop
      if (drop === null || drop.creatorId !== input.creatorId) {
        return err(appError('not_found', 'Drop not found.', { dropId: input.dropId }));
      }
      const asset = await repos.drops.addAsset(toNewAsset(input));
      await this.audit.record(repos, {
        creatorId: drop.creatorId,
        action: 'content.uploaded',
        entityType: 'drop_asset',
        entityId: asset.id,
        actorType: 'system',
        correlationId: input.correlationId,
        context: { dropId: drop.id, contentType: asset.contentType, storagePath: asset.storagePath },
      });
      return ok(asset);
    });
  }

  /** draft → published. Requires at least one asset — an empty drop delivers nothing. */
  async publishDrop(creatorId: CreatorId, dropId: DropId): Promise<Result<Drop, AppError>> {
    return this.uow.run(async (repos) => {
      const drop = await repos.drops.findById(dropId);
      if (drop === null || drop.creatorId !== creatorId) {
        return err(appError('not_found', 'Drop not found.', { dropId }));
      }
      if (drop.status !== 'draft') {
        return err(appError('conflict', 'Only draft drops can be published.', { status: drop.status }));
      }
      const assets = await repos.drops.listAssets(dropId);
      if (assets.length === 0) {
        return err(appError('validation', 'Add content before publishing this drop.', { dropId }));
      }
      return ok(await repos.drops.publish(dropId, this.clock.now()));
    });
  }

  /** Storefront browse — published only, newest first (repo orders by published_at). */
  async listPublished(creatorId: CreatorId): Promise<Drop[]> {
    return this.uow.run(async (repos) => repos.drops.listPublishedByCreator(creatorId));
  }

  /** Dashboard content list (M7.1): every drop for a creator, any status, newest first. */
  async listByCreator(creatorId: CreatorId): Promise<Drop[]> {
    return this.uow.run(async (repos) => repos.drops.listByCreator(creatorId));
  }

  /** Dashboard (M7.1): a creator's own drop by id, ANY status — the ownership guard
   * an upload runs before storing bytes (prevents cross-tenant orphan writes). */
  async getOwnedDrop(creatorId: CreatorId, dropId: DropId): Promise<Result<Drop, AppError>> {
    return this.uow.run(async (repos) => {
      const drop = await repos.drops.findById(dropId);
      if (drop === null || drop.creatorId !== creatorId) {
        return err(appError('not_found', 'Drop not found.', { dropId }));
      }
      return ok(drop);
    });
  }

  /** Published drop + its assets, for pre-delivery views. Never exposes drafts. */
  async getPublishedDrop(
    dropId: DropId,
  ): Promise<Result<{ drop: Drop; assets: DropAsset[] }, AppError>> {
    return this.uow.run(async (repos) => {
      const drop = await repos.drops.findById(dropId);
      if (drop === null || drop.status !== 'published') {
        return err(appError('not_found', 'Drop not found.', { dropId }));
      }
      return ok({ drop, assets: await repos.drops.listAssets(dropId) });
    });
  }
}

const validateAssetShape = (input: AddAssetInput): AppError | null => {
  if (input.contentType === 'text') {
    if (input.textContent == null || input.textContent === '') {
      return appError('validation', 'Text assets need text content.');
    }
    if (input.storageBucket != null || input.storagePath != null) {
      return appError('validation', 'Text assets do not use storage.', {
        storagePath: input.storagePath,
      });
    }
  } else {
    if (input.storageBucket == null || input.storagePath == null) {
      return appError('validation', 'Media assets need a storage bucket and path.', {
        contentType: input.contentType,
      });
    }
  }
  return null;
};

const toNewAsset = (input: AddAssetInput): NewDropAsset => ({
  dropId: input.dropId,
  creatorId: input.creatorId,
  position: input.position,
  contentType: input.contentType,
  storageBucket: input.storageBucket ?? null,
  storagePath: input.storagePath ?? null,
  mimeType: input.mimeType ?? null,
  fileSizeBytes: input.fileSizeBytes ?? null,
  textContent: input.textContent ?? null,
});
