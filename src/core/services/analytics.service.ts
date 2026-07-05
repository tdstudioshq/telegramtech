/**
 * AnalyticsService (M7.1) — read-only creator dashboard metrics derived from
 * existing data (purchases, subscriptions, drops, plans). No new bookkeeping; the
 * live rollup is fine at MVP scale (materialized daily metrics come later, M7.x).
 */
import type { CreatorId } from '../../shared/domain.js';
import type { Clock } from '../ports/clock.port.js';
import type { UnitOfWork } from '../repositories/index.js';

export interface CreatorSummary {
  readonly revenueStars: number;
  readonly completedSales: number;
  readonly activeSubscribers: number;
  readonly publishedDrops: number;
  readonly totalDrops: number;
  readonly activePlans: number;
}

export class AnalyticsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async creatorSummary(creatorId: CreatorId): Promise<CreatorSummary> {
    return this.uow.run(async (repos) => {
      const sales = await repos.purchases.aggregateByCreator(creatorId);
      const activeSubscribers = await repos.subscriptions.countActiveByCreator(
        creatorId,
        this.clock.now(),
      );
      const allDrops = await repos.drops.listByCreator(creatorId);
      const plans = await repos.plans.listByCreator(creatorId);
      return {
        revenueStars: sales.revenueStars,
        completedSales: sales.completedSales,
        activeSubscribers,
        publishedDrops: allDrops.filter((d) => d.status === 'published').length,
        totalDrops: allDrops.length,
        activePlans: plans.filter((p) => p.status === 'active').length,
      };
    });
  }
}
