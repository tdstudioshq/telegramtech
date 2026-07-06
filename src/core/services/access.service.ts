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
import type { CreatorId, DropId, UserId } from '../../shared/domain.js';
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

  /**
   * Batched entitlement for a whole catalog (/my_access) — resolves every drop in a
   * SINGLE transaction: at most one subscription check per creator (memoized) and one
   * live-grants query for all pay-per-unlock drops, classified in memory from the drops
   * already in hand. Returns decisions aligned to `drops`, identical to calling
   * resolveAccess per drop, but without the N+1 transaction fan-out (M7.3.1).
   * Non-published drops (defensive) resolve to the same drop_not_found as canAccess.
   */
  async resolveAccessForDrops(userId: UserId, drops: Drop[]): Promise<AccessDecision[]> {
    if (drops.length === 0) return [];
    return this.uow.run(async (repos) => {
      const now = this.clock.now();

      const subscriptionCache = new Map<CreatorId, boolean>();
      const hasActiveSubscription = async (creatorId: CreatorId): Promise<boolean> => {
        const cached = subscriptionCache.get(creatorId);
        if (cached !== undefined) return cached;
        const active = await repos.subscriptions.hasActiveForUserAndCreator(userId, creatorId, now);
        subscriptionCache.set(creatorId, active);
        return active;
      };

      const unlockDropIds = drops
        .filter((d) => d.status === 'published' && d.accessType === 'pay_per_unlock')
        .map((d) => d.id);
      const liveGrants =
        unlockDropIds.length > 0
          ? await repos.accessGrants.findLiveGrantsForDrops(userId, unlockDropIds)
          : [];
      const unlockedDropIds = new Set(liveGrants.map((g) => g.dropId));

      const decisions: AccessDecision[] = [];
      for (const drop of drops) {
        if (drop.status !== 'published') {
          decisions.push({ allowed: false, reason: 'drop_not_found', drop: null });
          continue;
        }
        switch (drop.accessType) {
          case 'free':
            decisions.push({ allowed: true, drop, basis: 'free' });
            break;
          case 'premium':
            decisions.push(
              (await hasActiveSubscription(drop.creatorId))
                ? { allowed: true, drop, basis: 'subscription' }
                : { allowed: false, reason: 'requires_subscription', drop },
            );
            break;
          case 'pay_per_unlock':
            decisions.push(
              unlockedDropIds.has(drop.id)
                ? { allowed: true, drop, basis: 'grant' }
                : { allowed: false, reason: 'requires_unlock', drop },
            );
            break;
        }
      }
      return decisions;
    });
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
