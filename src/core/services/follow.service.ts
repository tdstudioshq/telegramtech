/**
 * FollowService (M7.3) — a Telegram user follows/unfollows a creator (consumer
 * action in the bot). Follows are user→creator, idempotent, and not audited (not a
 * money/access mutation). Distinct from paid subscriptions.
 */
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Creator } from '../../shared/entities.js';
import type { CreatorId, UserId } from '../../shared/domain.js';
import type { UnitOfWork } from '../repositories/index.js';

export class FollowService {
  constructor(private readonly uow: UnitOfWork) {}

  async follow(userId: UserId, creatorId: CreatorId): Promise<Result<void, AppError>> {
    return this.uow.run(async (repos) => {
      const creator = await repos.creators.findById(creatorId);
      if (creator === null) return err(appError('not_found', 'Creator not found.', { creatorId }));
      await repos.follows.create({ userId, creatorId }); // idempotent
      return ok(undefined);
    });
  }

  async unfollow(userId: UserId, creatorId: CreatorId): Promise<void> {
    await this.uow.run(async (repos) => repos.follows.delete(userId, creatorId));
  }

  async isFollowing(userId: UserId, creatorId: CreatorId): Promise<boolean> {
    return this.uow.run(async (repos) => repos.follows.exists(userId, creatorId));
  }

  async listFollowedCreators(userId: UserId): Promise<Creator[]> {
    return this.uow.run(async (repos) => repos.follows.listCreatorsByUser(userId));
  }
}
