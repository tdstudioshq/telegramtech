/**
 * Test world — wires the fakes the way app.ts will wire the real adapters,
 * plus fixture helpers for the recurring creator/user/drop/plan setup.
 */
import { EventDispatcher } from '../../src/core/events/dispatcher.js';
import { AccessService } from '../../src/core/services/access.service.js';
import { AuditService } from '../../src/core/services/audit.service.js';
import type { AccessType, Stars } from '../../src/shared/domain.js';
import type { Creator, Drop, SubscriptionPlan, User } from '../../src/shared/entities.js';
import { FakeClock } from './fake-clock.js';
import { FakeUnitOfWork } from './fake-uow.js';
import { MemoryStore } from './memory-repositories.js';

export const silentLogger = { error: () => undefined };

export interface TestWorld {
  clock: FakeClock;
  store: MemoryStore;
  dispatcher: EventDispatcher;
  uow: FakeUnitOfWork;
  access: AccessService;
  audit: AuditService;
}

export const createWorld = (): TestWorld => {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const dispatcher = new EventDispatcher(silentLogger);
  const uow = new FakeUnitOfWork(store, dispatcher);
  return {
    clock,
    store,
    dispatcher,
    uow,
    access: new AccessService(clock),
    audit: new AuditService(),
  };
};

let telegramIdSeq = 1000n;

export const givenUser = async (world: TestWorld): Promise<User> =>
  world.store.repos.users.create({ telegramId: (telegramIdSeq += 1n) });

export const givenCreator = async (world: TestWorld): Promise<Creator> => {
  const owner = await givenUser(world);
  return world.store.repos.creators.create({
    userId: owner.id,
    displayName: 'Test Creator',
    status: 'active',
  });
};

export const givenPublishedDrop = async (
  world: TestWorld,
  creator: Creator,
  accessType: AccessType,
  priceStars: Stars | null = accessType === 'pay_per_unlock' ? 50 : null,
): Promise<Drop> => {
  const drop = await world.store.repos.drops.create({
    creatorId: creator.id,
    title: `${accessType} drop`,
    accessType,
    priceStars,
    status: 'published',
    publishedAt: world.clock.now(),
  });
  await world.store.repos.drops.addAsset({
    dropId: drop.id,
    creatorId: creator.id,
    position: 0,
    contentType: 'text',
    textContent: 'hello',
  });
  return drop;
};

export const givenPlan = async (
  world: TestWorld,
  creator: Creator,
  durationDays = 30,
  priceStars: Stars = 500,
): Promise<SubscriptionPlan> =>
  world.store.repos.plans.create({
    creatorId: creator.id,
    name: 'Premium',
    priceStars,
    durationDays,
    status: 'active',
  });
