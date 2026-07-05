/**
 * OnboardingService (M7.2) — progress is derived from existing data (slug/plan/drop),
 * completion is an explicit, idempotent marker that requires a slug.
 */
import { describe, expect, it } from 'vitest';
import { OnboardingService } from '../../../../src/core/services/onboarding.service.js';
import { createWorld, givenCreator, givenPlan, givenPublishedDrop } from '../../../fakes/world.js';

const setup = () => {
  const world = createWorld();
  return { world, onboarding: new OnboardingService(world.uow, world.clock) };
};

describe('OnboardingService.getState', () => {
  it('advances the next step as profile → plan → content are satisfied', async () => {
    const { world, onboarding } = setup();
    const creator = await givenCreator(world); // no slug, no plan, no drop

    const fresh = await onboarding.getState(creator.id);
    if (!fresh.ok) throw new Error('expected ok');
    expect(fresh.value).toMatchObject({
      completed: false,
      steps: { profile: false, plan: false, content: false },
      nextStep: 'profile',
    });

    await world.store.repos.creators.update(creator.id, { slug: 'me' });
    expect((await state(onboarding, creator.id)).nextStep).toBe('plan');

    await givenPlan(world, creator);
    expect((await state(onboarding, creator.id)).nextStep).toBe('content');

    await givenPublishedDrop(world, creator, 'free');
    const all = await state(onboarding, creator.id);
    expect(all.steps).toEqual({ profile: true, plan: true, content: true });
    expect(all.nextStep).toBeNull();
    expect(all.completed).toBe(false); // steps done, but not explicitly finished
  });

  it('404s for an unknown creator', async () => {
    const { onboarding } = setup();
    const result = await onboarding.getState('00000000-0000-4000-8000-000000000000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});

describe('OnboardingService.complete', () => {
  it('requires a slug, then completes idempotently', async () => {
    const { world, onboarding } = setup();
    const creator = await givenCreator(world); // no slug

    const tooEarly = await onboarding.complete(creator.id);
    expect(tooEarly.ok).toBe(false);
    if (!tooEarly.ok) expect(tooEarly.error.code).toBe('validation');

    await world.store.repos.creators.update(creator.id, { slug: 'me' });
    const done = await onboarding.complete(creator.id);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.onboardingCompletedAt).not.toBeNull();

    // idempotent: re-completing returns the same timestamp, doesn't re-stamp
    const again = await onboarding.complete(creator.id);
    if (!again.ok) throw new Error('expected ok');
    expect(again.value.onboardingCompletedAt?.getTime()).toBe(
      done.value.onboardingCompletedAt?.getTime(),
    );
    expect((await state(onboarding, creator.id)).completed).toBe(true);
  });
});

const state = async (svc: OnboardingService, creatorId: string) => {
  const result = await svc.getState(creatorId);
  if (!result.ok) throw new Error('expected ok');
  return result.value;
};
