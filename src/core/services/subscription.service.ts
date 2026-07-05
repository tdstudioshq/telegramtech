/**
 * SubscriptionService — subscribe / renew / expireLapsed (SYSTEM_ARCHITECTURE §7).
 * Payment mechanics are delegated to PurchaseService's primitives (state
 * transitions exist only there); this service owns subscription rows only.
 *
 * Entitlement stays a LIVE check (ADR-011): activation/renewal never mints
 * grants, expiration is a single status flip + event. Renewal extends from the
 * later of now/current expiry so an active-but-lapsed row (sweep hasn't run yet)
 * never shortchanges the user.
 */
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Payment, Purchase, Subscription, SubscriptionPlan } from '../../shared/entities.js';
import type { CreatorId, PlanId, Stars, UserId } from '../../shared/domain.js';
import type { Clock } from '../ports/clock.port.js';
import type { UnitOfWork } from '../repositories/index.js';
import { AuditService } from './audit.service.js';
import { CreatorService } from './creator.service.js';
import { PurchaseService, type Replay } from './purchase.service.js';

export interface SubscribeInput {
  readonly userId: UserId;
  readonly planId: PlanId;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface CreatePlanInput {
  readonly creatorId: CreatorId;
  readonly name: string;
  readonly description?: string | null;
  readonly priceStars: Stars;
  readonly durationDays: number;
}

export interface SubscribeOutcome {
  readonly subscription: Subscription;
  readonly payment: Payment;
  readonly purchase: Purchase;
  /** true when an active subscription was extended instead of created (§7 renew self-loop). */
  readonly renewed: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (from: Date, days: number): Date => new Date(from.getTime() + days * DAY_MS);

export class SubscriptionService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly purchases: PurchaseService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async subscribe(input: SubscribeInput): Promise<Result<SubscribeOutcome, AppError>> {
    type Setup =
      | { kind: 'error'; error: AppError }
      | { kind: 'replay'; replay: Exclude<Replay, { kind: 'none' }>; plan: SubscriptionPlan }
      | { kind: 'fresh'; payment: Payment; purchase: Purchase; plan: SubscriptionPlan };

    const setup = await this.uow.run(async (repos): Promise<Setup> => {
      const plan = await repos.plans.findById(input.planId);
      if (plan === null || plan.status !== 'active') {
        return {
          kind: 'error',
          error: appError('not_found', 'Plan not available.', { planId: input.planId }),
        };
      }

      const replay = await this.purchases.resolveReplay(repos, input.idempotencyKey);
      if (replay.kind !== 'none') {
        if (replay.purchase.planId !== input.planId) {
          return {
            kind: 'error',
            error: appError('conflict', 'This payment reference was used for something else.', {
              idempotencyKey: input.idempotencyKey,
            }),
          };
        }
        return { kind: 'replay', replay, plan };
      }

      const creator = await CreatorService.requireActive(repos, plan.creatorId);
      if (!creator.ok) return { kind: 'error', error: creator.error };
      const user = await repos.users.findById(input.userId);
      if (user === null) {
        return {
          kind: 'error',
          error: appError('not_found', 'User not found.', { userId: input.userId }),
        };
      }
      const existing = await repos.subscriptions.findActiveForUserAndCreator(
        input.userId,
        plan.creatorId,
      );
      if (existing !== null && existing.planId !== input.planId) {
        return {
          kind: 'error',
          error: appError(
            'conflict',
            'You already have a different active plan with this creator.',
            {
              activePlanId: existing.planId,
            },
          ),
        };
      }

      const attempt = await this.purchases.beginAttempt(repos, {
        userId: input.userId,
        creatorId: plan.creatorId,
        planId: plan.id,
        amountStars: plan.priceStars,
        idempotencyKey: input.idempotencyKey,
      });
      return { kind: 'fresh', ...attempt, plan };
    });

    if (setup.kind === 'error') return err(setup.error);
    if (setup.kind === 'replay') return this.replayedOutcome(setup.replay, setup.plan);

    const confirmation = await this.purchases.runProvider({
      idempotencyKey: input.idempotencyKey,
      amountStars: setup.plan.priceStars,
      description: `Subscribe to "${setup.plan.name}"`,
      userId: input.userId,
      creatorId: setup.plan.creatorId,
    });

    if (confirmation.status === 'failed') {
      await this.uow.run(async (repos, events) => {
        await this.purchases.finalizeFailure(repos, events, {
          payment: setup.payment,
          purchase: setup.purchase,
          correlationId: input.correlationId,
          reason: confirmation.reason,
          rawPayload: confirmation.rawPayload ?? { reason: confirmation.reason },
        });
      });
      return err(
        appError(
          'payment_failed',
          'Payment failed — you have not been charged. Please try again.',
          {
            reason: confirmation.reason,
          },
        ),
      );
    }

    return this.uow.run(async (repos, events) => {
      const finalized = await this.purchases.finalizeSuccess(repos, events, {
        payment: setup.payment,
        purchase: setup.purchase,
        correlationId: input.correlationId,
        confirmation,
      });

      const now = this.clock.now();
      const existing = await repos.subscriptions.findActiveForUserAndCreator(
        input.userId,
        setup.plan.creatorId,
      );

      let subscription: Subscription;
      let renewed: boolean;
      if (existing !== null) {
        const base = existing.expiresAt > now ? existing.expiresAt : now;
        subscription = await repos.subscriptions.renew(
          existing.id,
          addDays(base, setup.plan.durationDays),
        );
        renewed = true;
        await this.audit.record(repos, {
          creatorId: subscription.creatorId,
          action: 'subscription.renewed',
          entityType: 'subscription',
          entityId: subscription.id,
          actorType: 'user',
          actorUserId: input.userId,
          correlationId: input.correlationId,
          context: { planId: setup.plan.id, expiresAt: subscription.expiresAt.toISOString() },
        });
      } else {
        subscription = await repos.subscriptions.create({
          userId: input.userId,
          planId: setup.plan.id,
          creatorId: setup.plan.creatorId,
          status: 'active',
          startedAt: now,
          expiresAt: addDays(now, setup.plan.durationDays),
        });
        renewed = false;
        await this.audit.record(repos, {
          creatorId: subscription.creatorId,
          action: 'subscription.activated',
          entityType: 'subscription',
          entityId: subscription.id,
          actorType: 'user',
          actorUserId: input.userId,
          correlationId: input.correlationId,
          context: { planId: setup.plan.id, expiresAt: subscription.expiresAt.toISOString() },
        });
      }

      events.raise({
        type: 'SubscriptionActivated',
        subscriptionId: subscription.id,
        userId: input.userId,
        creatorId: subscription.creatorId,
        planId: setup.plan.id,
        expiresAt: subscription.expiresAt,
        occurredAt: now,
      });
      return ok({ subscription, ...finalized, renewed });
    });
  }

  /** Client read path (M7.0): the current creator's active plans, so a channel can
   * offer "subscribe" without knowing the plan id/name up front. */
  async listActivePlans(creatorId: CreatorId): Promise<SubscriptionPlan[]> {
    return this.uow.run(async (repos) => repos.plans.listActiveByCreator(creatorId));
  }

  /** Dashboard (M7.1): all of a creator's plans, any status. */
  async listPlans(creatorId: CreatorId): Promise<SubscriptionPlan[]> {
    return this.uow.run(async (repos) => repos.plans.listByCreator(creatorId));
  }

  /** Dashboard (M7.1): create an active plan. Money is integer Stars (mirrors the DB CHECK). */
  async createPlan(input: CreatePlanInput): Promise<Result<SubscriptionPlan, AppError>> {
    const name = input.name.trim();
    if (name.length === 0) return err(appError('validation', 'Plan name is required.'));
    if (!Number.isInteger(input.priceStars) || input.priceStars <= 0) {
      return err(appError('validation', 'Price must be a positive whole number of Stars.', { priceStars: input.priceStars }));
    }
    if (!Number.isInteger(input.durationDays) || input.durationDays <= 0) {
      return err(appError('validation', 'Duration must be a positive number of days.', { durationDays: input.durationDays }));
    }
    return this.uow.run(async (repos) => {
      const creator = await CreatorService.requireActive(repos, input.creatorId);
      if (!creator.ok) return creator;
      const plan = await repos.plans.create({
        creatorId: input.creatorId,
        name,
        description: input.description ?? null,
        priceStars: input.priceStars,
        durationDays: input.durationDays,
        status: 'active',
      });
      await this.audit.record(repos, {
        creatorId: input.creatorId,
        action: 'plan.created',
        entityType: 'subscription_plan',
        entityId: plan.id,
        actorType: 'system',
        context: { priceStars: plan.priceStars, durationDays: plan.durationDays },
      });
      return ok(plan);
    });
  }

  /** Client read path: resolve an active plan without exposing repositories. */
  async getActivePlan(planId: PlanId): Promise<Result<SubscriptionPlan, AppError>> {
    return this.uow.run(async (repos) => {
      const plan = await repos.plans.findById(planId);
      return plan === null || plan.status !== 'active'
        ? err(appError('not_found', 'Plan not available.', { planId }))
        : ok(plan);
    });
  }

  /** Client read path used by access/library views. */
  async hasActiveSubscription(userId: UserId, creatorId: CreatorId): Promise<boolean> {
    return this.uow.run(async (repos) =>
      repos.subscriptions.hasActiveForUserAndCreator(userId, creatorId, this.clock.now()),
    );
  }

  /**
   * The expiration sweep (called by the M5 job): flip lapsed actives to expired,
   * audit as `job`, raise SubscriptionExpired per row. Idempotent — markExpired's
   * status guard makes overlapping sweeps a no-op. Returns rows expired.
   */
  async expireLapsed(batchSize = 100, correlationId?: string): Promise<number> {
    return this.uow.run(async (repos, events) => {
      const now = this.clock.now();
      const lapsed = await repos.subscriptions.listLapsed(now, batchSize);
      let expired = 0;
      for (const subscription of lapsed) {
        const flipped = await repos.subscriptions.markExpired(subscription.id);
        if (!flipped) continue;
        expired += 1;
        await this.audit.record(repos, {
          creatorId: subscription.creatorId,
          action: 'subscription.expired',
          entityType: 'subscription',
          entityId: subscription.id,
          actorType: 'job',
          correlationId,
          context: { expiresAt: subscription.expiresAt.toISOString() },
        });
        events.raise({
          type: 'SubscriptionExpired',
          subscriptionId: subscription.id,
          userId: subscription.userId,
          creatorId: subscription.creatorId,
          planId: subscription.planId,
          occurredAt: now,
        });
      }
      return expired;
    });
  }

  /** Same idempotency semantics as drops: replays return the original outcome. */
  private async replayedOutcome(
    replay: Exclude<Replay, { kind: 'none' }>,
    plan: SubscriptionPlan,
  ): Promise<Result<SubscribeOutcome, AppError>> {
    switch (replay.kind) {
      case 'completed': {
        const subscription = await this.uow.run(async (repos) =>
          repos.subscriptions.findActiveForUserAndCreator(replay.purchase.userId, plan.creatorId),
        );
        if (subscription === null) {
          return err(
            appError('conflict', 'Payment recorded but no active subscription found.', {
              purchaseId: replay.purchase.id,
            }),
          );
        }
        return ok({
          subscription,
          payment: replay.payment,
          purchase: replay.purchase,
          renewed: false,
        });
      }
      case 'failed':
        return err(
          appError(
            'payment_failed',
            'Payment failed — you have not been charged. Please try again.',
            {
              replayed: true,
            },
          ),
        );
      case 'in_flight':
        return err(
          appError('conflict', 'This payment is already being processed.', {
            paymentId: replay.payment.id,
          }),
        );
    }
  }
}
