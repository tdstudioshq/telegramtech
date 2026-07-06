import { describe, expect, it } from 'vitest';
import { InMemoryNotificationQueue } from '../../../../src/adapters/notifications/in-memory-notification-queue.js';
import { NotificationEngine } from '../../../../src/core/engines/notification.engine.js';
import { FakeNotifier } from '../../../fakes/fake-notifier.js';
import { createWorld, givenUser, type TestWorld } from '../../../fakes/world.js';

const setup = (world: TestWorld = createWorld()) => {
  const notifier = new FakeNotifier();
  const engine = new NotificationEngine(world.uow, notifier, new InMemoryNotificationQueue());
  return { world, notifier, engine };
};

const intent = (userId: string) => ({
  userId,
  notification: { kind: 'payment_failed' as const, text: 'try again' },
});

describe('NotificationEngine', () => {
  it('drains queued intents through the notifier', async () => {
    const { world, notifier, engine } = setup();
    const user = await givenUser(world);
    await engine.enqueue(intent(user.id));
    await engine.enqueue(intent(user.id));

    const stats = await engine.drainPending();

    expect(stats).toEqual({ sent: 2, blocked: 0, failed: 0, skipped: 0 });
    expect(notifier.sent).toHaveLength(2);
    expect(await engine.size()).toBe(0);
  });

  it('a blocked outcome marks users.is_blocked and drops the intent', async () => {
    const { world, notifier, engine } = setup();
    const user = await givenUser(world);
    notifier.scriptOutcomes('blocked');
    await engine.enqueue(intent(user.id));

    const stats = await engine.drainPending();

    expect(stats.blocked).toBe(1);
    expect(world.store.state.users[0]?.isBlocked).toBe(true);
    expect(await engine.size()).toBe(0);

    // subsequent intents for the blocked user are skipped, not sent
    await engine.enqueue(intent(user.id));
    const second = await engine.drainPending();
    expect(second.skipped).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it('transient failures re-queue for the next drain', async () => {
    const { world, notifier, engine } = setup();
    const user = await givenUser(world);
    notifier.scriptOutcomes('failed');
    await engine.enqueue(intent(user.id));

    const first = await engine.drainPending();
    expect(first.failed).toBe(1);
    expect(await engine.size()).toBe(1);

    const second = await engine.drainPending();
    expect(second.sent).toBe(1);
    expect(await engine.size()).toBe(0);
  });

  it('intents for unknown users are skipped silently', async () => {
    const { engine } = setup();
    await engine.enqueue(intent('00000000-0000-4000-8000-00000000dead'));

    const stats = await engine.drainPending();

    expect(stats).toEqual({ sent: 0, blocked: 0, failed: 0, skipped: 1 });
  });
});
