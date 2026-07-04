import { describe, expect, it } from 'vitest';
import { NotificationEngine } from '../../../../src/core/engines/notification.engine.js';
import { FakeNotifier } from '../../../fakes/fake-notifier.js';
import { createWorld, givenUser, type TestWorld } from '../../../fakes/world.js';

const setup = (world: TestWorld = createWorld()) => {
  const notifier = new FakeNotifier();
  const engine = new NotificationEngine(world.uow, notifier);
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
    engine.enqueue(intent(user.id));
    engine.enqueue(intent(user.id));

    const stats = await engine.drainPending();

    expect(stats).toEqual({ sent: 2, blocked: 0, failed: 0, skipped: 0 });
    expect(notifier.sent).toHaveLength(2);
    expect(engine.pendingCount).toBe(0);
  });

  it('a blocked outcome marks users.is_blocked and drops the intent', async () => {
    const { world, notifier, engine } = setup();
    const user = await givenUser(world);
    notifier.scriptOutcomes('blocked');
    engine.enqueue(intent(user.id));

    const stats = await engine.drainPending();

    expect(stats.blocked).toBe(1);
    expect(world.store.state.users[0]?.isBlocked).toBe(true);
    expect(engine.pendingCount).toBe(0);

    // subsequent intents for the blocked user are skipped, not sent
    engine.enqueue(intent(user.id));
    const second = await engine.drainPending();
    expect(second.skipped).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it('transient failures re-queue for the next drain', async () => {
    const { world, notifier, engine } = setup();
    const user = await givenUser(world);
    notifier.scriptOutcomes('failed');
    engine.enqueue(intent(user.id));

    const first = await engine.drainPending();
    expect(first.failed).toBe(1);
    expect(engine.pendingCount).toBe(1);

    const second = await engine.drainPending();
    expect(second.sent).toBe(1);
    expect(engine.pendingCount).toBe(0);
  });

  it('intents for unknown users are skipped silently', async () => {
    const { engine } = setup();
    engine.enqueue(intent('00000000-0000-4000-8000-00000000dead'));

    const stats = await engine.drainPending();

    expect(stats).toEqual({ sent: 0, blocked: 0, failed: 0, skipped: 1 });
  });
});
