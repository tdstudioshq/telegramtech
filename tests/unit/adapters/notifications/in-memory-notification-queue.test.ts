import { describe, expect, it } from 'vitest';
import { InMemoryNotificationQueue } from '../../../../src/adapters/notifications/in-memory-notification-queue.js';
import type { NotificationIntent } from '../../../../src/core/ports/notification-queue.port.js';

const intent = (userId: string): NotificationIntent => ({
  userId,
  notification: { kind: 'payment_failed', text: 't' },
});

describe('InMemoryNotificationQueue', () => {
  it('enqueues then drains all intents, emptying the queue', async () => {
    const q = new InMemoryNotificationQueue();
    await q.enqueue(intent('a'));
    await q.enqueue(intent('b'));
    expect(await q.size()).toBe(2);

    const drained = await q.drainPending();
    expect(drained.map((i) => i.userId)).toEqual(['a', 'b']);
    expect(await q.size()).toBe(0);
  });

  it('drain is atomic — a second drain returns nothing', async () => {
    const q = new InMemoryNotificationQueue();
    await q.enqueue(intent('a'));
    expect(await q.drainPending()).toHaveLength(1);
    expect(await q.drainPending()).toHaveLength(0);
  });

  it('respects a drain limit and leaves the remainder queued (FIFO)', async () => {
    const q = new InMemoryNotificationQueue();
    await q.enqueue(intent('a'));
    await q.enqueue(intent('b'));
    await q.enqueue(intent('c'));

    const first = await q.drainPending(2);
    expect(first.map((i) => i.userId)).toEqual(['a', 'b']);
    expect(await q.size()).toBe(1);
    expect((await q.drainPending()).map((i) => i.userId)).toEqual(['c']);
  });
});
