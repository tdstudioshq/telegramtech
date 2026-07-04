/**
 * AccessService — THE entitlement oracle (SYSTEM_ARCHITECTURE §8). Every access
 * decision in the system flows through canAccess:
 *   free           → published drop is enough
 *   premium        → LIVE check: active subscription with expires_at > now()
 *                    (never materialized as grants — ADR-011)
 *   pay_per_unlock → an unrevoked access_grants row
 * Methods take tx-bound Repositories so callers (PurchaseService) can consult the
 * oracle inside their own transaction.
 */
import type { Drop } from '../../shared/entities.js';
import type { DropId, UserId } from '../../shared/domain.js';
import type { Clock } from '../ports/clock.port.js';
import type { Repositories, UnitOfWork } from '../repositories/index.js';

export type AccessBasis = 'free' | 'subscription' | 'grant';

export type AccessDenialReason = 'drop_not_found' | 'requires_subscription' | 'requires_unlock';

export type AccessDecision =
  | { readonly allowed: true; readonly drop: Drop; readonly basis: AccessBasis }
  | { readonly allowed: false; readonly reason: AccessDenialReason; readonly drop: Drop | null };

export class AccessService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Standalone entitlement query for read paths (client adapters, /my_access).
   * Opens its own read transaction; `canAccess` remains the primitive that
   * tx-owning callers (PurchaseService) invoke inside their own transaction.
   */
  async resolveAccess(userId: UserId, dropId: DropId): Promise<AccessDecision> {
    return this.uow.run(async (repos) => this.canAccess(repos, userId, dropId));
  }

  async canAccess(repos: Repositories, userId: UserId, dropId: DropId): Promise<AccessDecision> {
    const drop = await repos.drops.findById(dropId);
    // drafts/archived are indistinguishable from missing — never leak their existence
    if (drop === null || drop.status !== 'published') {
      return { allowed: false, reason: 'drop_not_found', drop: null };
    }

    switch (drop.accessType) {
      case 'free':
        return { allowed: true, drop, basis: 'free' };
      case 'premium': {
        const active = await repos.subscriptions.hasActiveForUserAndCreator(
          userId,
          drop.creatorId,
          this.clock.now(),
        );
        return active
          ? { allowed: true, drop, basis: 'subscription' }
          : { allowed: false, reason: 'requires_subscription', drop };
      }
      case 'pay_per_unlock': {
        const grant = await repos.accessGrants.findLiveGrant(userId, dropId);
        return grant !== null
          ? { allowed: true, drop, basis: 'grant' }
          : { allowed: false, reason: 'requires_unlock', drop };
      }
    }
  }
}
