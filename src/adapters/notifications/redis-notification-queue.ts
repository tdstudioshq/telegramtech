/**
 * RedisNotificationQueue (M7.4) — the NotificationQueue port over a Redis list, so
 * notification intents live in SHARED storage instead of a per-replica array. This is
 * what actually makes the notification drain correct at numReplicas>1 (debt #14): every
 * replica enqueues into the one shared list, and whichever replica runs the drain flushes
 * ALL of them — no intent is stranded on another replica's process.
 *
 * enqueue = RPUSH (append to tail); drain reads from the head (LRANGE 0..) so the queue
 * is FIFO like the in-memory one. The drain is a single atomic Lua step (read + trim),
 * so an intent is handed to exactly one drainPending call even under concurrent drains.
 * Durability matches the accepted domain-event posture (ADR-010 / debt #6): an intent
 * popped by a replica that then crashes mid-send is lost — a durable outbox is a later
 * step; this closes the correctness gap (stranding), not the durability one.
 */
import type { Redis } from 'ioredis';
import type {
  NotificationIntent,
  NotificationQueue,
} from '../../core/ports/notification-queue.port.js';

// Atomically read up to N (N<=0 ⇒ all) intents from the head and remove exactly those,
// returning them. Single-threaded Redis ⇒ each intent is drained by exactly one caller.
const DRAIN = `
local n = tonumber(ARGV[1])
local stop = -1
if n > 0 then stop = n - 1 end
local items = redis.call('LRANGE', KEYS[1], 0, stop)
local count = #items
if count > 0 then
  if n > 0 then
    redis.call('LTRIM', KEYS[1], count, -1)
  else
    redis.call('DEL', KEYS[1])
  end
end
return items`;

export class RedisNotificationQueue implements NotificationQueue {
  constructor(
    private readonly redis: Redis,
    private readonly key = 'notifications:queue',
  ) {}

  async enqueue(intent: NotificationIntent): Promise<void> {
    await this.redis.rpush(this.key, JSON.stringify(intent));
  }

  async drainPending(limit?: number): Promise<NotificationIntent[]> {
    const raw = (await this.redis.eval(DRAIN, 1, this.key, limit ?? 0)) as string[];
    return raw.map((s) => JSON.parse(s) as NotificationIntent);
  }

  async size(): Promise<number> {
    return this.redis.llen(this.key);
  }
}
