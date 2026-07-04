/**
 * CreatorService — tenant lifecycle, deliberately minimal in MVP (the single
 * creator is seeded). `requireActive` is the in-transaction guard money flows
 * use: a suspended tenant sells nothing.
 */
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Creator } from '../../shared/entities.js';
import type { CreatorId, UserId } from '../../shared/domain.js';
import type { Repositories, UnitOfWork } from '../repositories/index.js';

export class CreatorService {
  constructor(private readonly uow: UnitOfWork) {}

  async getById(id: CreatorId): Promise<Result<Creator, AppError>> {
    const creator = await this.uow.run(async (repos) => repos.creators.findById(id));
    return creator === null
      ? err(appError('not_found', 'Creator not found.', { creatorId: id }))
      : ok(creator);
  }

  async findByUserId(userId: UserId): Promise<Creator | null> {
    return this.uow.run(async (repos) => repos.creators.findByUserId(userId));
  }

  /** Tx-bound guard for money/access flows: the tenant must exist and be active. */
  static async requireActive(
    repos: Repositories,
    creatorId: CreatorId,
  ): Promise<Result<Creator, AppError>> {
    const creator = await repos.creators.findById(creatorId);
    if (creator === null) {
      return err(appError('not_found', 'Creator not found.', { creatorId }));
    }
    if (creator.status !== 'active') {
      return err(
        appError('forbidden', 'This creator is not currently available.', {
          creatorId,
          status: creator.status,
        }),
      );
    }
    return ok(creator);
  }
}
