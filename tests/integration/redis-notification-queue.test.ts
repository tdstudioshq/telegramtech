/**
 * RedisNotificationQueue against a real Redis (M7.4) — the shared queue that makes the
 * notification drain correct at numReplicas>1 (debt #14). Verifies FIFO, atomic drain
 * (no intent handed to two drains), and the limit path. Requires REDIS_TEST_URL.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisNotificationQueue } from '../../src/adapters/notifications/redis-notification-queue.js';
import type { NotificationIntent } from '../../src/core/ports/notification-queue.port.js';

const REDIS_URL = process.env['REDIS_TEST_URL'];
const intent = (userId: string): NotificationIntent => ({
  userId,
  notification: { kind: 'payment_failed', text: `t-${userId}` },
});

describe.skipIf(!REDIS_URL)('RedisNotificationQueue (real Redis)', () => {
  const redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: null });
  const queue = new RedisNotificationQueue(redis, 'test:notif:queue');

  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('enqueue then drain returns all intents in FIFO order, emptying the queue', async () => {
    await queue.enqueue(intent('a'));
    await queue.enqueue(intent('b'));
    expect(await queue.size()).toBe(2);

    const drained = await queue.drainPending();
    expect(drained.map((i) => i.userId)).toEqual(['a', 'b']); // FIFO
    expect(await queue.size()).toBe(0);
  });

  it('respects a drain limit and leaves the remainder queued (FIFO)', async () => {
    await queue.enqueue(intent('a'));
    await queue.enqueue(intent('b'));
    await queue.enqueue(intent('c'));

    const first = await queue.drainPending(2);
    expect(first.map((i) => i.userId)).toEqual(['a', 'b']);
    expect(await queue.size()).toBe(1);
    expect((await queue.drainPending()).map((i) => i.userId)).toEqual(['c']);
  });

  it('drain is atomic: concurrent drains split the intents, none duplicated or lost', async () => {
    for (let i = 0; i < 50; i++) await queue.enqueue(intent(String(i)));

    const [d1, d2] = await Promise.all([queue.drainPending(), queue.drainPending()]);
    const all = [...d1, ...d2].map((i) => i.userId).sort((a, b) => Number(a) - Number(b));
    const unique = new Set(all);

    expect(all).toHaveLength(50); // nothing lost
    expect(unique.size).toBe(50); // nothing duplicated
    expect(await queue.size()).toBe(0);
  });

  it('draining an empty queue returns []', async () => {
    expect(await queue.drainPending()).toEqual([]);
    expect(await queue.size()).toBe(0);
  });

  it('preserves the full intent payload through JSON round-trip', async () => {
    await queue.enqueue({
      userId: 'u1',
      notification: { kind: 'subscription_activated', text: 'welcome ünïçödé 🎉' },
    });
    const [got] = await queue.drainPending();
    expect(got).toEqual({
      userId: 'u1',
      notification: { kind: 'subscription_activated', text: 'welcome ünïçödé 🎉' },
    });
  });
});
