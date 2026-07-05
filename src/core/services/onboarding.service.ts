/**
 * OnboardingService (M7.2) — a guided state layer over the existing services. It
 * computes onboarding progress from data the creator already owns (no duplicated
 * logic): a set slug = profile done, ≥1 active plan = plan done, ≥1 drop = content
 * done. Completion is an explicit marker (creators.onboarding_completed_at) kept
 * separate from the account status so it never affects requireActive/money flows.
 *
 * Everything is scoped to the caller's creatorId (isolation); the actual profile /
 * plan / drop actions stay in CreatorService / SubscriptionService / DropService.
 */
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Creator } from '../../shared/entities.js';
import type { CreatorId } from '../../shared/domain.js';
import type { Clock } from '../ports/clock.port.js';
import type { UnitOfWork } from '../repositories/index.js';

export type OnboardingStep = 'profile' | 'plan' | 'content';

const STEP_ORDER: readonly OnboardingStep[] = ['profile', 'plan', 'content'];

export interface OnboardingState {
  readonly completed: boolean;
  readonly completedAt: string | null;
  /** Whether each guided step has been satisfied by existing data. */
  readonly steps: Record<OnboardingStep, boolean>;
  /** First unsatisfied step, or null once all are done. */
  readonly nextStep: OnboardingStep | null;
}

export class OnboardingService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async getState(creatorId: CreatorId): Promise<Result<OnboardingState, AppError>> {
    return this.uow.run(async (repos) => {
      const creator = await repos.creators.findById(creatorId);
      if (creator === null) return err(appError('not_found', 'Creator not found.', { creatorId }));
      const plans = await repos.plans.listActiveByCreator(creatorId);
      const drops = await repos.drops.listByCreator(creatorId);
      return ok(toState(creator, plans.length > 0, drops.length > 0));
    });
  }

  /**
   * Finish onboarding. Requires the profile step (a storefront needs a slug for
   * deep-links); plan/content stay optional. Idempotent — re-completing is a no-op
   * that returns the creator unchanged.
   */
  async complete(creatorId: CreatorId): Promise<Result<Creator, AppError>> {
    return this.uow.run(async (repos) => {
      const creator = await repos.creators.findById(creatorId);
      if (creator === null) return err(appError('not_found', 'Creator not found.', { creatorId }));
      if (creator.onboardingCompletedAt !== null) return ok(creator);
      if (creator.slug === null) {
        return err(
          appError('validation', 'Set your storefront handle before finishing onboarding.'),
        );
      }
      return ok(await repos.creators.markOnboarded(creatorId, this.clock.now()));
    });
  }
}

const toState = (creator: Creator, hasPlan: boolean, hasContent: boolean): OnboardingState => {
  const steps: Record<OnboardingStep, boolean> = {
    profile: creator.slug !== null,
    plan: hasPlan,
    content: hasContent,
  };
  return {
    completed: creator.onboardingCompletedAt !== null,
    completedAt: creator.onboardingCompletedAt?.toISOString() ?? null,
    steps,
    nextStep: STEP_ORDER.find((step) => !steps[step]) ?? null,
  };
};
