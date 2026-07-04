/**
 * UserService — platform-level user registration (users are not tenant-owned;
 * one Telegram user buys from many creators). The M4 auth middleware calls
 * ensureRegistered on every update.
 */
import type { User } from '../../shared/entities.js';
import type { UserId } from '../../shared/domain.js';
import type { Repositories, UnitOfWork } from '../repositories/index.js';
import { AuditService } from './audit.service.js';

export interface TelegramProfile {
  readonly telegramId: bigint;
  readonly username?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly languageCode?: string | null;
}

export class UserService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  /** Find-or-create keyed on telegram_id. Registration is audited exactly once. */
  async ensureRegistered(profile: TelegramProfile, correlationId?: string): Promise<User> {
    return this.uow.run(async (repos) => {
      const existing = await repos.users.findByTelegramId(profile.telegramId);
      if (existing !== null) return existing;

      const user = await repos.users.create({
        telegramId: profile.telegramId,
        username: profile.username ?? null,
        firstName: profile.firstName ?? null,
        lastName: profile.lastName ?? null,
        languageCode: profile.languageCode ?? null,
      });
      await this.audit.record(repos, {
        creatorId: null, // platform-level event
        action: 'user.registered',
        entityType: 'user',
        entityId: user.id,
        actorType: 'user',
        actorUserId: user.id,
        correlationId,
      });
      return user;
    });
  }

  async findById(id: UserId): Promise<User | null> {
    return this.uow.run(async (repos: Repositories) => repos.users.findById(id));
  }
}
